// Topic checks with Google's Gemini API, using the same Google Cloud API key as YouTube
// (the key's project needs the "Generative Language API" enabled).

const BASE = "https://generativelanguage.googleapis.com/v1beta/";

export class GeminiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    results: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, matches: { type: "ARRAY", items: { type: "STRING" } } },
        required: ["id", "matches"],
      },
    },
  },
  required: ["results"],
};

// Gemini's response schema (an OpenAPI subset): rules -> structured filters.
const COMPILE_SCHEMA = {
  type: "OBJECT",
  properties: {
    notes: { type: "STRING" },
    topics: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { name: { type: "STRING" }, examples: { type: "ARRAY", items: { type: "STRING" } } },
        required: ["name", "examples"],
      },
    },
    rules: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          action: { type: "STRING", enum: ["block", "allow_only", "boost", "demote"] },
          text: { type: "STRING" },
          when: {
            type: "OBJECT",
            properties: {
              is_short: { type: "BOOLEAN" }, is_live: { type: "BOOLEAN" },
              min_minutes: { type: "NUMBER" }, max_minutes: { type: "NUMBER" },
              max_age_days: { type: "NUMBER" }, min_age_days: { type: "NUMBER" },
              channels: { type: "ARRAY", items: { type: "STRING" } },
              keywords: { type: "ARRAY", items: { type: "STRING" } },
              about: { type: "ARRAY", items: { type: "STRING" } },
            },
          },
          schedule: {
            type: "OBJECT",
            properties: {
              days: { type: "ARRAY", items: { type: "STRING", enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] } },
              from: { type: "STRING" }, to: { type: "STRING" },
            },
          },
        },
        required: ["action", "text", "when"],
      },
    },
  },
  required: ["rules", "topics", "notes"],
};

const COMPILE_PROMPT = `You convert a person's plain-English rules for their YouTube feed into structured filters.

"when" fields (all optional; ALL present fields must hold for the rule to match):
- is_short: YouTube Shorts. is_live: live streams.
- min_minutes / max_minutes: video length. max_age_days / min_age_days: upload age.
- channels: channel names (substring match). keywords: words in title, tags or description (substring match).
- about: short topic, style or quality descriptions judged by an AI from the title, channel and description; matches if ANY applies. Use it for themes ("politics", "video games"), styles ("reaction video", "prank") and qualities ("clickbait title", "rage bait").
"schedule" (optional; the rule applies only then): days, and from / to as 24-hour "HH:MM" local time.

Actions: "block" hides matches. "allow_only" means only matching videos may show (several allow_only rules combine with OR). "boost" / "demote" change ranking.
For EVERY distinct "about" description you use, add an entry to "topics" with that exact text as "name" and 6-8 "examples": short phrases that look like real YouTube video titles on that topic, covering its typical variety (for "politics": "senate passes budget bill", "election debate highlights", "president's speech on immigration"). A small on-device model compares videos with these examples, so make them concrete and varied, not definitions.

Write "text" as a short plain restatement of the rule. Keep "about" descriptions short and specific, one rule per idea, and ignore anything that is not about which videos to show. Put anything you could not express in "notes" (else an empty string).

Example: "No shorts. Only coding or maths videos on weekdays 9 to 5. Less gaming." gives a block rule {is_short: true}; an allow_only rule {about: ["programming", "mathematics"]} with schedule {days: [mon..fri], from: "09:00", to: "17:00"}; and a demote rule {about: ["video games"]}.`;

const versionOf = (name) => (name.match(/(\d+(?:\.\d+)?)/) || [0, "0"])[1].split(".").map(Number);
const newer = (a, b) => { const x = versionOf(a), y = versionOf(b); return (x[0] - y[0]) || ((x[1] || 0) - (y[1] || 0)); };

