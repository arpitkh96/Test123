# FilterTube — design notes (think first, build later)

Goal: a YouTube experience where the user writes rules in plain English
("no Shorts", "hide anything about celebrity gossip", "only coding videos on weekdays")
and the app follows them, without losing good recommendations.

---

## 1. Can we keep YouTube's own recommendation algorithm?

**Not in a standalone clone.** The official YouTube Data API v3 does not give
third-party apps the personalised feed:

| What we'd want | Available through the official API? |
|---|---|
| Personalised home feed | No (the `activities` "home" feed was removed years ago) |
| "Up next" / related videos | No (`search.list?relatedToVideoId` was removed in 2023) |
| Watch history | No (removed in 2016) |
| Subscriptions, liked videos, playlists | Yes (with OAuth) |
| Channel uploads, trending, search | Yes (search is quota-expensive: 100 of 10,000 units/day) |

YouTube's internal API (InnerTube, the one youtube.com itself calls) *does* return
the personalised feed, but calling it from our own server with the user's cookies
breaks the Terms of Service, breaks without warning, and means holding the user's
Google session on our server. **Not recommended.**

**It is possible if we filter YouTube instead of copying it.** A browser extension
runs inside youtube.com while the user is signed in, so YouTube's real algorithm
still chooses the videos. We remove what the rules reject before it is shown.
YouTube's infinite scroll fills the gaps, so the feed stays full.

## 2. Two ways to build it

### Option A — Browser extension on top of youtube.com (recommended first)
- Keeps 100% of YouTube's recommendations, search, playback, comments and login.
- Filters at the **data layer**: we intercept the JSON YouTube loads
  (`ytInitialData` and `/youtubei/v1/browse|next|search` responses) and remove
  rejected items *before* they are drawn. This is sturdier than hiding page elements,
  and avoids content flashing on screen and then disappearing. Hiding page elements
  stays as a backup.
- Also covers places a clone never could: the end-screen suggestions, the "Up next"
  sidebar and the Shorts shelf.
- Downside: desktop browsers only (plus Firefox/Kiwi on Android); it depends on
  YouTube's page structure, which changes, so it needs upkeep.

### Option B — Standalone clone (own website/app, official API + embedded player)
Plays videos through the official IFrame embed, which the Terms allow. Because there
is no YouTube algorithm, **we generate the feed ourselves**:

1. **Candidates** (cheap API calls first):
   - Recent uploads from the user's subscriptions (`playlistItems` on each channel's
     uploads playlist costs 1 unit per call)
   - Channels behind liked videos and playlists
   - `videos.list?chart=mostPopular` per region and category
   - A few `search.list` queries built from the user's interest profile
     (expensive, so cache them and run them on a schedule)
   - "More like this": search using a watched video's topic and keywords
2. **Filter**: apply the rule engine (section 3) to remove anything rejected.
3. **Rank**: build an interest profile as an embedding of the titles and descriptions
   the user watched or liked inside our app (we log our own watch history). Score each
   candidate by
   `similarity to the profile + freshness + channel affinity − already seen`,
   then mix in about 10% exploration so the feed doesn't narrow too far.
4. **Learn**: "Not interested", likes and watch-time all update the profile.

- Upside: works on any device, full control, no DOM hacks, and no distraction can
  get through because nothing comes from YouTube's feed.
- Downside: the recommendations will be noticeably weaker than YouTube's at first.
  API quota limits how much we can fetch per user, so we need a server and caching.

### Recommendation
Build **Option A first**, since it answers "keep YouTube's algorithm" directly. Write the
rule engine as a separate package so Option B can reuse it later, if a clone that works
on every device is still wanted.

## 3. Natural-language rule engine (shared by both options)

Calling an LLM for every video on every page is too slow and too costly. So the rules
are **compiled once** and **evaluated cheaply**.

### 3.1 Compile: English → structured rules (one LLM call when a rule is saved)
```
"No shorts, and nothing about politics or celebrity drama.
 On weekdays before 6pm only show programming or math videos."
```
becomes
```json
[
  {"id":"r1","action":"block","when":{"is_short":true}},
  {"id":"r2","action":"block","when":{"topic_any":["politics","celebrity gossip/drama"]}},
  {"id":"r3","action":"allow_only",
   "schedule":{"days":["mon","tue","wed","thu","fri"],"before":"18:00"},
   "when":{"topic_any":["programming","mathematics"]}}
]
```
The user sees this structured version shown back in plain language ("I understood:
…") so they can confirm or correct it. Compiling is a good fit for structured
output or tool use with a capable model.

### 3.2 Predicates: cheap ones first, then the semantic ones
| Kind | Examples | How it is checked |
|---|---|---|
| Structural | `is_short`, `is_live`, `is_premiere`, `is_ad`/sponsored shelf, `duration < 5m` | From the item's data (Shorts: `reelItemRenderer`, `/shorts/` URL, a vertical video ≤ 3 min) |
| Metadata | channel in list, title keyword/regex, language, view count, upload age | Plain code |
| Semantic | topic, "clickbait", "rage bait", "kids content", sentiment | A small, fast LLM classifies **in batches** (20–50 items per call) using title + channel + description; fall back to embedding similarity against topic descriptions |

### 3.3 Evaluate fast
- Run the structural and metadata checks first; most items are decided without an LLM.
- Cache semantic labels by `videoId` (in storage that survives restarts; a shared
  server cache in Option B). A video is classified once, ever.
- Classify only the items close to being shown; prefetch the next page.
- **Uncertain items:** hold the item back until it is classified (strict, the
  default for "no distractions") or show it until it is classified (lenient).
  The user chooses per rule.

### 3.4 Rule semantics
- `block` > `allow_only` > `boost`/`demote` (ranking in Option B, reordering in A).
- Schedules and scopes (home / search / sidebar / end-screen).
- An explanation for every hidden item ("Hidden by rule r2: politics"), plus a
  "show anyway" escape hatch and a log, so the user can tune the rules.
- Options that aren't about individual videos: hide comments, hide the Shorts tab,
  disable autoplay, hide view counts.

## 4. Proposed implementation plan (Option A)
1. Chrome MV3 extension skeleton (TypeScript + Vite): content script, a page-world
   script that intercepts fetch/XHR and `ytInitialData`, a service worker, and an
   options page.
2. Structural filters: Shorts everywhere (shelves, tab, `/shorts/` redirect to `/watch`),
   plus live/premiere/duration/channel/keyword checks. **This works without any LLM.**
3. Rule compiler: options page textarea → LLM → validated JSON (schema check) → shown
   back in plain language for confirmation.
4. Semantic classifier: batched calls, a `videoId` cache, the strict/lenient setting,
   and explanations.
5. A "Hidden items" panel with the reason and "show anyway".
6. Later: Option B, reusing the `rules/` package.

### Open decisions
- Extension (keeps the algorithm) vs standalone clone (works everywhere)?
- LLM API key: the user's own key stored in the extension (simplest) vs a small
  backend proxy (keeps the key server-side, allows a shared cache)?
- Strict or lenient default for unclassified items?
