import { describe, expect, it } from "vitest";
import { canonicalModelReference, modelDisplayName } from "./model-registry.js";

describe("canonicalModelReference", () => {
  it("folds gateway vendor prefixes onto the lab", () => {
    expect(canonicalModelReference("openai/gpt-5.6-luna", "openrouter")).toEqual({
      modelId: "gpt-5.6-luna",
      providerId: "openai",
    });
    expect(canonicalModelReference("meta-llama/llama-4-maverick", "openrouter")).toEqual({
      modelId: "llama-4-maverick",
      providerId: "meta",
    });
    expect(canonicalModelReference("x-ai/grok-4", "openrouter")).toEqual({
      modelId: "grok-4",
      providerId: "xai",
    });
  });

  it("keeps a gateway route suffix, because it is a different way to be served", () => {
    expect(canonicalModelReference("meta-llama/llama-4-maverick:free", "openrouter")).toEqual({
      modelId: "llama-4-maverick:free",
      providerId: "meta",
    });
    expect(canonicalModelReference("openai/gpt-5.2:nitro", "openrouter")).toEqual({
      modelId: "gpt-5.2:nitro",
      providerId: "openai",
    });
    expect(canonicalModelReference("gpt-5.2:online", "my-proxy")).toEqual({
      modelId: "gpt-5.2:online",
      providerId: "openai",
    });
  });

  it("folds Bedrock-style ids onto the lab", () => {
    expect(canonicalModelReference("anthropic.claude-sonnet-5-v1:0", "bedrock")).toEqual({
      modelId: "claude-sonnet-5",
      providerId: "anthropic",
    });
  });

  it("places the families the new engines serve", () => {
    // OpenCode and Pi both offer MiniMax as a gateway source. Cursor's own
    // model families are grouped with Grok while retaining Cursor's native id.
    expect(canonicalModelReference("minimax/minimax-m2", "openrouter")).toEqual({
      modelId: "minimax-m2",
      providerId: "minimax",
    });
    expect(canonicalModelReference("MiniMax-M2", "opencode")).toEqual({
      modelId: "MiniMax-M2",
      providerId: "minimax",
    });
    expect(canonicalModelReference("composer-1", "cursor")).toEqual({
      modelId: "composer-1",
      providerId: "xai",
    });
    expect(canonicalModelReference("cursor-grok-4.6", "cursor")).toEqual({
      modelId: "cursor-grok-4.6",
      providerId: "xai",
    });
    expect(canonicalModelReference("auto", "cursor")).toEqual({
      modelId: "auto",
      providerId: "xai",
    });
    expect(canonicalModelReference("gemini-3.1-pro", "cursor")).toEqual({
      modelId: "gemini-3.1-pro",
      providerId: "google",
    });
    expect(canonicalModelReference("muse-spark-1.3", "cursor")).toEqual({
      modelId: "muse-spark-1.3",
      providerId: "meta",
    });
  });

  it("does not claim another source's similarly named model", () => {
    expect(canonicalModelReference("auto", "custom-endpoint")).toEqual({
      modelId: "auto",
      providerId: "custom-endpoint",
    });
    expect(canonicalModelReference("composer-local", "ollama")).toEqual({
      modelId: "composer-local",
      providerId: "ollama",
    });
    expect(canonicalModelReference("future-provider-model", "cursor")).toEqual({
      modelId: "future-provider-model",
      providerId: "cursor",
    });
  });

  it("places a bare id by its family and keeps the id as written", () => {
    expect(canonicalModelReference("gpt-5.6-luna", "my-proxy")).toEqual({
      modelId: "gpt-5.6-luna",
      providerId: "openai",
    });
    expect(canonicalModelReference("claude-opus-5", "my-proxy")).toEqual({
      modelId: "claude-opus-5",
      providerId: "anthropic",
    });
    expect(canonicalModelReference("o4-mini", "my-proxy").providerId).toBe("openai");
  });

  it("gives an id nobody can place to the source itself", () => {
    expect(canonicalModelReference("mythical-7b", "local-ollama")).toEqual({
      modelId: "mythical-7b",
      providerId: "local-ollama",
    });
    expect(canonicalModelReference("unknownvendor/thing", "gw")).toEqual({
      modelId: "unknownvendor/thing",
      providerId: "gw",
    });
  });
});

describe("modelDisplayName", () => {
  it("names families the way the labs write them", () => {
    expect(modelDisplayName("gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(modelDisplayName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelDisplayName("o4-mini")).toBe("o4 Mini");
    expect(modelDisplayName("deepseek-r1")).toBe("DeepSeek R1");
  });

  it("sets a route suffix apart and leaves a Bedrock version alone", () => {
    expect(modelDisplayName("gpt-5.2:nitro")).toBe("GPT 5.2 (nitro)");
    expect(modelDisplayName("llama-4-maverick:free")).toBe("Llama 4 Maverick (free)");
    expect(modelDisplayName("claude-sonnet-5-v1:0")).toBe("Claude Sonnet 5 V1:0");
  });
});
