import { DEFAULT_TEXT, DEFAULT_COMPILED, sanitizeCompiled, ruleActive, evaluate, score, similarity, critKey } from "./rules.js";
import { createYouTube } from "./youtube.js";
import { createGemini } from "./gemini.js";
import { scoreVideos, STRICTNESS, setProgressHandler } from "./local-model.js";

/* ---------------- storage (this browser only) ---------------- */
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };

const EXAMPLE_SOURCES = [
  { id: "channel-veritasium", type: "channel", value: "@veritasium", label: "@veritasium", status: "pending", note: "Example source: remove it if you don’t want it." },
  { id: "channel-fireship", type: "channel", value: "@Fireship", label: "@Fireship", status: "pending", note: "Example source: remove it if you don’t want it." },
  { id: "topic-rust_programming", type: "topic", value: "rust programming", label: "rust programming", status: "pending", note: "Example source: remove it if you don’t want it." },
];

const state = {
  route: { view: "feed" },
  settings: { ytKey: "", geminiKey: "", geminiModel: "", refreshHours: 3, topicCheck: "local", strictness: "balanced", ...load("ft.settings", {}) },
  prefs: { rulesText: DEFAULT_TEXT, compiled: DEFAULT_COMPILED, mode: "strict", channels: {}, watched: {}, liked: {}, notInterested: {}, override: {}, ...load("ft.prefs", {}) },
  sources: load("ft.sources", EXAMPLE_SOURCES),
  pool: load("ft.pool", { videos: {}, lastRefresh: null }), // feed videos by id
  labels: load("ft.labels", {}),                               // Gemini answers: id -> { critKey: bool }
  scores: load("ft.scores", {}),                               // on-device scores: id -> { critKey: similarity }
  units: load("ft.units", { day: "", used: 0 }),
  known: new Map(),        // every video seen this visit (feed, search, watch) by id
  search: { q: "", ids: [], next: null, loading: false, error: "", total: null, showHidden: false },
  refresh: { running: false, error: "" },
  compile: { running: false, error: "" },
  classify: { running: false, error: "", waitUntil: 0, loading: null },
};
delete state.settings.claudeKey; delete state.settings.model; // from the earlier Claude version
state.prefs.compiled = sanitizeCompiled(state.prefs.compiled);
// Rules saved before topics had example phrases: fill in the starter examples where they exist.
for (const [t, ex] of Object.entries(state.prefs.compiled.topics)) if (!ex.length && DEFAULT_COMPILED.topics[t]) state.prefs.compiled.topics[t] = DEFAULT_COMPILED.topics[t];
for (const v of Object.values(state.pool.videos)) state.known.set(v.id, v);

const savePrefs = () => save("ft.prefs", state.prefs);
const saveLabels = () => {
  for (const [key, store] of [["ft.labels", state.labels], ["ft.scores", state.scores]]) {
    const ids = Object.keys(store);
    if (ids.length > 4000) for (const id of ids.slice(0, ids.length - 3000)) delete store[id];
    save(key, store);
  }
};
function savePool() {
  const vids = Object.values(state.pool.videos).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 600);
  state.pool.videos = Object.fromEntries(vids.map((v) => [v.id, v]));
  save("ft.pool", state.pool);
}
const ptDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
function addUnits(n) {
  const d = ptDay();
  if (state.units.day !== d) state.units = { day: d, used: 0 };
  state.units.used += n;
  save("ft.units", state.units);
}

let yt = null, gemini = null;
function connectClients() {
  yt = state.settings.ytKey ? createYouTube(state.settings.ytKey, addUnits) : null;
  gemini = state.settings.geminiKey ? createGemini(state.settings.geminiKey, state.settings.geminiModel) : null;
}
connectClients();

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fmtDur(sec) {
  if (!sec) return "";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function fmtViews(n) {
  if (n == null) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B views";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M views";
  if (n >= 1e3) return Math.round(n / 1e3) + "K views";
  return n + " views";
}
function ago(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(d)) return "";
  for (const [s, n] of [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]])
    if (d >= s) { const k = Math.floor(d / s); return `${k} ${n}${k > 1 ? "s" : ""} ago`; }
  return "just now";
}
const NO_TOPICS = new Proxy({}, { get: () => false }); // topic checks off: topic rules never match
const topicMode = () => state.settings.topicCheck;
const ev = (v) => {
  const m = topicMode();
  if (m === "off") return evaluate(v, state.prefs, NO_TOPICS);
  if (m === "local") return evaluate(v, state.prefs, state.scores[v.id], STRICTNESS[state.settings.strictness] ?? STRICTNESS.balanced);
  return evaluate(v, state.prefs, state.labels[v.id]);
};
const watchHref = (id) => "#watch=" + encodeURIComponent(id);
function bumpChannel(v, d) { if (v) state.prefs.channels[v.channelId] = (state.prefs.channels[v.channelId] || 0) + d; }

