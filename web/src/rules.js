// Rule engine: compiled rules -> show / hide / pending for each video.
// A rule's `when` conditions must all hold; `about` conditions are judged by Claude
// and cached per video in `labels` ({ [critKey]: boolean }).

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export const DEFAULT_TEXT = `No Shorts.
Hide celebrity gossip, drama and reaction videos.
Hide clickbait titles.
Nothing longer than 2 hours.
Show more programming and science.`;

// Starter rules, precompiled so Shorts are filtered before Claude is ever asked.
export const DEFAULT_COMPILED = {
  rules: [
    { id: "r1", action: "block", text: "Hide Shorts", when: { is_short: true } },
    { id: "r2", action: "block", text: "Hide celebrity gossip, drama and reaction videos", when: { about: ["celebrity gossip or influencer drama", "reaction video"] } },
    { id: "r3", action: "block", text: "Hide clickbait titles", when: { about: ["clickbait title (exaggerated, misleading or withholding to bait clicks)"] } },
    { id: "r4", action: "block", text: "Hide videos longer than 2 hours", when: { min_minutes: 120 } },
    { id: "r5", action: "boost", text: "Rank programming and science higher", when: { about: ["programming or software engineering", "science"] } },
  ],
  notes: "",
};

export const critKey = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || "x";

export function sanitizeCompiled(raw) {
  const out = { rules: [], notes: typeof raw?.notes === "string" ? raw.notes : "" };
  const list = Array.isArray(raw?.rules) ? raw.rules : [];
  list.forEach((r, i) => {
    if (!r || typeof r !== "object") return;
    const action = ["block", "allow_only", "boost", "demote"].includes(r.action) ? r.action : null;
    if (!action) return;
    const w = r.when && typeof r.when === "object" ? r.when : {};
    const when = {};
    if (typeof w.is_short === "boolean") when.is_short = w.is_short;
    if (typeof w.is_live === "boolean") when.is_live = w.is_live;
    for (const k of ["min_minutes", "max_minutes", "max_age_days", "min_age_days"])
      if (w[k] !== null && w[k] !== undefined && w[k] !== "" && Number.isFinite(+w[k])) when[k] = +w[k];
    for (const k of ["channels", "keywords", "about"])
      if (Array.isArray(w[k])) {
        const a = w[k].map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12);
        if (a.length) when[k] = a;
      }
    let schedule = null;
    if (r.schedule && typeof r.schedule === "object") {
      const s = r.schedule;
      schedule = {};
      if (Array.isArray(s.days)) schedule.days = s.days.map((d) => String(d).slice(0, 3).toLowerCase()).filter((d) => DAYS.includes(d));
      if (!schedule.days?.length) delete schedule.days;
      for (const k of ["from", "to"]) if (/^\d{1,2}:\d{2}$/.test(s[k] || "")) schedule[k] = s[k].padStart(5, "0");
      if (!Object.keys(schedule).length) schedule = null;
    }
    if (!Object.keys(when).length) return;
    out.rules.push({ id: "r" + (i + 1), action, text: String(r.text || "").slice(0, 200) || action, when, schedule });
  });
  return out;
}

export function ruleActive(r, now = new Date()) {
  const s = r.schedule;
  if (!s) return true;
  if (s.days?.length && !s.days.includes(DAYS[now.getDay()])) return false;
  const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (s.from && s.to) return s.from <= s.to ? hm >= s.from && hm < s.to : hm >= s.from || hm < s.to;
  if (s.from) return hm >= s.from;
  if (s.to) return hm < s.to;
  return true;
}

/** true / false / null (an `about` condition still needs Claude). */
export function matchWhen(w, v, lab) {
  const mins = (v.durationSec || 0) / 60;
  const ageDays = (Date.now() - Date.parse(v.publishedAt)) / 864e5;
  if ("is_short" in w && !!v.isShort !== w.is_short) return false;
  if ("is_live" in w && !!v.isLive !== w.is_live) return false;
  if ("min_minutes" in w && !(mins >= w.min_minutes)) return false;
  if ("max_minutes" in w && !(mins <= w.max_minutes)) return false;
  if ("max_age_days" in w && !(ageDays <= w.max_age_days)) return false;
  if ("min_age_days" in w && !(ageDays >= w.min_age_days)) return false;
  if (w.channels) {
    const c = (v.channel || "").toLowerCase();
    if (!w.channels.some((x) => c.includes(x.toLowerCase()))) return false;
  }
  if (w.keywords) {
    const hay = `${v.title} ${(v.tags || []).join(" ")} ${v.description || ""}`.toLowerCase();
    if (!w.keywords.some((k) => hay.includes(k.toLowerCase()))) return false;
  }
  if (!w.about) return true;
  let unknown = false;
  for (const a of w.about) {
    const x = lab?.[critKey(a)];
    if (x === true) return true;
    if (x === undefined) unknown = true;
  }
  return unknown ? null : false;
}

/** prefs: { compiled, mode, notInterested, override } */
export function evaluate(v, prefs, lab) {
  const rules = (prefs.compiled?.rules || []).filter((r) => ruleActive(r));
  const res = { status: "show", reasons: [], boosts: [], need: new Set() };
  if (prefs.notInterested?.[v.id]) {
    res.status = "hide";
    res.reasons.push({ text: "You marked this Not interested", kind: "user" });
    return res;
  }
  let allowRules = 0, allowHit = false, allowUnknown = false;
  for (const r of rules) {
    const m = matchWhen(r.when, v, lab);
    if (m === null) (r.when.about || []).forEach((a) => { if (lab?.[critKey(a)] === undefined) res.need.add(a); });
    if (r.action === "block") {
      if (m === true) { res.status = "hide"; res.reasons.push({ text: r.text, kind: "block" }); }
      else if (m === null && prefs.mode === "strict" && res.status !== "hide") res.status = "pending";
    } else if (r.action === "allow_only") {
      allowRules++;
      if (m === true) allowHit = true;
      else if (m === null) allowUnknown = true;
    } else if (m === true) res.boosts.push(r);
  }
  if (allowRules && !allowHit && res.status !== "hide") {
    if (allowUnknown) { if (prefs.mode === "strict") res.status = "pending"; }
    else { res.status = "hide"; res.reasons.push({ text: "Not in your allowed topics right now", kind: "allow" }); }
  }
  if (res.status === "hide" && prefs.override?.[v.id]) { res.status = "show"; res.overridden = true; }
  if (res.status === "hide") res.need.clear();
  return res;
}

/** Feed ranking: freshness + channel affinity + source + rule boosts - already watched. */
export function score(v, ev, prefs) {
  const age = Math.max(0, (Date.now() - Date.parse(v.publishedAt)) / 864e5);
  let s = 3 * Math.exp(-age / 10);
  s += Math.max(-4, Math.min(4, prefs.channels?.[v.channelId] || 0));
  s += v.source?.type === "channel" ? 1 : v.source?.type === "topic" ? 0.6 : 0;
  for (const r of ev.boosts) s += r.action === "boost" ? 2.5 : -2.5;
  if (prefs.watched?.[v.id]) s -= 3;
  return s;
}

/** "Up next" similarity to the video being watched. */
export function similarity(a, b) {
  if (a.id === b.id) return -Infinity;
  const words = (v) => new Set(`${v.title} ${(v.tags || []).join(" ")}`.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const wa = words(a), wb = words(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return (a.channelId === b.channelId ? 3 : 0) + (a.category && a.category === b.category ? 1 : 0) + Math.min(shared, 5);
}
