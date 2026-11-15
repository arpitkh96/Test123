# FilterTube: working notes for Claude

FilterTube is a static website that shows YouTube through rules the user writes in plain English
("No Shorts", "hide celebrity gossip", "only coding videos on weekdays"). Read `DESIGN.md` for the product
decisions and architecture; this file is the practical part: layout, commands, pitfalls, status.

- Live site: https://arpitkh96.github.io/Test123/ (GitHub Pages, built and deployed by GitHub Actions)
- Working branch: `claude/youtube-clone-filters-ujcasf` (also the repo's only/default branch)
- The user's GitHub repo: `arpitkh96/Test123`

## Repository layout

| Path | What it is |
|---|---|
| `web/` | The website source (vanilla JS, bundled with esbuild). **This is the product.** |
| `web/src/main.js` | App: state, hash routing, views (feed, search, watch, rules, sources, hidden, settings), feed refresh, topic-check queue |
| `web/src/rules.js` | Rule engine: compiled rules -> show / hide / pending per video; ranking; "Up next" similarity; starter rules with topic example phrases |
| `web/src/youtube.js` | YouTube Data API v3 client (browser, user's key) |
| `web/src/gemini.js` | Gemini API client: turns written rules into structured filters; optional topic checks |
| `web/src/local-model.js`, `web/src/embed-worker.js` | On-device topic checks: all-MiniLM-L6-v2 via transformers.js in a Web Worker |
| `web/test/e2e.cjs` | Headless-Chromium end-to-end test with stubbed YouTube/Gemini (real on-device model) |
| `web/build.mjs`, `web/fetch-model.mjs` | Build (app + worker + model + ONNX wasm into `dist/`); model download |
| `.github/workflows/pages.yml` | **The deploy.** On every push touching `web/`: `npm ci`, `npm run fetch-model` (cached), `npm run build`, publish `web/dist` to Pages. Requires Pages source = "GitHub Actions". |
| `artifact/filtertube.html`, `tools/ingest.mjs` | **Superseded** first version: a claude.ai Artifact (https://claude.ai/artifact/UMMYkAda8aEgTNvSvjZg5M) fed by a Node ingest script. Kept for reference only. |

## Commands (run in `web/`)

```bash
npm ci                 # install (esbuild, @huggingface/transformers pinned to 4.3.2)
npm run fetch-model    # download the on-device model into web/models/ (gitignored; needs huggingface.co)
npm run build          # -> web/dist/
npm run dev            # watch + serve dist/ on :8080
npm run test:e2e       # after build: 18 checks, exits non-zero on failure. Optional arg: screenshot dir
```

Always run `npm run build && npm run test:e2e` after changing `web/src`. Commit source only: **never commit
built output** (`dist/`, bundles, models). Pushing to the branch deploys via the Pages workflow.

## How it works (short)

- Everything runs in the browser. Keys live in the user's `localStorage` only (Settings page), never in the repo.
  - YouTube Data API key: feed, search, video details. Separate from the Gemini key (the user found they need two keys).
  - Gemini API key (AI Studio): turns written rules into filters ("Apply rules"); optional topic checks.
- Rules compile to `{rules:[{action: block|allow_only|boost|demote, text, when:{...}, schedule}], topics:{name:[example phrases]}, notes}`.
  `when` fields: `is_short, is_live, min/max_minutes, min/max_age_days, channels, keywords, about`.
  Only `about` (topics like "politics", "clickbait") needs a model; everything else is plain code.
- Topic checks (`settings.topicCheck`): `local` (default, on-device, scores in `ft.scores`, threshold by
  `settings.strictness`: strict 0.28 / balanced 0.34 / loose 0.42), `gemini` (booleans in `ft.labels`), or `off`.
- A video is `show`, `hide` (with reasons) or `pending` (strict mode: hidden until its topics are checked).
- localStorage keys: `ft.settings`, `ft.prefs` (rules text, compiled rules, mode, likes, watched, notInterested,
  override, channel affinity), `ft.sources`, `ft.pool` (feed videos, max 600), `ft.labels`, `ft.scores`, `ft.units`
  (YouTube quota used today, Pacific day).

## Pitfalls already hit (don't repeat)

- **transformers.js 4.3.2 local models:** `env.localModelPath` must be a *relative* path (`"./models/"`). With a full
  URL, its file-existence check skips local files, concludes there's no tokenizer, and fails later with
  `this.tokenizer is not a function`.
- transformers.js loads `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` (not the jsep/plain builds) in browsers
  without WebGPU; `build.mjs` copies only those. GitHub Pages can't send COOP/COEP headers, so `numThreads = 1`.
- Embedding similarity against bare topic names is useless (Rust tutorial vs "programming" = 0.02). Matching
  against 5-8 example phrases per topic works (correct topic ~0.45-0.85, others < 0.3). Gemini writes the
  examples when rules are applied; starter rules have hand-written ones in `rules.js`.
- **Don't commit built bundles.** A committed bundle of transformers.js (`docs/embed-worker.js`) was rejected by
  GitHub push protection as a "Mistral AI API Key": its list of model classes includes
  `"Mistral3ForConditionalGeneration"` (32 characters). It was a false positive, but the fix was structural:
  stop committing build output and let the Actions workflow build the site. **Never obfuscate or split strings
  to get past a secret scanner** (that was rightly blocked as undermining a security control).
- The YouTube embed needs `referrerpolicy="strict-origin-when-cross-origin"` on the iframe (and the page meta) or
  YouTube refuses to play. Use `youtube-nocookie.com/embed/ID?rel=0`.
- The watch view must not rebuild the iframe on every render (it would restart the video): `renderWatch` only
  rebuilds when the video id or gate state changes. `render()` also skips rebuilding a view while the user is
  typing in one of its inputs.
- The YouTube API has no personalised feed, no "related videos" (removed 2023) and no watch history, so the feed
  comes from user-chosen sources and "Up next" from videos already seen this visit. Search costs 100 of the
  10,000 free daily quota units per page; channel uploads ~2 units; trending 1.
- Shorts aren't flagged by the API: treated as Short if duration <= 60 s, or <= 180 s with `#shorts`.

## Cloud session environment

- Network allowlist (personal environment "Test123"): `i.ytimg.com`, `www.googleapis.com`, `huggingface.co`,
  `cas-bridge.xethub.hf.co`, `cdn-lfs.hf.co`, `cdn-lfs-us-1.hf.co`, `us.aws.cdn.hf.co` (+ package registries).
  `youtube.com`, `generativelanguage.googleapis.com`, jsDelivr are **not** reachable, and the session has no real
  API keys, so test with the stubs in `web/test/e2e.cjs`. Chromium + Playwright are preinstalled (`require("playwright")`).
- Hugging Face hosts were added only to download the model; the user was offered their removal.

## User preferences

- Wants to think/design first, then implement; short answers; it's their decision where trade-offs matter.
- Chose a **standalone website** (not a browser extension), hosted on GitHub Pages.
- Videos must play embedded on the site with fullscreen; full YouTube search, filtered by the rules.
- **No Claude/Anthropic in the product for now** (removed on request). Gemini for rules; on-device model for
  topic checks ("Claude/LLM for rules, local model for the data path").
- Concerned about key exposure on a public site: keys are only in the user's browser; recommend restricting the
  YouTube key to the YouTube API and the site's referrer.

## Status

- Done: website with YouTube feed/search/embedded player (fullscreen), rules engine, Gemini for applying rules
  (separate Gemini key), topic checks on-device (default) / Gemini / off, end-to-end test, Actions-based deploy.
- Built output (`docs/`, root `index.html` redirect) was removed from the repo when deployment moved to Actions.
  The user has to set Settings -> Pages -> Source to "GitHub Actions" once; until then the old branch deploy has
  nothing to serve. After switching, re-run the workflow ("Run workflow" in the Actions tab) if no run deployed.
- Ideas not done yet: run topic checks in parallel; check what's on screen first; Gemini suggestions for
  sources; smarter Up next; scheduled feed refresh.
