import {
  OpensteerError,
  type HarnessInstanceStateKind,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { HarnessSetupMethod, HarnessSourceDescriptor } from "@opensteer/harness";

/**
 * How a Pi account's credential is established. Pi stores both kinds in the
 * same `auth.json` record, keyed by provider id (pi-facts §4): an API key as
 * `{"type":"api_key","key":…}`, a device-code sign-in as
 * `{"type":"oauth","access":…,"refresh":…,"expires":…}`.
 */
export type PiCredentialKind = "api-key" | "device-code";

/**
 * One row of the source table. The whole of P1 is data: the driver has one code
 * path per credential kind and reads everything else out of here.
 *
 * `provider` is Pi's own provider id — the key `auth.json` is written under,
 * the value `set_model` takes, and the field `get_available_models` entries
 * carry. It equals `sourceId` for every real provider, which is what X5 asks
 * for; only the compatible endpoint differs, because the provider there is one
 * Opensteer declares in `models.json` rather than one Pi ships.
 */
export interface PiSourceRow {
  /** The key this source's credential occupies in `auth.json`. */
  readonly authKey: string;
  readonly billingLabel?: string;
  readonly credentials: readonly PiCredentialKind[];
  readonly detail: string;
  readonly kind: HarnessSourceDescriptor["kind"];
  readonly label: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly stateKinds: readonly HarnessInstanceStateKind[];
}

/** The source a user-typed base URL is driven through, and its `models.json` provider id. */
export const piCompatibleSourceId = "openai-compatible";
export const piCompatibleProviderId = "opensteer";

/**
 * Both credential kinds are offered on a row that supports both, exactly as
 * Codex's OpenAI source offers the ChatGPT device flow beside an API key. Pi
 * gives a person's own `~/.pi/agent` (`ambient`) and an Opensteer-held
 * credential (`isolated`) the same reading path, so every row carries both
 * state kinds; only the compatible endpoint is isolated-only, because it needs
 * Opensteer to write a `models.json` provider that the person's own home must
 * not gain.
 *
 * Anthropic's Claude Pro/Max and OpenRouter's OAuth are deliberately absent:
 * both bind a local callback port even on the paste-the-code path (pi-facts §4),
 * so neither can be completed by a Runner. Amazon Bedrock is absent because its
 * only credential is the machine's AWS environment, and this driver never puts
 * a credential in a process environment.
 */
const ambientAndIsolated: readonly HarnessInstanceStateKind[] = ["ambient", "isolated"];

export const piSourceTable: readonly PiSourceRow[] = [
  {
    authKey: "openai",
    credentials: ["api-key"],
    detail: "An OpenAI API key, billed to your OpenAI account.",
    kind: "first-party",
    label: "OpenAI",
    provider: "openai",
    sourceId: "openai",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "anthropic",
    credentials: ["api-key"],
    detail: "An Anthropic API key, billed to your Anthropic account.",
    kind: "first-party",
    label: "Anthropic",
    provider: "anthropic",
    sourceId: "anthropic",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "google",
    credentials: ["api-key"],
    detail: "A Google AI Studio API key for the Gemini models.",
    kind: "first-party",
    label: "Google",
    provider: "google",
    sourceId: "google",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "xai",
    credentials: ["api-key", "device-code"],
    detail: "The Grok models, from an xAI API key or an xAI sign-in on another device.",
    kind: "first-party",
    label: "xAI",
    provider: "xai",
    sourceId: "xai",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "groq",
    credentials: ["api-key"],
    detail: "A Groq API key for the models Groq serves.",
    kind: "first-party",
    label: "Groq",
    provider: "groq",
    sourceId: "groq",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "deepseek",
    credentials: ["api-key"],
    detail: "A DeepSeek API key, billed to your DeepSeek account.",
    kind: "first-party",
    label: "DeepSeek",
    provider: "deepseek",
    sourceId: "deepseek",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "mistral",
    credentials: ["api-key"],
    detail: "A Mistral API key, billed to your Mistral account.",
    kind: "first-party",
    label: "Mistral",
    provider: "mistral",
    sourceId: "mistral",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "moonshotai",
    credentials: ["api-key"],
    detail: "A Moonshot API key for the Kimi models.",
    kind: "first-party",
    label: "Moonshot",
    provider: "moonshotai",
    sourceId: "moonshotai",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "openai-codex",
    billingLabel: "ChatGPT plan",
    credentials: ["device-code"],
    detail: "Your ChatGPT plan, signed in on another device with a code.",
    kind: "first-party",
    label: "ChatGPT plan",
    provider: "openai-codex",
    sourceId: "openai-codex",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "openrouter",
    credentials: ["api-key"],
    detail: "OpenRouter routes one key to models from many labs and bills you for all of them.",
    kind: "gateway",
    label: "OpenRouter",
    provider: "openrouter",
    sourceId: "openrouter",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "opencode",
    credentials: ["api-key"],
    detail: "OpenCode Zen serves models from several labs on one OpenCode key.",
    kind: "gateway",
    label: "OpenCode Zen",
    provider: "opencode",
    sourceId: "opencode",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "opencode-go",
    billingLabel: "OpenCode Go",
    credentials: ["api-key"],
    detail: "An OpenCode Go plan, which includes the models on its own list.",
    kind: "gateway",
    label: "OpenCode Go",
    provider: "opencode-go",
    sourceId: "opencode-go",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "github-copilot",
    billingLabel: "Copilot",
    credentials: ["device-code"],
    detail: "Your GitHub Copilot plan, signed in on another device with a code.",
    kind: "gateway",
    label: "GitHub Copilot",
    provider: "github-copilot",
    sourceId: "github-copilot",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "zai",
    credentials: ["api-key"],
    detail: "A Z.ai coding plan key for the GLM models.",
    kind: "gateway",
    label: "Z.ai coding plan",
    provider: "zai",
    sourceId: "zai",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "kimi-coding",
    credentials: ["api-key", "device-code"],
    detail: "A Kimi for coding plan, from a Moonshot key or a sign-in on another device.",
    kind: "gateway",
    label: "Kimi for coding",
    provider: "kimi-coding",
    sourceId: "kimi-coding",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "minimax",
    credentials: ["api-key"],
    detail: "A MiniMax API key for the MiniMax models.",
    kind: "gateway",
    label: "MiniMax",
    provider: "minimax",
    sourceId: "minimax",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: "vercel-ai-gateway",
    credentials: ["api-key"],
    detail: "Vercel's AI Gateway routes one key to models from many labs.",
    kind: "gateway",
    label: "Vercel AI Gateway",
    provider: "vercel-ai-gateway",
    sourceId: "vercel-ai-gateway",
    stateKinds: ambientAndIsolated,
  },
  {
    authKey: piCompatibleProviderId,
    credentials: ["api-key"],
    detail: "Ollama, LM Studio, oMLX, or any server with an OpenAI-compatible API.",
    kind: "compatible-endpoint",
    label: "Model server",
    provider: piCompatibleProviderId,
    sourceId: piCompatibleSourceId,
    stateKinds: ["isolated"],
  },
] as const satisfies readonly PiSourceRow[];

/**
 * Pi reads no plan window for any of these providers, so no source claims one
 * rather than showing a bar the engine cannot fill (X5).
 */
export const piSources: readonly HarnessSourceDescriptor[] = piSourceTable.map((row) => ({
  detail: row.detail,
  fields:
    row.sourceId === piCompatibleSourceId
      ? [
          {
            id: "runtime",
            kind: "select" as const,
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
            detail: "Must serve Chat Completions; Pi talks to it as `openai-completions`.",
            id: "baseUrl",
            kind: "url" as const,
            label: "Base URL",
            placeholder: "https://openrouter.ai/api/v1",
          },
        ]
      : [],
  kind: row.kind,
  label: row.label,
  ...(row.sourceId === piCompatibleSourceId ? { modelSettings: true } : {}),
  quota: "none" as const,
  sourceId: row.sourceId,
  stateKinds: row.stateKinds,
}));

export function piSourceRow(sourceId: string): PiSourceRow {
  const row = piSourceTable.find((candidate) => candidate.sourceId === sourceId);
  if (!row) {
    throw new OpensteerError({ code: "bad_request", message: `Unknown Pi source ${sourceId}` });
  }
  return row;
}

export const piApiKeySetupMethodId = "pi-api-key";
export const piDeviceCodeSetupMethodId = "pi-device-code";

/**
 * What an account of this source can be set up with. Both kinds write into the
 * profile's own `auth.json`, so both need an isolated profile: an ambient
 * profile is the person's own Pi home and Opensteer never writes a Deployment's
 * credential into it.
 */
export function piSetupMethods(row: PiSourceRow): readonly HarnessSetupMethod[] {
  return row.credentials.map((credential) =>
    credential === "api-key"
      ? {
          connectionSlot: "primary",
          detail: `Store a ${row.label} API key in this profile's private Pi credential file.`,
          inputLabel: `${row.label} API key`,
          kind: "secret-input" as const,
          label: `${row.label} API key`,
          methodId: piApiKeySetupMethodId,
        }
      : {
          connectionSlot: "primary",
          detail: `Sign in to ${row.label} on another device with a code.`,
          kind: "device-code" as const,
          label: `${row.label} sign-in`,
          methodId: piDeviceCodeSetupMethodId,
        },
  );
}

/** Pi's execution tools. Both are gated wherever commands are gated; Windows uses `powershell`. */
export const piCommandTools: readonly string[] = ["bash", "powershell"];
/** Pi's file-mutating tools (`src/core/tools/index.ts:95-105`). */
export const piFileChangeTools: readonly string[] = ["edit", "write"];
/** Pi's read-only tools. They never open a Request in any mode. */
export const piReadOnlyTools: readonly string[] = ["read", "grep", "find", "ls"];

export interface PiAccessModeGate {
  /** Tools whose call opens a command approval before Pi may run them. */
  readonly commandTools: readonly string[];
  /** Tools whose call opens a file-change approval before Pi may run them. */
  readonly fileChangeTools: readonly string[];
}

/**
 * The whole of Pi's access enforcement, as one explicit table.
 *
 * Pi has no permission system at all — `docs/security.md:31-37` says so
 * outright, and the only interception point in the engine is an extension's
 * `tool_call` handler (pi-facts §6). So a mode Opensteer declares is exactly a
 * set of tool names the Opensteer extension stops on, and the driver declares
 * only the three modes that set can express. "auto" is not declared: it needs a
 * routine/non-routine judgement Pi cannot make, and this driver never
 * approximates one. It is still answered here, with the strictest gate, so a
 * mode that somehow reached the driver fails closed rather than silently
 * running unattended.
 */
export function piAccessModeGate(accessMode: ThreadAccessMode): PiAccessModeGate {
  switch (accessMode) {
    case "approval-required":
    case "auto":
      return { commandTools: piCommandTools, fileChangeTools: piFileChangeTools };
    case "auto-accept-edits":
      return { commandTools: piCommandTools, fileChangeTools: [] };
    case "full-access":
      return { commandTools: [], fileChangeTools: [] };
  }
}

/** The modes Pi's one gate can actually enforce. */
export const piAccessModes = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies readonly ThreadAccessMode[];