export function createGemini(key, preferredModel = "") {
  let model = preferredModel.replace(/^models\//, "");

  async function call(path, init) {
    const res = await fetch(BASE + path + (path.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(key), init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || "";
      if (res.status === 429) throw new GeminiError("Gemini’s free rate limit was reached. Topic checks continue in a minute.", "rate");
      if (res.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(msg + JSON.stringify(body))) throw new GeminiError("Enable the “Generative Language API” for your key’s Google Cloud project, then retry.", "disabled");
      if (res.status === 403) throw new GeminiError("Your key isn’t allowed to use Gemini. Add “Generative Language API” to the key’s API restrictions.", "forbidden");
      if (res.status === 400 && /API key/i.test(msg)) throw new GeminiError("Gemini rejected the API key.", "key");
      throw new GeminiError(`Gemini returned an error (${res.status}): ${msg.slice(0, 160)}`, "api");
    }
    return body;
  }

  /** Picks the newest stable Flash-Lite model (fast and cheap), else the newest stable Flash. */
  async function getModel() {
    if (model) return model;
    const list = await call("models?pageSize=1000");
    const names = (list.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/preview|exp|tts|image|live|audio|thinking|latest|-\d{3}$/.test(n));
    const lite = names.filter((n) => /flash-lite/.test(n)).sort(newer).reverse();
    const flash = names.filter((n) => !/lite/.test(n)).sort(newer).reverse();
    model = lite[0] || flash[0];
    if (!model) throw new GeminiError("No suitable Gemini model is available for this key.", "nomodel");
    return model;
  }

  async function generateJSON(prompt, schema) {
    const m = await getModel();
    const body = await call(`models/${m}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
      }),
    });
    if (body.promptFeedback?.blockReason) throw new GeminiError("Gemini declined this request. Try rewording.", "blocked");
    const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    try { return JSON.parse(text); } catch { throw new GeminiError("Gemini’s answer couldn’t be read. Try again.", "json"); }
  }

  return {
    get model() { return model; },
    /** channels: [{id,title,description}], categories: [{id,name}] -> { [channelId]: categoryId | "" } */
    async categorizeChannels(channels, categories) {
      const ids = categories.map((c) => c.id);
      const out = {};
      for (let i = 0; i < channels.length; i += 60) {
        const batch = channels.slice(i, i + 60);
        const prompt = `Assign each YouTube channel to the one category that best fits what it mostly publishes, or "other" if none fits.

Categories:
${categories.map((c) => `${c.id}: ${c.name}`).join("\n")}

Channels (JSON):
${JSON.stringify(batch.map((c) => ({ id: c.id, title: c.title, description: (c.description || "").slice(0, 200) })))}

Return one result per channel id.`;
        const res = await generateJSON(prompt, {
          type: "OBJECT",
          properties: { results: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, category: { type: "STRING", enum: [...ids, "other"] } }, required: ["id", "category"] } } },
          required: ["results"],
        });
        for (const r of res.results || []) out[String(r.id)] = ids.includes(r.category) ? r.category : "";
      }
      return out;
    },
    compileRules(text) {
      return generateJSON(`${COMPILE_PROMPT}\n\nThe person's rules:\n"""\n${text.slice(0, 4000)}\n"""`, COMPILE_SCHEMA);
    },
    /** videos: [{id,title,channel,category,tags,description}], criteria: [string] -> { [id]: Set<criterion> } */
    async classify(videos, criteria) {
      const prompt = `For each YouTube video below, decide which of these criteria apply, judging only from its title, channel, category, tags and description.

Criteria:
${criteria.map((c, i) => `c${i + 1}: ${c}`).join("\n")}

Videos (JSON):
${JSON.stringify(videos)}

Return one result per video id, listing the codes (like "c2") of the criteria that clearly apply; an empty list if none do.`;
      const out = await generateJSON(prompt, RESPONSE_SCHEMA);
      const map = {};
      for (const r of out.results || []) {
        map[String(r.id)] = new Set((r.matches || []).map((code) => criteria[parseInt(String(code).replace(/\D/g, ""), 10) - 1]).filter(Boolean));
      }
      return map;
    },
  };
}
