#!/usr/bin/env node
// Fetches videos for FilterTube's sources from the YouTube Data API v3 and writes
// one JSON file per database document, ready for ArtifactData batch writes.
//
//   node tools/ingest.mjs <sourcesDir> <outDir> [existingIdsFile]
//
// <sourcesDir>  directory of source documents (ArtifactData `list` with out_dir → <dir>/sources/*.json)
// <outDir>      receives videos/<id>.json, sources/<id>.json (status updates) and meta/ingest.json
// The API key is sent by the network proxy (header X-goog-api-key), or from $YT_API_KEY if set.
// Quota: channel = ~3 units, topic search = 101 units, trending = 1 unit, details = 1 unit / 50 videos.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [sourcesDir, outDir, existingFile] = process.argv.slice(2);
if (!sourcesDir || !outDir) { console.error("usage: ingest.mjs <sourcesDir> <outDir> [existingIdsFile]"); process.exit(2); }
const KEY = process.env.YT_API_KEY || "";
const PER_CHANNEL = 12, PER_TOPIC = 15, PER_TRENDING = 20, TOPIC_DAYS = 45;
const CATEGORY = { 1: "Film & Animation", 2: "Autos & Vehicles", 10: "Music", 15: "Pets & Animals", 17: "Sports", 19: "Travel & Events", 20: "Gaming", 22: "People & Blogs", 23: "Comedy", 24: "Entertainment", 25: "News & Politics", 26: "Howto & Style", 27: "Education", 28: "Science & Technology", 29: "Nonprofits & Activism" };
let units = 0;

function curl(url, binary = false) {
  const args = ["-sS", "--fail-with-body", "--max-time", "30", url];
  return execFileSync("curl", args, { encoding: binary ? "buffer" : "utf8", maxBuffer: 32 << 20 });
}
function api(endpoint, params, cost = 1) {
  const q = new URLSearchParams(params); if (KEY) q.set("key", KEY);
  units += cost;
  try { return JSON.parse(curl(`https://www.googleapis.com/youtube/v3/${endpoint}?${q}`)); }
  catch (e) {
    const body = String(e.stdout || e.message);
    let msg = body; try { msg = JSON.parse(body).error.message; } catch {}
    throw new Error(msg.slice(0, 300));
  }
}
const isoDur = (d) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || ""); return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) : 0; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || "x";

const sources = fs.existsSync(sourcesDir) ? fs.readdirSync(sourcesDir).filter((f) => f.endsWith(".json")).map((f) => ({ id: path.basename(f, ".json"), ...JSON.parse(fs.readFileSync(path.join(sourcesDir, f), "utf8")) })) : [];
const existing = new Set(existingFile && fs.existsSync(existingFile) ? JSON.parse(fs.readFileSync(existingFile, "utf8")) : []);
const found = new Map(); // videoId -> {type,label}
const sourceUpdates = {};

for (const s of sources) {
  try {
    if (s.type === "channel") {
      const v = String(s.value);
      const ch = api("channels", v.startsWith("UC") ? { part: "snippet,contentDetails", id: v } : { part: "snippet,contentDetails", forHandle: v.replace(/^@?/, "@") });
      const c = ch.items?.[0]; if (!c) throw new Error("No channel found for " + v);
      const pl = api("playlistItems", { part: "contentDetails", playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: String(PER_CHANNEL) });
      for (const it of pl.items || []) if (!found.has(it.contentDetails.videoId)) found.set(it.contentDetails.videoId, { type: "channel", label: c.snippet.title });
      sourceUpdates[s.id] = { status: "active", label: c.snippet.title, channelId: c.id, note: "" };
    } else if (s.type === "topic") {
      const after = new Date(Date.now() - TOPIC_DAYS * 864e5).toISOString();
      const r = api("search", { part: "id", q: s.value, type: "video", order: "relevance", publishedAfter: after, maxResults: String(PER_TOPIC), relevanceLanguage: "en" }, 100);
      for (const it of r.items || []) if (it.id?.videoId && !found.has(it.id.videoId)) found.set(it.id.videoId, { type: "topic", label: s.value });
      sourceUpdates[s.id] = { status: "active", note: "" };
    } else if (s.type === "trending") {
      const r = api("videos", { part: "id", chart: "mostPopular", regionCode: String(s.value || "US"), maxResults: String(PER_TRENDING) });
      for (const it of r.items || []) if (!found.has(it.id)) found.set(it.id, { type: "trending", label: "Trending " + s.value });
      sourceUpdates[s.id] = { status: "active", note: "" };
    }
  } catch (e) {
    sourceUpdates[s.id] = { status: "error", note: e.message };
  }
}

const fresh = [...found.keys()].filter((id) => !existing.has(id));
const docs = [];
for (let i = 0; i < fresh.length; i += 50) {
  const r = api("videos", { part: "snippet,contentDetails,statistics,liveStreamingDetails", id: fresh.slice(i, i + 50).join(",") });
  for (const v of r.items || []) {
    const sn = v.snippet, dur = isoDur(v.contentDetails?.duration);
    const tags = (sn.tags || []).slice(0, 12);
    const text = `${sn.title} ${sn.description} ${tags.join(" ")}`.toLowerCase();
    const isLive = sn.liveBroadcastContent === "live" || sn.liveBroadcastContent === "upcoming";
    const isShort = !isLive && dur > 0 && (dur <= 60 || (dur <= 180 && /#shorts?\b/.test(text)));
    let thumb = "";
    try { thumb = "data:image/jpeg;base64," + curl(`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, true).toString("base64"); } catch {}
    docs.push({ id: v.id, data: {
      title: sn.title, channel: sn.channelTitle, channelId: sn.channelId, publishedAt: sn.publishedAt,
      durationSec: dur, isLive, isShort, category: CATEGORY[sn.categoryId] || "", tags,
      description: (sn.description || "").slice(0, 400), views: v.statistics?.viewCount != null ? +v.statistics.viewCount : null,
      thumb, source: found.get(v.id), fetchedAt: new Date().toISOString(),
    } });
  }
}

fs.mkdirSync(path.join(outDir, "videos"), { recursive: true });
fs.mkdirSync(path.join(outDir, "sources"), { recursive: true });
fs.mkdirSync(path.join(outDir, "meta"), { recursive: true });
for (const d of docs) fs.writeFileSync(path.join(outDir, "videos", d.id + ".json"), JSON.stringify(d.data));
for (const [id, u] of Object.entries(sourceUpdates)) fs.writeFileSync(path.join(outDir, "sources", id + ".json"), JSON.stringify(u));
fs.writeFileSync(path.join(outDir, "meta", "ingest.json"), JSON.stringify({ lastRun: new Date().toISOString(), added: docs.length, quotaUnits: units, sources: sources.length }));
console.log(JSON.stringify({ sources: sources.length, candidates: found.size, added: docs.length, quotaUnits: units, errors: Object.entries(sourceUpdates).filter(([, u]) => u.status === "error").map(([id, u]) => `${id}: ${u.note}`) }, null, 1));