/* ---------------- routing ---------------- */
function parseHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("watch=")) return { view: "watch", id: h.slice(6) };
  if (h.startsWith("search=")) return { view: "search", q: h.slice(7) };
  return { view: ["feed", "rules", "sources", "hidden", "settings"].includes(h) ? h : "feed" };
}
function route() {
  state.route = parseHash();
  if (state.route.view === "search" && state.route.q !== state.search.q) runSearch(state.route.q);
  if (state.route.view === "watch") ensureVideo(state.route.id);
  if (state.route.view !== "search") $("#q").value = state.route.view === "watch" ? $("#q").value : "";
  render();
  if (state.route.view !== "watch") window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", route);
$("#searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (q) location.hash = "#search=" + encodeURIComponent(q);
});

/* ---------------- data: feed refresh ---------------- */
async function refreshFeed() {
  if (!yt || state.refresh.running) return;
  state.refresh = { running: true, error: "" }; render();
  const found = new Map();
  for (const s of state.sources) {
    try {
      const r = await yt.sourceIds(s);
      for (const id of r.ids) if (!found.has(id)) found.set(id, { type: s.type, label: r.label });
      Object.assign(s, { status: "active", note: "", label: s.type === "channel" ? r.label : s.label, channelId: r.channelId });
    } catch (e) {
      Object.assign(s, { status: "error", note: e.message });
      if (e.reason === "quotaExceeded" || e.reason === "keyInvalid") { state.refresh.error = e.message; break; }
    }
  }
  save("ft.sources", state.sources);
  try {
    const fresh = [...found.keys()].filter((id) => !state.pool.videos[id]);
    const vids = await yt.details(fresh, (id) => found.get(id));
    for (const v of vids) { state.pool.videos[v.id] = v; state.known.set(v.id, v); }
    state.pool.lastRefresh = new Date().toISOString();
    savePool();
  } catch (e) { state.refresh.error = e.message; }
  state.refresh.running = false;
  render();
}
function maybeAutoRefresh() {
  if (!yt || !state.sources.length) return;
  const last = Date.parse(state.pool.lastRefresh || 0);
  if (!last || Date.now() - last > state.settings.refreshHours * 3600e3) refreshFeed();
}

/* ---------------- data: search ---------------- */
async function runSearch(q, more = false) {
  if (!yt) { state.search = { ...state.search, q, ids: [], error: "Add your YouTube API key in Settings to search YouTube." }; render(); return; }
  if (!more) state.search = { q, ids: [], next: null, loading: true, error: "", total: null, showHidden: false };
  else state.search.loading = true;
  $("#q").value = q;
  render();
  try {
    const r = await yt.search(q, more ? state.search.next : undefined);
    if (state.search.q !== q) return; // a newer search started
    for (const v of r.videos) state.known.set(v.id, v);
    state.search.ids.push(...r.videos.map((v) => v.id).filter((id) => !state.search.ids.includes(id)));
    state.search.next = r.nextPageToken;
    state.search.total = r.total;
  } catch (e) { state.search.error = e.message; }
  state.search.loading = false;
  render();
}

/* ---------------- data: watch ---------------- */
async function ensureVideo(id) {
  if (state.known.has(id) || !yt) return;
  try { const [v] = await yt.details([id]); if (v) { state.known.set(v.id, v); render(); } } catch { /* shown as unknown */ }
}

/* ---------------- Gemini: rules + topic checks ---------------- */
async function compileRules() {
  if (!gemini) return;
  const text = state.prefs.rulesText.trim();
  state.compile = { running: true, error: "" }; render();
  try {
    const compiled = sanitizeCompiled(await gemini.compileRules(text));
    if (!compiled.rules.length && text) throw new Error("Gemini didn’t find a rule about which videos to show. Try wording it as “Hide …” or “Only …”.");
    state.prefs.compiled = compiled;
    state.prefs.override = {};
    savePrefs();
    state.scores = {}; saveLabels(); // topics' example phrases may have changed; on-device scoring is quick to redo
    state.classify.error = "";
  } catch (e) { state.compile.error = e.message; }
  state.compile.running = false;
  render();
}

