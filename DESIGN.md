# FilterTube: design

Goal: YouTube without distractions, where the user decides what "distraction" means by writing rules in plain
English ("No Shorts", "hide celebrity gossip and reaction videos", "only coding or maths on weekdays before 6pm"),
and the site applies them to the feed, search results and "Up next".

## 1. Key decisions (and why)

| Question | Decision | Why |
|---|---|---|
| Extension on youtube.com, or own site? | **Own website** (user's choice) | Works anywhere, full control. Cost: YouTube's own recommendation algorithm is unavailable. |
| Can we keep YouTube's recommendations? | **No.** | The official Data API has no personalised home feed, no related videos (removed 2023), no watch history. Calling YouTube's internal API with user cookies breaks the ToS and is fragile. |
| Where does the feed come from then? | User-chosen **sources**: channel uploads, topic searches (last 45 days), trending by region. | Cheap on API quota (channels ~2 units, topics 100, trending 1 of 10,000/day). |
| How is it ranked? | Freshness (decays over ~10 days) + channel affinity (likes +1.5, watch +0.5, not interested -2) + source type + rule boosts/demotes - already watched. | Simple, explainable, learns from use. |
| Playback | Embedded `youtube-nocookie.com` player, `rel=0`, fullscreen allowed. | Plays on the site; end screens only suggest the same channel. |
| Search | Full YouTube search (`search.list`), results filtered by the rules, with "N hidden by your rules, see which". | User requirement. 100 quota units per page. |
| Hosting | GitHub Pages (static). No server. | Free; everything runs in the browser. |
| Keys | User pastes them into Settings; stored in that browser's localStorage only; nothing in the repo. | Public site must not expose keys. Recommend restricting the YouTube key to the YouTube API + the site's URL. |
| Turning English into filters | **Gemini** (structured JSON output), once per "Apply rules". | Rare, needs real language understanding. Claude was used first, then removed at the user's request. |
| Checking topics on each video ("is this politics?") | **On-device model by default**; Gemini optional; or off. | Runs for every video, so it should be free, private and fast. Plain code can't judge topics. |

History: v1 was a claude.ai Artifact (`artifact/filtertube.html`) whose videos were loaded by a Node script
(`tools/ingest.mjs`) run in a Claude session; it couldn't embed the player or call YouTube from the page, so it
was replaced by the website. Then Claude (Anthropic API) was used for both rules and topic checks; then topic
checks moved to Gemini with the YouTube key; then the Gemini key was separated (AI Studio keys are their own);
then Claude was removed; then the on-device model was added for topic checks.

## 2. Rules

### 2.1 Compiled form (produced by Gemini from the user's text)

```json
{
  "rules": [
    {"action": "block", "text": "Hide Shorts", "when": {"is_short": true}},
    {"action": "allow_only", "text": "Only coding or maths during work hours",
     "when": {"about": ["programming", "mathematics"]},
     "schedule": {"days": ["mon","tue","wed","thu","fri"], "from": "09:00", "to": "17:00"}},
    {"action": "demote", "text": "Rank gaming lower", "when": {"about": ["video games"]}}
  ],
  "topics": [{"name": "programming", "examples": ["rust tutorial: build a web server", "..."]}],
  "notes": "anything that couldn't be expressed"
}
```

- `when` fields, all of which must hold: `is_short`, `is_live`, `min_minutes`, `max_minutes`, `max_age_days`,
  `min_age_days`, `channels` (substring of channel name), `keywords` (substring of title/tags/description),
  `about` (topics; matches if any applies).
- Actions: `block` hides; `allow_only` means only matching videos may show (several combine with OR);
  `boost` / `demote` change ranking. Optional `schedule` limits a rule to days/times (local time).
- `topics` gives 6-8 example titles per `about` topic, for the on-device model. The output is validated and
  cleaned by `sanitizeCompiled` in `rules.js`. Starter rules ship precompiled, with hand-written examples, so
  the site works before any model is asked.

### 2.2 Evaluation (`evaluate` in `rules.js`)

- Not interested -> hide. Active `block` rule matches -> hide (reason shown). `allow_only` rules exist and none
  match -> hide. "Show anyway" overrides a rule hide.
- An `about` condition that hasn't been checked yet makes the result `pending`. The user chooses whether pending
  videos are **hidden until checked** (default) or **shown until checked**.
- Structural conditions short-circuit, so a Short or a 4-hour video is decided without any model.
- The Hidden page lists every hidden feed video with its reason.

## 3. Topic checks

| Mode | How | Pros | Cons |
|---|---|---|---|
| **On this device** (default) | all-MiniLM-L6-v2 (8-bit, 23 MB) in a Web Worker via transformers.js + ONNX runtime wasm (27 MB), all served from the site. Score = best cosine similarity between the video text (title, tags, start of description) and the topic name or its example phrases. Match if score >= threshold (strict 0.28, balanced 0.34, loose 0.42). | No key, nothing leaves the device, no cost; ~50 ms per batch of videos once loaded. | ~50 MB one-time download; good at subjects, weaker at tone ("clickbait"). |
| **Gemini** | Batches of 25 videos x up to 15 topics per request, JSON answer listing which topics apply. Newest stable Flash-Lite model picked from the model list (or set in Settings). Waits a minute on rate limits. | More accurate on nuance. | Needs a key; free-tier rate limits. |
| **Off** | Topic rules never match. | | |

Results are cached per video (`ft.scores` / `ft.labels`), so each video is checked once; applying new rules
resets on-device scores (cheap to redo). Search results and the open video are checked before the feed.

## 4. Front end

- Single page, hash routes: `#feed`, `#search=QUERY`, `#watch=VIDEO_ID`, `#rules`, `#sources`, `#hidden`,
  `#settings`. Vanilla JS rendering with template strings, escaped with `esc()`.
- Watch page: player + title/channel/description, Like / Not interested / Open on YouTube, and "Up next":
  videos seen this visit that pass the rules, ranked by same channel, shared words, category and feed score.
- Status strip: feed refresh state, topic-check progress (including model download %), YouTube quota used today.
- Responsive down to phone width; light and dark themes.

## 5. Deployment

- `npm run build:docs` writes the site into `docs/`, which Pages serves from the branch.
- Blocker: GitHub secret scanning flags strings in the bundled ONNX runtime as a "Mistral AI API Key" (false
  positive), so a push containing `docs/embed-worker.js` is rejected. Options: the repo owner marks it a false
  positive, or Pages switches to the GitHub Actions workflow (`.github/workflows/pages.yml`) and built files stop
  being committed (the workflow would also need to run `npm run fetch-model`).

## 6. Possible next steps

- Topic checks: parallel batches; check the visible part of the feed first; per-topic strictness; let the user
  correct a wrong call and use it as another example.
- Better "Up next" and source suggestions from likes/watch history (Gemini).
- Scheduled feed refresh / sync across devices (would need a backend, e.g. Cloudflare Worker, which could also
  keep keys server-side and restrict access to the owner).
