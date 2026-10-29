import type { HarnessSourceDescriptor, HarnessSetupMethod } from "@opensteer/harness";

/** OpenCode Zen, OpenCode's own gateway. Its free models answer with no credential at all. */
export const opencodeZenSourceId = "opencode";
/** Any endpoint that speaks the OpenAI Chat Completions API, declared as a custom provider. */
export const opencodeCompatibleSourceId = "openai-compatible";

/**
 * The provider id a compatible endpoint is declared under in OpenCode's own
 * configuration. It is a provider name, never an MCP server name, so it does
 * not collide with the `opensteer` MCP server the same configuration declares.
 */
export const opencodeCompatibleProviderId = "opensteer";

/**
 * Every source this engine can be pointed at, as one table.
 *
 * All of them are API keys. OpenCode's OAuth flows are unreachable from a
 * Runner in 1.18.31: `POST /provider/{id}/oauth/authorize` fails with an
 * internal TypeError for every provider, and `opencode auth login` is a TUI
 * that reads the key from raw keystrokes (opencode-facts §5). `github-copilot`
 * is therefore not offered at all — it has no key path — and `amazon-bedrock`
 * is not offered because it needs the machine's ambient AWS identity while
 * every OpenCode account here holds its own isolated home.
 *
 * Every source declares `quota: "none"`: OpenCode has no usage, quota, or
 * identity API of any kind (opencode-facts §5), so a usage bar would be
 * invented rather than reported.
 */
const keySourceDetail = "Opensteer signs OpenCode in with an API key.";

export const opencodeSources: readonly HarnessSourceDescriptor[] = [
  {
    detail:
      "OpenCode's own model gateway. Its free models run with no credential; add a Zen API key for the rest.",
    fields: [],
    kind: "gateway",
    label: "OpenCode Zen",
    quota: "none",
    sourceId: opencodeZenSourceId,
    stateKinds: ["isolated"],
  },
  {
    detail: `The OpenCode Go plan, billed by OpenCode. ${keySourceDetail}`,
    fields: [],
    kind: "gateway",
    label: "OpenCode Go",
    quota: "none",
    sourceId: "opencode-go",
    stateKinds: ["isolated"],
  },
  {
    detail: `OpenAI's own API. ${keySourceDetail}`,
    fields: [],
    kind: "first-party",
    label: "OpenAI",
    quota: "none",
    sourceId: "openai",
    stateKinds: ["isolated"],
  },
  {
    detail: `Anthropic's own API. ${keySourceDetail}`,
    fields: [],
    kind: "first-party",
    label: "Anthropic",
    quota: "none",
    sourceId: "anthropic",
    stateKinds: ["isolated"],
  },
  {
    detail: `Google's Gemini API. ${keySourceDetail}`,
    fields: [],
    kind: "first-party",
    label: "Google",
    quota: "none",
    sourceId: "google",
    stateKinds: ["isolated"],
  },
  {
    detail: `xAI's own API. ${keySourceDetail}`,
    fields: [],
    kind: "first-party",
    label: "xAI",
    quota: "none",
    sourceId: "xai",
    stateKinds: ["isolated"],
  },
  {
    detail: `OpenRouter, which serves many labs' models on one key. ${keySourceDetail}`,
    fields: [],
    kind: "gateway",
    label: "OpenRouter",
    quota: "none",
    sourceId: "openrouter",
    stateKinds: ["isolated"],
  },
  {
    detail: `Groq's inference API. ${keySourceDetail}`,
    fields: [],
    kind: "first-party",
    label: "Groq",
    quota: "none",
    sourceId: "groq",
    stateKinds: ["isolated"],
  },
  {
    detail: `DeepSeek's own API. ${keySourceDetail}`,
    fields: [],
    kind: "first-party",
    label: "DeepSeek",
    quota: "none",
    sourceId: "deepseek",
    stateKinds: ["isolated"],
  },
  {
    detail: `Mistral's own API. ${keySourceDetail}`,
    fields: [],
    kind: "first-party",
    label: "Mistral",
    quota: "none",
    sourceId: "mistral",
    stateKinds: ["isolated"],
  },
  {
    detail: `Vercel's AI Gateway, which serves many labs' models on one key. ${keySourceDetail}`,
    fields: [],
    kind: "gateway",
    label: "Vercel AI Gateway",
    quota: "none",
    sourceId: "vercel",
    stateKinds: ["isolated"],
  },
  {
    detail: `Z.ai's coding plan. ${keySourceDetail}`,
    fields: [],
    kind: "gateway",
    label: "Z.ai",
    quota: "none",
    sourceId: "zai",
    stateKinds: ["isolated"],
  },
  {
    detail: `Moonshot's Kimi API. ${keySourceDetail}`,
    fields: [],
    kind: "first-party",
    label: "Moonshot",
    quota: "none",
    sourceId: "moonshotai",
    stateKinds: ["isolated"],
  },
  {
    detail: `MiniMax's own API. ${keySourceDetail}`,
    fields: [],
    kind: "gateway",
    label: "MiniMax",
    quota: "none",
    sourceId: "minimax",
    stateKinds: ["isolated"],
  },
  {
    detail: "Ollama, LM Studio, oMLX, or any server with an OpenAI-compatible API.",
    fields: [
      {
        id: "runtime",
        kind: "select",
        label: "Runtime",
        defaultValue: "generic",
        options: [
          { value: "generic", label: "Other" },
          { value: "ollama", label: "Ollama" },
          { value: "lmstudio", label: "LM Studio" },
          { value: "omlx", label: "oMLX" },
        ],
      },
      {
        detail: "Must serve OpenAI's Chat Completions API and list its models at /models.",
        id: "baseUrl",
        kind: "url",
        label: "Base URL",
        placeholder: "http://127.0.0.1:11434/v1",
      },
    ],
    kind: "compatible-endpoint",
    label: "Model server",
    modelSettings: true,
    quota: "none",
    sourceId: opencodeCompatibleSourceId,
    stateKinds: ["isolated"],
  },
] as const satisfies readonly HarnessSourceDescriptor[];

export const opencodeApiKeySetupMethodId = "opencode-api-key";

export function opencodeSetupMethods(sourceId: string): readonly HarnessSetupMethod[] {
  const source = opencodeSources.find((candidate) => candidate.sourceId === sourceId);
  return [
    {
      connectionSlot: "primary",
      detail: "Stored in this account's own private OpenCode credential file.",
      inputLabel: `${source?.label ?? "Provider"} API key`,
      kind: "secret-input",
      label: "API key",
      methodId: opencodeApiKeySetupMethodId,
    },
  ];
}

export function opencodeSource(sourceId: string): HarnessSourceDescriptor | undefined {
  return opencodeSources.find((candidate) => candidate.sourceId === sourceId);
}

/**
 * Which OpenCode provider an account's Runs are pinned to. Every source names a
 * real OpenCode provider except the compatible endpoint, which is declared in
 * the configuration under a provider id of this driver's own choosing.
 */
export function opencodeProviderId(sourceId: string): string {
  return sourceId === opencodeCompatibleSourceId ? opencodeCompatibleProviderId : sourceId;
}