function needed() {
  // Videos that are on screen or in the feed and still need a topic check.
  const ids = new Set([...Object.keys(state.pool.videos), ...state.search.ids]);
  if (state.route.view === "watch") ids.add(state.route.id);
  const need = new Map();
  for (const id of ids) {
    const v = state.known.get(id);
    if (!v) continue;
    const e = ev(v);
    if (e.need.size) need.set(id, e.need);
  }
  return need;
}
let pumpTimer = null;
setProgressHandler(({ loaded, total }) => { state.classify.loading = total ? Math.round((loaded / total) * 100) : null; renderStrip(); });
function schedulePump(delay = 200) { if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, delay); }
async function pump() {
  const k = state.classify;
  const mode = topicMode();
  if (mode === "off" || (mode === "gemini" && !gemini) || k.running || k.error) return;
  if (Date.now() < k.waitUntil) return schedulePump(k.waitUntil - Date.now());
  let need = needed();
  if (!need.size) return;
  k.running = true; renderStrip();
  try {
    while (need.size) {
      // The open video and search results first, then the feed.
      const prio = [state.route.view === "watch" ? state.route.id : null, ...state.search.ids].filter((id) => need.has(id));
      if (mode === "local") {
        const ids = [...new Set([...prio, ...need.keys()])].slice(0, 64);
        const topics = {};
        for (const id of ids) for (const c of need.get(id)) topics[c] = state.prefs.compiled.topics?.[c] || [];
        const res = await scoreVideos(ids.map((id) => state.known.get(id)), topics);
        for (const id of ids) {
          const sc = (state.scores[id] ||= {});
          for (const c of need.get(id)) sc[critKey(c)] = res[id]?.[c] ?? -1;
        }
        k.loading = null;
      } else {
        const ids = [...new Set([...prio, ...need.keys()])].slice(0, 25);
        const crit = [...new Set(ids.flatMap((id) => [...need.get(id)]))].slice(0, 15);
        const list = ids.map((id) => { const v = state.known.get(id); return { id, title: v.title, channel: v.channel, category: v.category, tags: (v.tags || []).slice(0, 8), description: (v.description || "").slice(0, 300) }; });
        const res = await gemini.classify(list, crit);
        for (const id of ids) {
          const hits = res[id] || new Set();
          const lab = (state.labels[id] ||= {});
          for (const c of crit) if (need.get(id)?.has(c)) lab[critKey(c)] = hits.has(c);
        }
      }
      saveLabels();
      render();
      need = needed();
    }
  } catch (e) {
    if (e.code === "rate") { k.waitUntil = Date.now() + 60e3; schedulePump(60e3); }
    else k.error = mode === "local" ? `The on-device model couldn’t run in this browser (${e.message}). Try Gemini in Settings.` : e.message;
  } finally {
    k.running = false;
    renderStrip();
  }
}

/* ---------------- rendering ---------------- */
function videoCard(v, e, opts = {}) {
  const p = state.prefs, why = [];
  if (v.source?.type === "channel") why.push(`<span>Channel you follow</span>`);
  else if (v.source?.type === "topic") why.push(`<span>Topic: ${esc(v.source.label)}</span>`);
  else if (v.source?.type === "trending") why.push(`<span>${esc(v.source.label)}</span>`);
  for (const r of e.boosts) why.push(`<span class="pill ${r.action === "boost" ? "boost" : ""}">${r.action === "boost" ? "Boosted" : "Lowered"}: ${esc(r.text)}</span>`);
  if (e.overridden) why.push(`<span class="pill block">Shown anyway</span>`);
  if (opts.mini) {
    return `<a class="mini-card" href="${watchHref(v.id)}">
      <span class="thumb"><img src="${esc(v.thumb)}" alt="" loading="lazy">${v.isLive ? '<span class="dur">LIVE</span>' : v.durationSec ? `<span class="dur">${fmtDur(v.durationSec)}</span>` : ""}${p.watched[v.id] ? '<span class="watched-bar"></span>' : ""}</span>
      <span class="meta"><span class="title">${esc(v.title)}</span><span class="sub">${esc(v.channel)}</span><span class="sub">${esc(fmtViews(v.views))}${v.views != null ? " · " : ""}${esc(ago(v.publishedAt))}</span></span>
    </a>`;
  }
  return `<article class="card">
    <a class="thumb" href="${watchHref(v.id)}"><img src="${esc(v.thumb)}" alt="" loading="lazy">${v.isLive ? '<span class="dur">LIVE</span>' : v.durationSec ? `<span class="dur">${fmtDur(v.durationSec)}</span>` : ""}${p.watched[v.id] ? '<span class="watched-bar"></span>' : ""}</a>
    <div class="meta">
      <a class="title" href="${watchHref(v.id)}">${esc(v.title)}</a>
      <div class="sub">${esc(v.channel)} · ${esc(fmtViews(v.views))}${v.views != null ? " · " : ""}${esc(ago(v.publishedAt))}</div>
      ${why.length ? `<div class="why">${why.join("")}</div>` : ""}
    </div>
    <div class="actions">
      <button class="act" data-like="${esc(v.id)}" aria-pressed="${!!p.liked[v.id]}">${p.liked[v.id] ? "Liked" : "Like"}</button>
      <button class="act" data-nope="${esc(v.id)}">Not interested</button>
    </div>
  </article>`;
}

function feedData() {
  const shown = [], hidden = [], pending = [];
  for (const v of Object.values(state.pool.videos)) {
    const e = ev(v);
    if (e.status === "hide") hidden.push({ v, e });
    else if (e.status === "pending") pending.push({ v, e });
    else shown.push({ v, e, s: score(v, e, state.prefs) });
  }
  shown.sort((a, b) => b.s - a.s);
  hidden.sort((a, b) => Date.parse(b.v.publishedAt) - Date.parse(a.v.publishedAt));
  return { shown, hidden, pending };
}

