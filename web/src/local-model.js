// Topic checks with a small model that runs in the browser (no key, nothing sent anywhere).
// Each topic in the rules comes with example phrases; a video's score for a topic is its best
// similarity to the topic name or any of its examples.

let worker = null, seq = 0;
const pending = new Map();
let onProgress = () => {};

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./embed-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") return onProgress(m);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.vectors);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "the model failed to load"));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function embed(texts) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, texts });
  });
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const protoCache = new Map(); // phrase -> vector
const textCache = new Map();  // item text -> vector (videos and channels), so re-scoring is cheap

/** How similar a video must be to a topic's examples to count as a match. */
export const STRICTNESS = { strict: 0.28, balanced: 0.34, loose: 0.42 };

export function setProgressHandler(fn) { onProgress = fn; }

const videoText = (v) => `${v.title}. ${(v.tags || []).slice(0, 8).join(" ")}. ${(v.description || "").slice(0, 200)}`;

/** videos: [{id,...}], topics: { [topic]: [example phrases] } -> { [videoId]: { [topic]: score } } */
export async function scoreVideos(videos, topics) {
  const names = Object.keys(topics);
  const phrases = [...new Set(names.flatMap((t) => [t, ...(topics[t] || [])]))].filter((p) => !protoCache.has(p));
  if (phrases.length) {
    const vecs = await embed(phrases);
    phrases.forEach((p, i) => protoCache.set(p, vecs[i]));
  }
  const texts = videos.map(videoText);
  const missing = [...new Set(texts.filter((t) => !textCache.has(t)))];
  if (missing.length) {
    const vecs = await embed(missing);
    missing.forEach((t, i) => textCache.set(t, vecs[i]));
    if (textCache.size > 5000) for (const k of [...textCache.keys()].slice(0, 1000)) textCache.delete(k);
  }
  const vvecs = texts.map((t) => textCache.get(t));
  const out = {};
  videos.forEach((v, i) => {
    out[v.id] = {};
    for (const t of names) {
      let best = -1;
      for (const p of [t, ...(topics[t] || [])]) best = Math.max(best, dot(vvecs[i], protoCache.get(p)));
      out[v.id][t] = best;
    }
  });
  return out;
}
