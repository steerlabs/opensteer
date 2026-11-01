import type { ModelReference } from "./model-registry.js";

export const modelEffortTiers = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ModelEffortTier = (typeof modelEffortTiers)[number];

export interface ChatModelPreference extends ModelReference {
  readonly effort: ModelEffortTier | "default" | "highest";
}

/** Chat's defaults, best first. Tasks keep using the person's execution history. */
export const chatModelPreferences: readonly ChatModelPreference[] = [
  { providerId: "openai", modelId: "gpt-6.1-terra", effort: "high" },
  { providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "medium" },
  { providerId: "xai", modelId: "grok-4.7", effort: "highest" },
  { providerId: "deepseek", modelId: "deepseek-v4-pro", effort: "high" },
  { providerId: "meta", modelId: "muse-spark-1.3", effort: "default" },
  { providerId: "google", modelId: "gemini-3.1-pro", effort: "default" },
];