function renderStrip() {
  const parts = [];
  if (!state.settings.ytKey) parts.push(`<span class="chip"><span class="dot err"></span>No YouTube key yet. <a href="#settings">Add it in Settings</a></span>`);
  else if (state.refresh.running) parts.push(`<span class="chip"><span class="dot busy"></span>Fetching new videos from your sources…</span>`);
  else if (state.refresh.error) parts.push(`<span class="chip"><span class="dot err"></span>${esc(state.refresh.error)}</span>`);
  else if (state.pool.lastRefresh) parts.push(`<span class="chip"><span class="dot on"></span>Feed refreshed ${esc(ago(state.pool.lastRefresh))} <button class="linkbtn" data-refresh>Refresh</button></span>`);
  const k = state.classify, need = needed().size;
  if (k.error) parts.push(`<span class="chip"><span class="dot err"></span>${esc(k.error)} <button class="linkbtn" data-resume>Retry</button></span>`);
  else if (k.running && k.loading != null) parts.push(`<span class="chip"><span class="dot busy"></span>Downloading the on-device topic model (one time): ${k.loading}%</span>`);
  else if (k.running) parts.push(`<span class="chip"><span class="dot busy"></span>${topicMode() === "local" ? "Checking" : "Gemini is checking"} ${need} videos against your topic rules${topicMode() === "local" ? " on this device" : ""}</span>`);
  else if (need && Date.now() < k.waitUntil) parts.push(`<span class="chip"><span class="dot"></span>Gemini’s free rate limit was reached; ${need} videos will be checked in a minute</span>`);
  else if (need && topicMode() === "gemini" && !gemini && state.settings.ytKey) parts.push(`<span class="chip"><span class="dot"></span>${need} videos wait for topic checks. <a href="#settings">Add a Gemini key</a></span>`);
  if (state.units.day === ptDay() && state.units.used) parts.push(`<span title="Free daily YouTube quota is 10,000 units">YouTube quota used today: ${state.units.used.toLocaleString()} / 10,000</span>`);
  $("#strip").innerHTML = parts.join("");
}

function render() {
  const r = state.route, m = $("#main");
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-current", t.dataset.view === r.view ? "page" : "false"));
  const fd = feedData();
  $("#nRules").textContent = state.prefs.compiled.rules.length;
  $("#nSources").textContent = state.sources.length;
  $("#nHidden").textContent = fd.hidden.length;
  renderStrip();
  // Don't wipe a form the person is typing in.
  const ae = document.activeElement;
  const typing = ae && m.contains(ae) && /^(TEXTAREA|INPUT|SELECT)$/.test(ae.tagName) && m.dataset.view === r.view;
  if (r.view === "watch") renderWatch(m);
  else if (!typing) {
    m.dataset.view = r.view; delete m.dataset.vid;
    m.innerHTML = r.view === "rules" ? rulesView() : r.view === "sources" ? sourcesView() : r.view === "hidden" ? hiddenView(fd) : r.view === "settings" ? settingsView() : r.view === "search" ? searchView() : feedView(fd);
  }
  document.title = r.view === "watch" ? (state.known.get(r.id)?.title || "Watch") + " · FilterTube" : r.view === "search" ? `${state.search.q} · FilterTube` : "FilterTube";
  schedulePump();
}

function feedView(fd) {
  if (!state.settings.ytKey) return setupCard();
  if (!Object.keys(state.pool.videos).length) {
    return `<div class="empty"><h2>${state.refresh.running ? "Fetching your first videos…" : "No videos yet"}</h2>
      <p class="lede">Your feed is built from the channels and topics under <a href="#sources">Sources</a>. ${state.sources.length ? "" : "Add a few to get started."}</p>
      ${state.sources.length && !state.refresh.running ? '<button class="btn" data-refresh>Fetch videos now</button>' : ""}</div>`;
  }
  if (!fd.shown.length) return `<div class="empty"><h2>${fd.pending.length ? "Checking your feed against your rules…" : "Your rules hide everything right now"}</h2><p class="lede">${fd.pending.length ? "Videos appear as they are checked." : "See what was hidden and why under <a href=\"#hidden\">Hidden</a>, or loosen a rule."}</p></div>`;
  return `<section class="grid" aria-label="Your feed">${fd.shown.map(({ v, e }) => videoCard(v, e)).join("")}</section>
    ${fd.pending.length ? `<p class="note" style="margin-top:20px">${fd.pending.length} more videos are being checked against your rules.</p>` : ""}`;
}

