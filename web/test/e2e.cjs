// End-to-end test of the built site (web/dist) in headless Chromium.
// YouTube, Gemini, the YouTube player and thumbnails are answered by stubs, so no keys or network are needed;
// the on-device model really runs (it is served from dist/). Run: npm run build && npm run test:e2e
// Exits non-zero if a check fails. Pass a directory as the first argument to save screenshots there.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");

const dist = path.join(__dirname, "..", "dist");
const shots = process.argv[2];
const PORT = 8765, BASE = `http://localhost:${PORT}/`;
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".html": "text/html" };
const srv = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split("?")[0]);
  const f = path.join(dist, p === "/" ? "index.html" : p);
  if (!f.startsWith(dist) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  r.end(fs.readFileSync(f));
}).listen(PORT);

// Fake videos: [title, channel, seconds, description, categoryId]
const now = Date.now(), iso = (h) => new Date(now - h * 3600e3).toISOString();
const VIDS = {
  v1: ["Building an HTTP server in Rust", "Code Lab", 1520, "rust programming tutorial", 28],
  v2: ["lol wait for it #shorts", "Clips", 30, "#shorts", 23],
  v3: ["Celebrity breakup drama EXPOSED", "Gossip Daily", 600, "celebrity drama gossip", 24],
  v4: ["How black holes evaporate", "Science Hour", 900, "physics space", 27],
  v5: ["4 hour podcast marathon", "Talks", 4 * 3600, "podcast", 22],
};
const item = (id) => {
  const [t, c, d, desc, cat] = VIDS[id];
  return { id, snippet: { title: t, channelTitle: c, channelId: "ch-" + c, publishedAt: iso(5), description: desc, categoryId: String(cat), liveBroadcastContent: "none", thumbnails: { medium: { url: "https://i.ytimg.com/vi/x/mq.jpg" } } },
    contentDetails: { duration: `PT${Math.floor(d / 3600)}H${Math.floor((d % 3600) / 60)}M${d % 60}S` }, statistics: { viewCount: "12345" } };
};
const json = (r, body) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`); if (!ok) failures.push(name); };
const calls = { keys: new Set(), geminiTopic: 0, compile: 0, anthropic: 0 };

(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));

  await pg.route("https://www.googleapis.com/**", (r) => {
    const u = new URL(r.request().url()), ep = u.pathname.split("/").pop();
    calls.keys.add("youtube:" + u.searchParams.get("key"));
    if (ep === "channels") {
      // Every handle exists; its channel id is derived from the handle (22 chars after "UC").
      const h = u.searchParams.get("forHandle");
      const mk = (handle) => ({ id: "UC" + handle.replace(/\W/g, "").padEnd(22, "x").slice(0, 22), snippet: { title: handle.slice(1), description: "", thumbnails: {} } });
      calls.handleLookups = (calls.handleLookups || 0) + (h ? 1 : 0);
      return json(r, { items: h ? [mk(h)] : [] });
    }
    if (ep === "playlistItems") {
      const pl = u.searchParams.get("playlistId");
      const uploads = { harkirat1: ["v1"], Computerphile: ["v4"], tseries: ["v2"] };
      const key = Object.keys(uploads).find((k) => pl === "UU" + ("@" + k).replace(/\W/g, "").padEnd(22, "x").slice(0, 22));
      calls.uploadCalls = (calls.uploadCalls || 0) + 1;
      return json(r, { items: (uploads[key] || []).map((videoId) => ({ contentDetails: { videoId } })) });
    }
    if (ep === "search") return json(r, { items: ["v3", "v4", "v5"].map((id) => ({ id: { videoId: id } })), pageInfo: { totalResults: 3 } });
    if (ep === "videos") return json(r, { items: (u.searchParams.get("id") || "").split(",").filter((id) => VIDS[id]).map(item) });
    return json(r, {});
  });
  await pg.route("https://generativelanguage.googleapis.com/**", (r) => {
    const u = new URL(r.request().url());
    calls.keys.add("gemini:" + u.searchParams.get("key"));
    if (u.pathname.endsWith("/models")) return json(r, { models: [
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-flash-lite-preview", supportedGenerationMethods: ["generateContent"] },
    ] });
    calls.geminiModel = u.pathname.split("/").pop().split(":")[0];
    const prompt = JSON.parse(r.request().postData()).contents[0].parts[0].text;
    const reply = (obj) => json(r, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
    if (prompt.startsWith("You convert")) {
      calls.compile++;
      return reply({ notes: "", topics: [{ name: "science", examples: ["science explained", "physics and astronomy", "how the universe works", "space telescopes and planets", "black holes and stars"] }],
        rules: [{ action: "block", text: "Hide Shorts", when: { is_short: true } }, { action: "block", text: "Hide science videos", when: { about: ["science"] } }, { action: "block", text: "Hide anything from Talks", when: { channels: ["Talks"] } }] });
    }
    if (prompt.startsWith("Assign each YouTube channel")) {
      calls.categorize = (calls.categorize || 0) + 1;
      const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      return reply({ results: ids.map((id) => ({ id, category: /rust|boilerplate/i.test(id) ? "rust" : "other" })) });
    }
    calls.geminiTopic++;
    return reply({ results: [] });
  });
  await pg.route("https://api.anthropic.com/**", (r) => { calls.anthropic++; r.abort(); });
  await pg.route("https://www.youtube-nocookie.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<body style='background:#222'>PLAYER</body>" }));
  await pg.route("https://i.ytimg.com/**", (r) => r.fulfill({ status: 404 }));

  // First visit: setup card
  await pg.goto(BASE); await pg.waitForTimeout(400);
  check("setup card shown without keys", await pg.isVisible("text=Set up FilterTube"));

  // Save separate YouTube and Gemini keys (topic checks default to on-device)
  await pg.goto(BASE + "#settings"); await pg.waitForTimeout(200);
  await pg.fill("#ytKey", "AIzaYOUTUBE"); await pg.fill("#geminiKey", "AIzaGEMINI");
  await pg.click("#settingsForm button[type=submit]");
  await pg.waitForTimeout(1500);

  // Feed: starter rules; on-device model hides gossip-free Shorts by structure
  await pg.goto(BASE + "#feed");
  await pg.waitForFunction(() => !/Downloading|Checking|Fetching/.test(document.querySelector("#strip").textContent), null, { timeout: 90000 });
  await pg.waitForTimeout(300);
  const feed = await pg.$$eval(".card .title", (e) => e.map((x) => x.textContent));
  check("feed shows the Rust video", feed.includes("Building an HTTP server in Rust"), JSON.stringify(feed));
  check("feed hides the Short", !feed.includes("lol wait for it #shorts"));

  // YouTube search, filtered by rules (gossip by the on-device model, 4h video by length)
  await pg.fill("#q", "black holes"); await pg.press("#q", "Enter");
  await pg.waitForFunction(() => !/Checking/.test(document.querySelector("#strip").textContent) && document.querySelector(".card .title"), null, { timeout: 60000 });
  await pg.waitForTimeout(300);
  const results = await pg.$$eval(".card .title", (e) => e.map((x) => x.textContent));
  check("search shows black holes", results.includes("How black holes evaporate"), JSON.stringify(results));
  check("search hides gossip (on-device)", !results.includes("Celebrity breakup drama EXPOSED"));
  check("search hides 4h video", !results.includes("4 hour podcast marathon"));
  if (shots) await pg.screenshot({ path: path.join(shots, "search.png") });

  // Embedded player with fullscreen; stays alive across re-renders
  await pg.click(".card .thumb"); await pg.waitForTimeout(800);
  const ifr = await pg.$(".player iframe");
  check("player embedded", !!ifr && /youtube-nocookie\.com\/embed\/v4/.test(await ifr.getAttribute("src")));
  check("fullscreen allowed", !!ifr && (await ifr.getAttribute("allowfullscreen")) !== null && /fullscreen/.test(await ifr.getAttribute("allow")));
  await pg.click("#winfo [data-like]"); await pg.waitForTimeout(200);
  check("player survives a re-render", await ifr.evaluate((e) => e.isConnected));
  if (shots) await pg.screenshot({ path: path.join(shots, "watch.png") });

  // Categories: subscriptions are pre-sorted; chips open one category
  await pg.goto(BASE + "#feed"); await pg.waitForTimeout(300);
  const chips = await pg.$$eval(".chips .chipbtn", (e) => e.map((x) => x.textContent));
  check("category chips from subscriptions", chips.includes("Science & math") && chips.includes("Fitness & health") && !chips.includes("Rust"), JSON.stringify(chips));
  check("one handle lookup per subscription", calls.handleLookups >= 80, String(calls.handleLookups));
  await pg.goto(BASE + "#cat=science");
  await pg.waitForFunction(() => !/Finding matching/.test(document.querySelector("main").textContent), null, { timeout: 60000 });
  const sci = await pg.$$eval(".card .title", (e) => e.map((x) => x.textContent));
  check("Science shows Computerphile's video only", JSON.stringify(sci) === JSON.stringify(["How black holes evaporate"]), JSON.stringify(sci));

  // Add a suggested Rust channel; Rust chip appears and picks up the Rust video from another channel
  await pg.goto(BASE + "#sources"); await pg.waitForTimeout(300);
  check("subscriptions listed on Sources", /Following \((8\d)\)/.test(await pg.textContent("main")));
  await pg.check('input[name="sugg"][value="@jonhoo"]');
  await pg.click('#suggForm button[type="submit"]');
  await pg.waitForTimeout(1500);
  // Comma-separated channels: duplicates (already following @jonhoo) are skipped
  await pg.goto(BASE + "#sources"); await pg.waitForTimeout(300);
  const before = +(await pg.textContent("main")).match(/Following \((\d+)\)/)[1];
  await pg.fill("#srcValue", "@letsgetrusty, https://www.youtube.com/@NoBoilerplate, @jonhoo");
  await pg.click('#addForm button[type="submit"]');
  await pg.waitForTimeout(1500);
  const after = +(await pg.textContent("main")).match(/Following \((\d+)\)/)[1];
  check("comma-separated channels added, duplicates skipped", after === before + 2, `${before} -> ${after}`);
  await pg.goto(BASE + "#cat=rust");
  await pg.waitForFunction(() => !/Finding matching/.test(document.querySelector("main").textContent), null, { timeout: 60000 });
  await pg.waitForTimeout(300);
  const rust = await pg.$$eval(".card", (e) => e.map((x) => x.querySelector(".title").textContent + " | " + (x.querySelector(".why")?.textContent || "")));
  check("Rust category finds the Rust video via on-device match", rust.some((x) => x.startsWith("Building an HTTP server in Rust") && /Matches Rust/.test(x)), JSON.stringify(rust));
  if (shots) await pg.screenshot({ path: path.join(shots, "rust.png") });

  // Apply new rules with Gemini; on-device model uses Gemini's example phrases
  await pg.goto(BASE + "#rules"); await pg.waitForTimeout(300);
  await pg.fill("#rulesText", "No shorts. No science. Hide Talks."); await pg.click("[data-compile]");
  await pg.waitForTimeout(800);
  const rules = await pg.$$eval(".rule .txt", (e) => e.map((x) => x.textContent.trim()));
  check("Gemini compiled 3 rules", rules.length === 3, JSON.stringify(rules));
  await pg.goto(BASE + "#hidden");
  await pg.waitForFunction(() => !/Checking/.test(document.querySelector("#strip").textContent), null, { timeout: 60000 });
  await pg.waitForTimeout(300);
  const hidden = await pg.$$eval(".list strong", (e) => e.map((x) => x.textContent));
  check("science rule hides black holes (on-device)", hidden.includes("How black holes evaporate"), JSON.stringify(hidden));

  // Phone layout
  await pg.setViewportSize({ width: 390, height: 844 });
  await pg.goto(BASE + "#feed"); await pg.waitForTimeout(300);
  check("no horizontal scroll on phone", !(await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth)));

  // Keys and services
  check("YouTube key used only for YouTube", calls.keys.has("youtube:AIzaYOUTUBE") && !calls.keys.has("gemini:AIzaYOUTUBE"), [...calls.keys].join(", "));
  check("Gemini key used for Gemini", calls.keys.has("gemini:AIzaGEMINI"));
  check("Gemini picked newest stable Flash-Lite", calls.geminiModel === "gemini-3.1-flash-lite", calls.geminiModel);
  check("on-device mode sends no topic checks to Gemini", calls.geminiTopic === 0, String(calls.geminiTopic));
  check("new channels sorted by Gemini when a key is set", calls.categorize >= 1, String(calls.categorize));
  check("no requests to Anthropic", calls.anthropic === 0);
  check("no page errors", errors.length === 0, errors.join(" | "));

  await b.close(); srv.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll checks passed");
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); srv.close(); process.exit(1); });
