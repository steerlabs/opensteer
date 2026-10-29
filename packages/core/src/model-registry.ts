/**
 * The canonical identity of a model is the lab that made it plus the lab's
 * own id for it — `openai / gpt-5.6-luna` — no matter which engine runs it or
 * which source serves it. Lab-made engines already report that pair. A
 * compatible endpoint or a gateway reports its own spelling ("openai/gpt-5.6-
 * luna", "anthropic.claude-sonnet-5-v1:0"), and this registry folds those
 * spellings back onto the canonical pair so one model is one row wherever it
 * comes from.
 */

export interface ModelReference {
  readonly modelId: string;
  readonly providerId: string;
}

/** What the product calls each lab. Anything unlisted is title-cased by callers. */
export const modelLabLabels: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  cursor: "Cursor",
  custom: "Custom",
  deepseek: "DeepSeek",
  google: "Google",
  meta: "Meta",
  minimax: "MiniMax",
  mistral: "Mistral",
  moonshot: "Moonshot",
  openai: "OpenAI",
  opencode: "OpenCode",
  qwen: "Qwen",
  xai: "Grok",
  zai: "Z.ai",
};

/**
 * How gateways and compatible endpoints spell a lab in a "vendor/model" id.
 * OpenRouter, Vercel's gateway and most proxies agree on these vendor slugs.
 */
const vendorAliases: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  deepseek: "deepseek",
  google: "google",
  "meta-llama": "meta",
  meta: "meta",
  minimax: "minimax",
  mistral: "mistral",
  mistralai: "mistral",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  openai: "openai",
  qwen: "qwen",
  "x-ai": "xai",
  xai: "xai",
  "z-ai": "zai",
  zai: "zai",
};

/**
 * Model-family prefixes that name a lab on their own, for ids that arrive
 * with no vendor at all ("gpt-5.6-luna" from a plain compatible endpoint).
 */
const familyLabs: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(gpt|o[1-9]|chatgpt|codex|text-embedding|davinci)\b/u, "openai"],
  [/^claude\b/u, "anthropic"],
  [/^(gemini|gemma)\b/u, "google"],
  [/^grok\b/u, "xai"],
  [/^(llama|muse)\b/u, "meta"],
  [/^(mistral|mixtral|codestral|magistral|devstral)\b/u, "mistral"],
  [/^deepseek\b/u, "deepseek"],
  [/^(qwen|qwq)\b/u, "qwen"],
  [/^kimi\b/u, "moonshot"],
  [/^glm\b/u, "zai"],
  [/^minimax\b/u, "minimax"],
];

/**
 * Source-specific first-party ids that do not name their maker themselves.
 * Keep this narrow: an engine can serve third-party models whose new family
 * prefix this registry does not know yet, so the source alone is not proof of
 * authorship.
 */
const sourceFamilyLabs: ReadonlyArray<readonly [sourceId: string, family: RegExp, lab: string]> = [
  ["cursor", /^(?:auto$|composer(?:$|[-_.])|cursor-grok(?:$|[-_.]))/u, "xai"],
];

/**
 * Folds one raw model id, as a source spelled it, onto its canonical pair.
 * A "vendor/model" id yields the vendor's lab; a Bedrock-style "vendor.model"
 * id likewise; a bare id is placed by its family prefix; and an id nobody
 * can place belongs to the source itself, so it still has a home rather
 * than being dropped.
 *
 * A gateway's routing suffix (":free", ":nitro") is part of the id, not a
 * decoration on it: the two spellings bill and behave differently, so
 * "openai/gpt-5.2:nitro" is its own row rather than another way of saying
 * "openai/gpt-5.2". Bedrock's "-v1:0" is folded away because it is a spelling
 * of one model, not a choice between routes.
 */
export function canonicalModelReference(rawId: string, sourceId: string): ModelReference {
  const trimmed = rawId.trim();
  const lower = trimmed.toLowerCase();
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const vendor = trimmed.slice(0, slash).toLowerCase();
    const rest = trimmed.slice(slash + 1);
    const lab = vendorAliases[vendor];
    if (lab !== undefined && rest.length > 0) return { modelId: rest, providerId: lab };
  }
  const bedrock = /^([a-z][a-z0-9-]*)\.(.+?)(?:-v\d+(?::\d+)?)?$/u.exec(trimmed);
  if (bedrock && vendorAliases[bedrock[1] ?? ""] !== undefined && bedrock[2]) {
    return { modelId: bedrock[2], providerId: vendorAliases[bedrock[1] ?? ""] ?? sourceId };
  }
  for (const [pattern, lab] of familyLabs) {
    if (pattern.test(lower)) return { modelId: trimmed, providerId: lab };
  }
  const lowerSource = sourceId.toLowerCase();
  for (const [source, pattern, lab] of sourceFamilyLabs) {
    if (lowerSource === source && pattern.test(lower)) {
      return { modelId: trimmed, providerId: lab };
    }
  }
  return { modelId: trimmed, providerId: sourceId };
}

/**
 * A gateway route suffix — the ":nitro" in "gpt-5.2:nitro". Only a word-shaped
 * one, so Bedrock's numeric ":0" is left inside the id where it belongs.
 */
const routeSuffix = /^(.+):([a-z][a-z0-9-]*)$/u;

/**
 * A readable name for a model that arrived without one: family names the
 * labs capitalise ("GPT", "Claude") get their capitals, the rest of the id
 * is title-cased segment by segment, version numbers stay as written, and a
 * route suffix is set apart in parentheses because it names how the model is
 * served rather than part of what it is called.
 */
export function modelDisplayName(modelId: string): string {
  const suffix = routeSuffix.exec(modelId);
  if (suffix?.[1] && suffix[2]) return `${modelDisplayName(suffix[1])} (${suffix[2]})`;
  const capitalised: Readonly<Record<string, string>> = {
    chatgpt: "ChatGPT",
    deepseek: "DeepSeek",
    glm: "GLM",
    gpt: "GPT",
    qwq: "QwQ",
  };
  return modelId
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((segment) => {
      const lower = segment.toLowerCase();
      if (capitalised[lower] !== undefined) return capitalised[lower];
      if (/^o[1-9]/u.test(lower)) return lower;
      if (/^\d/u.test(segment)) return segment;
      return `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`;
    })
    .join(" ");
}