function searchView() {
  const s = state.search;
  const items = s.ids.map((id) => state.known.get(id)).filter(Boolean).map((v) => ({ v, e: ev(v) }));
  const shown = items.filter((x) => x.e.status === "show"), hidden = items.filter((x) => x.e.status === "hide"), pending = items.filter((x) => x.e.status === "pending");
  let head = `<div class="row" style="justify-content:space-between;margin-bottom:16px"><h1>Results for “${esc(s.q)}”</h1>`;
  if (items.length) head += `<span class="note">${shown.length} shown · ${hidden.length} hidden by your rules${pending.length ? ` · ${pending.length} being checked` : ""}${hidden.length ? ` · <button class="linkbtn" data-toggle-hidden>${s.showHidden ? "Hide them" : "See which"}</button>` : ""}</span>`;
  head += `</div>`;
  if (s.error) return head + `<div class="empty"><h2>Search didn’t work</h2><p class="lede">${esc(s.error)}</p></div>`;
  if (s.loading && !items.length) return head + `<div class="empty"><h2>Searching YouTube…</h2></div>`;
  if (!items.length) return head + `<div class="empty"><h2>No results</h2><p class="lede">Try different words.</p></div>`;
  let body = shown.length ? `<section class="grid" aria-label="Search results">${shown.map(({ v, e }) => videoCard(v, e)).join("")}</section>` : `<div class="empty"><h2>Your rules hide every result so far</h2></div>`;
  if (s.showHidden && hidden.length) body += `<section class="panel" style="margin-top:24px"><h2>Hidden by your rules</h2>${hiddenList(hidden)}</section>`;
  body += `<div class="row" style="justify-content:center;margin-top:28px">${s.next ? `<button class="btn ghost" data-more ${s.loading ? "disabled" : ""}>${s.loading ? "Loading…" : "More results"}</button>` : ""}<span class="note">Each page of results uses 100 of your 10,000 daily YouTube quota units.</span></div>`;
  return head + body;
}

