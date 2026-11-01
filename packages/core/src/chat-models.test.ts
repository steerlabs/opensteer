import { describe, expect, it } from "vitest";
import { chatModelPreferences } from "./chat-models.js";

describe("chatModelPreferences", () => {
  it("keeps Chat's model and effort order explicit", () => {
    expect(chatModelPreferences).toEqual([
      { providerId: "openai", modelId: "gpt-6.1-terra", effort: "high" },
      { providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "medium" },
      { providerId: "xai", modelId: "grok-4.7", effort: "highest" },
      { providerId: "deepseek", modelId: "deepseek-v4-pro", effort: "high" },
      { providerId: "meta", modelId: "muse-spark-1.3", effort: "default" },
      { providerId: "google", modelId: "gemini-3.1-pro", effort: "default" },
    ]);
  });
});
