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

  return {
    get model() { return model; },
    /** videos: [{id,title,channel,category,tags,description}], criteria: [string] -> { [id]: Set<criterion> } */
    async classify(videos, criteria) {
      const m = await getModel();
      const prompt = `For each YouTube video below, decide which of these criteria apply, judging only from its title, channel, category, tags and description.

Criteria:
${criteria.map((c, i) => `c${i + 1}: ${c}`).join("\n")}

Videos (JSON):
${JSON.stringify(videos)}

Return one result per video id, listing the codes (like "c2") of the criteria that clearly apply; an empty list if none do.`;
      const body = await call(`models/${m}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0 },
        }),
      });
      const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      let out;
      try { out = JSON.parse(text); } catch { throw new GeminiError("Gemini’s answer couldn’t be read.", "json"); }
      const map = {};
      for (const r of out.results || []) {
        map[String(r.id)] = new Set((r.matches || []).map((code) => criteria[parseInt(String(code).replace(/\D/g, ""), 10) - 1]).filter(Boolean));
      }
      return map;
    },
  };
}