function renderWatch(m) {
  const id = state.route.id, v = state.known.get(id);
  const e = v ? ev(v) : null;
  const blocked = e && e.status === "hide";
  const waiting = e && e.status === "pending";
  // Keep the player alive across re-renders: only rebuild when the video or its gate state changes.
  const gateKey = !v ? "loading" : blocked ? "blocked" : waiting ? "waiting" : "play";
  if (m.dataset.view !== "watch" || m.dataset.vid !== id || m.dataset.gate !== gateKey) {
    m.dataset.view = "watch"; m.dataset.vid = id; m.dataset.gate = gateKey;
    let stage;
    if (gateKey === "play") {
      stage = `<div class="player"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&modestbranding=1&playsinline=1" title="${esc(v.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
      if (!state.prefs.watched[id]) bumpChannel(v, 0.5);
      state.prefs.watched[id] = Date.now();
      const w = Object.entries(state.prefs.watched);
      if (w.length > 500) state.prefs.watched = Object.fromEntries(w.sort((a, b) => b[1] - a[1]).slice(0, 400));
      savePrefs();
    } else if (gateKey === "blocked") {
      stage = `<div class="gate"><div><h2>Your rules hide this video</h2><p class="lede">${e.reasons.map((r) => esc(r.text)).join(" · ")}</p><button class="btn ghost" data-override="${esc(id)}">Watch anyway</button></div></div>`;
    } else if (gateKey === "waiting") {
      stage = `<div class="gate"><div><h2>Checking this video against your rules…</h2></div></div>`;
    } else stage = `<div class="gate"><div><h2>${yt ? "Loading video…" : "Add your YouTube API key in Settings to watch videos here."}</h2></div></div>`;
    m.innerHTML = `<div class="watch"><div style="min-width:0">${stage}<div id="winfo"></div></div><aside class="upnext" id="upnext" aria-label="Up next"></aside></div>`;
  }
  const p = state.prefs;
  $("#winfo").innerHTML = v ? `<h1 class="wtitle">${esc(v.title)}</h1>
    <div class="row" style="justify-content:space-between"><span class="sub">${esc(v.channel)} · ${esc(fmtViews(v.views))} · ${esc(ago(v.publishedAt))}</span>
      <span class="actions"><button class="act" data-like="${esc(id)}" aria-pressed="${!!p.liked[id]}">${p.liked[id] ? "Liked" : "Like"}</button><button class="act" data-nope="${esc(id)}">Not interested</button><a class="act" href="https://www.youtube.com/watch?v=${encodeURIComponent(id)}" target="_blank" rel="noopener">Open on YouTube</a></span></div>
    ${v.description ? `<div class="wdesc">${esc(v.description)}</div>` : ""}` : "";
  const cands = [...state.known.values()].filter((x) => x.id !== id).map((x) => ({ v: x, e: ev(x) })).filter((x) => x.e.status === "show");
  if (v) cands.sort((a, b) => similarity(v, b.v) + score(b.v, b.e, p) * 0.3 - (similarity(v, a.v) + score(a.v, a.e, p) * 0.3));
  $("#upnext").innerHTML = `<h2>Up next</h2>${cands.length ? cands.slice(0, 20).map(({ v: x, e: ex }) => videoCard(x, ex, { mini: true })).join("") : '<p class="note">Videos from your feed and searches that pass your rules show up here.</p>'}`;
}

function setupCard() {
  return `<div class="col"><div><h1>Set up FilterTube</h1><p class="lede">FilterTube shows YouTube through rules you write in plain English. It runs entirely in your browser with your own keys.</p></div>
    <section class="panel"><ol class="steps">
      <li><a href="#settings">Add a YouTube Data API key</a> to load videos, search and play them here.</li>
      <li>Optionally <a href="#settings">add a Gemini API key</a> to write your own rules in plain English. Topic rules like “no politics” are checked on your device by default, with no key.</li>
      <li>Pick channels and topics under <a href="#sources">Sources</a> and write your <a href="#rules">Rules</a>.</li>
    </ol><div><a class="btn" href="#settings">Open Settings</a></div></section></div>`;
}

function describeWhen(w) {
  const parts = [];
  if ("is_short" in w) parts.push(w.is_short ? "is a Short" : "is not a Short");
  if ("is_live" in w) parts.push(w.is_live ? "is live" : "is not live");
  if ("min_minutes" in w) parts.push(`≥ ${w.min_minutes} min`);
  if ("max_minutes" in w) parts.push(`≤ ${w.max_minutes} min`);
  if ("max_age_days" in w) parts.push(`uploaded in the last ${w.max_age_days} days`);
  if ("min_age_days" in w) parts.push(`older than ${w.min_age_days} days`);
  if (w.channels) parts.push(`channel: ${w.channels.join(" / ")}`);
  if (w.keywords) parts.push(`mentions: ${w.keywords.join(" / ")}`);
  if (w.about) parts.push(`about: ${w.about.join(" / ")}`);
  return parts.join("  ·  ");
}
function describeSchedule(s) {
  if (!s) return "";
  const d = s.days?.length ? s.days.map((x) => x[0].toUpperCase() + x.slice(1)).join(", ") : "Every day";
  return d + (s.from && s.to ? ` ${s.from}–${s.to}` : s.from ? ` from ${s.from}` : s.to ? ` until ${s.to}` : "");
}
function rulesView() {
  const p = state.prefs, cs = state.compile;
  const label = { block: ["Hide", "block"], allow_only: ["Only", "allow"], boost: ["Boost", "boost"], demote: ["Lower", ""] };
  return `<div class="col">
    <div><h1>Your rules</h1><p class="lede">Write what you want YouTube to be, in your own words, one idea per line. Gemini turns it into filters once; they then apply to every video in your feed, your searches and Up next.</p></div>
    <section class="panel">
      <label for="rulesText"><h2>In your words</h2></label>
      <textarea id="rulesText" spellcheck="true">${esc(p.rulesText)}</textarea>
      <div class="row">
        <button class="btn" data-compile ${cs.running || !gemini ? "disabled" : ""}>${cs.running ? "Gemini is reading your rules…" : "Apply rules"}</button>
        <span class="note ${cs.error ? "err" : ""}">${esc(cs.error || (!gemini ? "Applying new rules needs a Gemini API key (Settings)." : "Examples: “No Shorts on weekdays”, “Only cooking and history before 9pm”, “Hide anything from Channel X”."))}</span>
      </div>
    </section>
    <section class="panel">
      <div class="row" style="justify-content:space-between"><h2>What Gemini understood</h2>
        <div class="seg" role="group" aria-label="Unchecked videos">
          <button data-mode="strict" aria-pressed="${p.mode === "strict"}">Hide until checked</button>
          <button data-mode="lenient" aria-pressed="${p.mode === "lenient"}">Show until checked</button>
        </div></div>
      ${p.compiled.rules.length ? `<ul class="rulelist">${p.compiled.rules.map((r) => {
        const [lab, cls] = label[r.action], on = ruleActive(r);
        return `<li class="rule ${on ? "" : "off"}"><span class="pill ${cls}">${lab}</span><span class="txt">${esc(r.text)}${r.schedule ? ` <span class="note">(${esc(describeSchedule(r.schedule))}${on ? "" : ", not active now"})</span>` : ""}</span><span class="cond">${esc(describeWhen(r.when))}</span></li>`;
      }).join("")}</ul>` : '<p class="note">No rules yet: every video is shown.</p>'}
      ${p.compiled.notes ? `<p class="note">Note: ${esc(p.compiled.notes)}</p>` : ""}
      ${topicMode() === "local" && Object.keys(p.compiled.topics || {}).length ? `<details><summary class="note">Example phrases the on-device model looks for</summary><ul class="note">${Object.entries(p.compiled.topics).map(([t, ex]) => `<li><strong>${esc(t)}</strong>: ${esc(ex.join(" · ") || "(topic name only)")}</li>`).join("")}</ul></details>` : ""}
      <p class="note">Conditions marked <code>about:</code> are checked ${topicMode() === "local" ? "on this device by a small model that compares each video’s title, tags and description with the example phrases above" : topicMode() === "gemini" ? "by Gemini from each video’s title, channel, tags and description" : "nowhere: topic checks are off in Settings, so they never match"}, once per video. The other conditions are checked instantly.</p>
    </section></div>`;
}

function sourcesView() {
  const st = { pending: ["Not fetched yet", ""], active: ["Active", "allow"], error: ["Problem", "block"] };
  const cost = state.sources.reduce((n, s) => n + (s.type === "topic" ? 100 : s.type === "channel" ? 2 : 1), 0);
  return `<div class="col">
    <div><h1>Sources</h1><p class="lede">YouTube doesn’t let other apps use its personal recommendations, so your feed is built from these: new uploads from channels you follow, recent videos about topics you choose, and trending videos if you want them. Ranking favours fresh videos, channels you like or watch, and anything your rules boost.</p></div>
    <section class="panel">
      <h2>Add a source</h2>
      <form class="addform" id="addForm">
        <select id="srcType" aria-label="Source type"><option value="channel">Channel</option><option value="topic">Topic</option><option value="trending">Trending in region</option></select>
        <input id="srcValue" placeholder="@handle or channel link" aria-label="Channel, topic or region" required>
        <button class="btn" type="submit">Add</button>
      </form>
      <div class="row"><button class="btn ghost" data-refresh ${!yt || state.refresh.running ? "disabled" : ""}>${state.refresh.running ? "Fetching…" : "Fetch new videos now"}</button>
      <span class="note">Each refresh uses about ${cost} of your 10,000 daily YouTube quota units (topics cost 100 each). FilterTube refreshes on its own every ${state.settings.refreshHours} hours when you open it.</span></div>
    </section>
    <section class="panel"><h2>Following</h2>
      ${state.sources.length ? `<ul class="list">${state.sources.map((s) => {
        const [lab, cls] = st[s.status] || st.pending;
        return `<li><span class="pill">${esc(s.type)}</span><span class="grow">${esc(s.label || s.value)}${s.note ? `<br><span class="note">${esc(s.note)}</span>` : ""}</span><span class="pill ${cls}">${lab}</span><button class="act" data-delsrc="${esc(s.id)}" aria-label="Remove ${esc(s.label || s.value)}">Remove</button></li>`;
      }).join("")}</ul>` : '<p class="note">Nothing yet. Add a few channels you trust and a couple of topics.</p>'}
    </section></div>`;
}

function hiddenList(items) {
  return `<ul class="list">${items.map(({ v, e }) => `<li>
    <span class="mini"><img src="${esc(v.thumb)}" alt="" loading="lazy"></span>
    <span class="grow"><strong>${esc(v.title)}</strong><br><span class="note">${esc(v.channel)}${v.durationSec ? " · " + fmtDur(v.durationSec) : ""}</span><br>${e.reasons.map((r) => `<span class="pill ${r.kind === "allow" ? "allow" : "block"}">${esc(r.text)}</span>`).join(" ")}</span>
    ${e.reasons.some((r) => r.kind === "user") ? `<button class="act" data-undo="${esc(v.id)}">Undo</button>` : `<button class="act" data-override="${esc(v.id)}">Show anyway</button>`}
  </li>`).join("")}</ul>`;
}
function hiddenView(fd) {
  return `<div class="col"><div><h1>Hidden from your feed</h1><p class="lede">Everything your rules kept out of the feed, and why. If a rule caught something it shouldn’t have, show that video anyway or adjust the rule.</p></div>
    ${fd.hidden.length ? `<section class="panel">${hiddenList(fd.hidden)}</section>` : '<div class="empty"><h2>Nothing hidden</h2><p class="lede">Every video in your feed passes your rules.</p></div>'}</div>`;
}

function settingsView() {
  const s = state.settings;
  return `<div class="col">
    <div><h1>Settings</h1><p class="lede">Keys are saved only in this browser and sent only to YouTube and Google’s Gemini API. Anyone using this browser profile can read them.</p></div>
    <form class="panel" id="settingsForm">
      <div class="field"><label for="ytKey">YouTube Data API key</label><input id="ytKey" type="password" autocomplete="off" value="${esc(s.ytKey)}" placeholder="AIza…">
        <p class="note">Create one in Google Cloud Console → APIs &amp; Services → Credentials, with “YouTube Data API v3” enabled. Restrict it to that API, and under Application restrictions choose <em>Websites</em> and add <code>${esc(location.origin)}/*</code> so it only works on this site.</p></div>
      <div class="field"><label for="geminiKey">Gemini API key</label><input id="geminiKey" type="password" autocomplete="off" value="${esc(s.geminiKey)}" placeholder="AIza…">
        <p class="note">Get one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Used to turn your written rules into filters and, below, to check topic rules. The free tier is enough for personal use.</p></div>
      <div class="field"><label for="topicCheck">Topic checks</label><select id="topicCheck">
        <option value="local" ${s.topicCheck === "local" ? "selected" : ""}>On this device (no key; about 50 MB downloaded once)</option>
        <option value="gemini" ${s.topicCheck === "gemini" ? "selected" : ""}>Gemini (more accurate; uses the key above)</option>
        <option value="off" ${s.topicCheck === "off" ? "selected" : ""}>Off (topic rules never match)</option></select>
        <p class="note">Topic rules are ones like “no politics” or “boost programming”. On this device, a small model compares each video with example phrases for each topic; nothing is sent anywhere. It’s good at subjects (coding, cooking, politics) and weaker at tone (“clickbait”). ${gemini?.model ? `Gemini model in use: <code>${esc(gemini.model)}</code>.` : ""}</p></div>
      <div class="field"><label for="strictness">On-device strictness</label><select id="strictness">
        <option value="strict" ${s.strictness === "strict" ? "selected" : ""}>Strict: catches more, may hide videos that only touch a topic</option>
        <option value="balanced" ${s.strictness === "balanced" ? "selected" : ""}>Balanced</option>
        <option value="loose" ${s.strictness === "loose" ? "selected" : ""}>Loose: only clear matches</option></select></div>
      <div class="field"><label for="geminiModel">Gemini model <span class="note">(optional)</span></label><input id="geminiModel" value="${esc(s.geminiModel)}" placeholder="Automatic: newest Flash-Lite model">
        <p class="note">Leave blank to pick the newest stable Flash-Lite model automatically.</p></div>
      <div class="field"><label for="refreshHours">Refresh the feed every</label><select id="refreshHours">${[1, 3, 6, 12, 24].map((h) => `<option value="${h}" ${h === s.refreshHours ? "selected" : ""}>${h} hour${h > 1 ? "s" : ""}</option>`).join("")}</select></div>
      <div class="row"><button class="btn" type="submit">Save</button><span class="note" id="savedNote"></span></div>
    </form>
    <section class="panel"><h2>Your data</h2><p class="note">Rules, sources, likes, watch history and topic checks are stored in this browser. Clearing them starts FilterTube fresh.</p>
      <div><button class="btn ghost" data-clear>Clear saved videos and topic checks</button></div></section>
  </div>`;
}

/* ---------------- interactions ---------------- */
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-like],[data-nope],[data-override],[data-undo],[data-delsrc],[data-mode],[data-compile],[data-refresh],[data-resume],[data-more],[data-toggle-hidden],[data-clear]");
  if (!t) return;
  const p = state.prefs, d = t.dataset;
  if (d.like) { const v = state.known.get(d.like); if (p.liked[d.like]) { delete p.liked[d.like]; bumpChannel(v, -1.5); } else { p.liked[d.like] = true; bumpChannel(v, 1.5); } savePrefs(); }
  else if (d.nope) { p.notInterested[d.nope] = true; bumpChannel(state.known.get(d.nope), -2); savePrefs(); }
  else if (d.override) { p.override[d.override] = true; savePrefs(); }
  else if (d.undo) { delete p.notInterested[d.undo]; bumpChannel(state.known.get(d.undo), 2); savePrefs(); }
  else if (d.mode) { p.mode = d.mode; savePrefs(); }
  else if (d.delsrc) { state.sources = state.sources.filter((s) => s.id !== d.delsrc); save("ft.sources", state.sources); }
  else if ("compile" in d) { compileRules(); return; }
  else if ("refresh" in d) { refreshFeed(); return; }
  else if ("resume" in d) { state.classify.error = ""; }
  else if ("more" in d) { runSearch(state.search.q, true); return; }
  else if ("toggleHidden" in d) { state.search.showHidden = !state.search.showHidden; }
  else if ("clear" in d) { state.pool = { videos: {}, lastRefresh: null }; state.labels = {}; state.scores = {}; save("ft.pool", state.pool); save("ft.labels", {}); save("ft.scores", {}); }
  render();
});
document.addEventListener("input", (e) => {
  if (e.target.id === "rulesText") { state.prefs.rulesText = e.target.value; savePrefs(); }
  if (e.target.id === "srcType") $("#srcValue").placeholder = { channel: "@handle or channel link", topic: "e.g. woodworking, rust programming", trending: "Country code, e.g. US, IN, GB" }[e.target.value];
});
document.addEventListener("submit", (e) => {
  if (e.target.id === "addForm") {
    e.preventDefault();
    const type = $("#srcType").value;
    let v = $("#srcValue").value.trim();
    if (!v) return;
    if (type === "channel") {
      const m = v.match(/youtube\.com\/(?:channel\/(UC[\w-]{20,})|(@[\w.-]+)|c\/([\w.-]+)|user\/([\w.-]+))/i);
      if (m) v = m[1] || m[2] || m[3] || m[4];
      if (!v.startsWith("@") && !v.startsWith("UC")) v = "@" + v;
    }
    if (type === "trending") v = v.toUpperCase().slice(0, 2);
    const id = type + "-" + critKey(v);
    if (!state.sources.some((s) => s.id === id)) state.sources.push({ id, type, value: v, label: v, status: "pending", note: "" });
    save("ft.sources", state.sources);
    $("#srcValue").value = "";
    $("#srcValue").blur();
    render();
  } else if (e.target.id === "settingsForm") {
    e.preventDefault();
    const before = state.settings.ytKey;
    Object.assign(state.settings, { ytKey: $("#ytKey").value.trim(), geminiKey: $("#geminiKey").value.trim(), geminiModel: $("#geminiModel").value.trim(), refreshHours: +$("#refreshHours").value, topicCheck: $("#topicCheck").value, strictness: $("#strictness").value });
    save("ft.settings", state.settings);
    connectClients();
    state.classify.error = "";
    document.activeElement?.blur();
    render();
    const n = $("#savedNote"); if (n) { n.textContent = "Saved."; n.className = "note ok"; }
    if (!before && state.settings.ytKey) maybeAutoRefresh();
  }
});

/* ---------------- boot ---------------- */
route();
maybeAutoRefresh();
