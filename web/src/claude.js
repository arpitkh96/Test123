// Claude calls made from the browser with the user's own API key (stored only in this browser).
import Anthropic from "@anthropic-ai/sdk";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (default, most capable)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
];

const COMPILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rules", "notes"],
  properties: {
    notes: { type: "string" },
    rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "text", "when"],
        properties: {
          action: { type: "string", enum: ["block", "allow_only", "boost", "demote"] },
          text: { type: "string" },
          when: {
            type: "object",
            additionalProperties: false,
            properties: {
              is_short: { type: "boolean" },
              is_live: { type: "boolean" },
              min_minutes: { type: "number" },
              max_minutes: { type: "number" },
              max_age_days: { type: "number" },
              min_age_days: { type: "number" },
              channels: { type: "array", items: { type: "string" } },
              keywords: { type: "array", items: { type: "string" } },
              about: { type: "array", items: { type: "string" } },
            },
          },
          schedule: {
            type: "object",
            additionalProperties: false,
            properties: {
              days: { type: "array", items: { type: "string", enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] } },
              from: { type: "string" },
              to: { type: "string" },
            },
          },
        },
      },
    },
  },
};

const COMPILE_PROMPT = `You convert a person's plain-English rules for their YouTube feed into structured filters.

"when" fields (all optional; ALL present fields must hold for the rule to match):
- is_short: YouTube Shorts. is_live: live streams.
- min_minutes / max_minutes: video length. max_age_days / min_age_days: upload age.
- channels: channel names (substring match). keywords: words in title, tags or description (substring match).
- about: short topic, style or quality descriptions judged by an AI from the title, channel and description; matches if ANY applies. Use it for themes ("politics", "video games"), styles ("reaction video", "prank") and qualities ("clickbait title", "rage bait").
"schedule" (optional; the rule applies only then): days, and from / to as 24-hour "HH:MM" local time.

Actions: "block" hides matches. "allow_only" means only matching videos may show (several allow_only rules combine with OR). "boost" / "demote" change ranking.
Write "text" as a short plain restatement of the rule. Keep "about" descriptions short and specific, one rule per idea, and ignore anything that is not about which videos to show. Put anything you could not express in "notes" (else an empty string).

Example: "No shorts. Only coding or maths videos on weekdays 9 to 5. Less gaming." gives a block rule {is_short: true}; an allow_only rule {about: ["programming", "mathematics"]} with schedule {days: [mon..fri], from: "09:00", to: "17:00"}; and a demote rule {about: ["video games"]}.`;

export class ClaudeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function createClaude({ apiKey, model }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const useFallbacks = model !== "claude-haiku-5-5"; // server-side fallbacks are not offered for Haiku

  async function askJSON(prompt, schema, effort, maxTokens) {
    let response;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        output_config: { effort, format: { type: "json_schema", schema } },
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
        messages: [{ role: "user", content: prompt }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new ClaudeError("Claude rejected the API key. Check it in Settings.", "auth");
      if (error instanceof Anthropic.PermissionDeniedError) throw new ClaudeError("This API key can’t use the selected model. Pick another model in Settings.", "permission");
      if (error instanceof Anthropic.RateLimitError) throw new ClaudeError("Claude is rate limiting this key. Try again in a minute.", "rate");
      if (error instanceof Anthropic.BadRequestError) throw new ClaudeError("Claude couldn’t process this request: " + error.message, "bad");
      if (error instanceof Anthropic.APIError) throw new ClaudeError(`Claude returned an error (${error.status ?? "network"}). Try again.`, "api");
      throw new ClaudeError("Couldn’t reach Claude. Check your connection.", "network");
    }
    if (response.stop_reason === "refusal") throw new ClaudeError("Claude declined this request. Try rewording your rules.", "refusal");
    if (response.stop_reason === "max_tokens") throw new ClaudeError("Claude’s answer was cut off. Try fewer rules at once.", "truncated");
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    try { return JSON.parse(text); } catch { throw new ClaudeError("Claude’s answer couldn’t be read. Try again.", "json"); }
  }

  return {
    compileRules(text) {
      return askJSON(`${COMPILE_PROMPT}\n\nThe person's rules:\n"""\n${text.slice(0, 4000)}\n"""`, COMPILE_SCHEMA, "medium", 16000);
    },
  };
}
