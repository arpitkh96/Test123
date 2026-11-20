// YouTube Data API v3 client (browser). Quota costs per call are noted; the daily free quota is 10,000 units.

const BASE = "https://www.googleapis.com/youtube/v3/";
const CATEGORY = { 1: "Film & Animation", 2: "Autos & Vehicles", 10: "Music", 15: "Pets & Animals", 17: "Sports", 19: "Travel & Events", 20: "Gaming", 22: "People & Blogs", 23: "Comedy", 24: "Entertainment", 25: "News & Politics", 26: "Howto & Style", 27: "Education", 28: "Science & Technology", 29: "Nonprofits & Activism" };

export class YouTubeError extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}

/** Runs fn over items with at most `n` in flight; rejects on the first error. */
export async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } });
  await Promise.all(workers);
}

export function createYouTube(key, onUnits = () => {}) {
  async function api(endpoint, params, cost = 1) {
    if (!key) throw new YouTubeError("Add your YouTube API key in Settings.", "noKey");
    const q = new URLSearchParams({ ...params, key });
    onUnits(cost);
    const res = await fetch(BASE + endpoint + "?" + q);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body?.error?.errors?.[0]?.reason || "";
      const msg = reason === "quotaExceeded" ? "Today’s YouTube quota is used up. It resets at midnight Pacific time."
        : reason === "keyInvalid" || res.status === 400 && /API key/i.test(body?.error?.message || "") ? "YouTube rejected the API key. Check it in Settings."
        : body?.error?.message || `YouTube request failed (${res.status}).`;
      throw new YouTubeError(msg, reason);
    }
    return body;
  }

  const isoDur = (d) => {
    const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || "");
    return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
  };

  function toVideo(v, source) {
    const sn = v.snippet, dur = isoDur(v.contentDetails?.duration);
    const tags = (sn.tags || []).slice(0, 12);
    const text = `${sn.title} ${sn.description} ${tags.join(" ")}`.toLowerCase();
    const isLive = sn.liveBroadcastContent === "live" || sn.liveBroadcastContent === "upcoming";
    // The API does not say whether a video is a Short; short vertical uploads are the norm, so use length and #shorts.
    const isShort = !isLive && dur > 0 && (dur <= 60 || (dur <= 180 && /#shorts?\b/.test(text)));
    const th = sn.thumbnails || {};
    return {
      id: v.id, title: sn.title, channel: sn.channelTitle, channelId: sn.channelId, publishedAt: sn.publishedAt,
      durationSec: dur, isLive, isShort, category: CATEGORY[sn.categoryId] || "", tags,
      description: (sn.description || "").slice(0, 500),
      views: v.statistics?.viewCount != null ? +v.statistics.viewCount : null,
      thumb: (th.high || th.medium || th.default || {}).url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
      source, fetchedAt: new Date().toISOString(),
    };
  }

  /** Full details for up to any number of ids (1 unit per 50). */
  async function details(ids, sourceFor = () => null) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await api("videos", { part: "snippet,contentDetails,statistics", id: ids.slice(i, i + 50).join(",") });
      for (const v of r.items || []) out.push(toVideo(v, sourceFor(v.id)));
    }
    return out;
  }

  /** Channel info for sources: [{ value: "@handle" | "UC…" }] -> Map(value -> { channelId, title, description, thumb }).
   *  UC ids are looked up 50 per call (1 unit); each handle costs 1 unit. Missing ones are left out. */
  async function channelsInfo(values) {
    const out = new Map();
    const pick = (c) => ({ channelId: c.id, title: c.snippet.title, description: (c.snippet.description || "").slice(0, 300), thumb: c.snippet.thumbnails?.default?.url || "" });
    const ids = values.filter((v) => /^UC[\w-]{22}$/.test(v));
    for (let i = 0; i < ids.length; i += 50) {
      const r = await api("channels", { part: "snippet", id: ids.slice(i, i + 50).join(","), maxResults: "50" });
      for (const c of r.items || []) out.set(c.id, pick(c));
    }
    const handles = values.filter((v) => !/^UC[\w-]{22}$/.test(v));
    await pool(handles, 6, async (h) => {
      const r = await api("channels", { part: "snippet", forHandle: h.replace(/^@?/, "@") });
      if (r.items?.[0]) out.set(h, pick(r.items[0]));
    });
    return out;
  }

  return {
    details,
    channelsInfo,
    /** Latest uploads of a channel (1 unit): every channel's uploads playlist is its id with "UC" -> "UU". */
    async uploads(channelId, max = 10) {
      const r = await api("playlistItems", { part: "contentDetails", playlistId: "UU" + channelId.slice(2), maxResults: String(max) });
      return (r.items || []).map((it) => it.contentDetails.videoId);
    },
    /** Full YouTube search: 100 units per page + 1 for details. */
    async search(q, pageToken) {
      const r = await api("search", { part: "id", q, type: "video", maxResults: "25", safeSearch: "none", ...(pageToken ? { pageToken } : {}) }, 100);
      const ids = (r.items || []).map((it) => it.id?.videoId).filter(Boolean);
      const vids = await details(ids, () => ({ type: "search", label: q }));
      const order = new Map(ids.map((id, i) => [id, i]));
      vids.sort((a, b) => order.get(a.id) - order.get(b.id));
      return { videos: vids, nextPageToken: r.nextPageToken || null, total: r.pageInfo?.totalResults ?? null };
    },
    /** Video ids for one source; channel ≈ 2 units, topic 100, trending 1. Returns { ids, label, channelId }. */
    async sourceIds(s) {
      if (s.type === "channel") {
        const v = String(s.value);
        const ch = await api("channels", v.startsWith("UC") ? { part: "snippet,contentDetails", id: v } : { part: "snippet,contentDetails", forHandle: v.replace(/^@?/, "@") });
        const c = ch.items?.[0];
        if (!c) throw new YouTubeError(`No channel found for ${v}.`, "notFound");
        const pl = await api("playlistItems", { part: "contentDetails", playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: "15" });
        return { ids: (pl.items || []).map((it) => it.contentDetails.videoId), label: c.snippet.title, channelId: c.id };
      }
      if (s.type === "topic") {
        const after = new Date(Date.now() - 45 * 864e5).toISOString();
        const r = await api("search", { part: "id", q: s.value, type: "video", order: "relevance", publishedAfter: after, maxResults: "20" }, 100);
        return { ids: (r.items || []).map((it) => it.id?.videoId).filter(Boolean), label: s.value };
      }
      const r = await api("videos", { part: "id", chart: "mostPopular", regionCode: String(s.value || "US"), maxResults: "25" });
      return { ids: (r.items || []).map((it) => it.id), label: "Trending " + s.value };
    },
  };
}
