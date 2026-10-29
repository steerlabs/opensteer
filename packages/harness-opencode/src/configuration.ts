import type { ThreadAccessMode, ToolIdentity } from "@opensteer/core";
import { compatibleEndpointHost, opensteerToolIdentity } from "@opensteer/harness";
import { opencodeCompatibleProviderId, opencodeCompatibleSourceId } from "./sources.js";

/** The two Opensteer MCP servers, named as OpenCode will name them in tool ids. */
export const opencodeAgentToolsServer = "opensteer";
export const opencodeIntegrationToolsServer = "opensteer_integrations";

/** OpenCode's own tool ids, reported under the engine's namespace. */
const opencodeToolNamespace = "opencode";

/**
 * OpenCode flattens an MCP tool to `<server>_<tool>` — verified live:
 * a server named `opensteer` offering `thread_read` reached the model as
 * `opensteer_thread_read`. Splitting on the first `_` would read
 * `opensteer_integrations_integration_call` as server `opensteer`, so the two
 * server names are matched longest first. That is unambiguous for exactly these
 * two names, because no agent tool name begins with `integrations_`; the test
 * asserts that over the real tool lists rather than trusting the claim.
 */
export function opencodeToolIdentity(flatToolId: string): ToolIdentity {
  for (const server of [opencodeIntegrationToolsServer, opencodeAgentToolsServer]) {
    const prefix = `${server}_`;
    if (flatToolId.startsWith(prefix) && flatToolId.length > prefix.length) {
      return opensteerToolIdentity(server, flatToolId.slice(prefix.length));
    }
  }
  return { name: flatToolId, namespace: opencodeToolNamespace };
}

export type OpencodePermissionAction = "allow" | "ask" | "deny";

/**
 * OpenCode's `permission` map, in insertion order.
 *
 * Order is the whole mechanism: OpenCode appends the configured rules to the
 * agent's built-in ruleset and evaluates the **last** matching rule, so the
 * broad `"*"` entry comes first and every narrower key after it wins. Verified
 * on 1.18.31 by reading `GET /agent` back and by watching an unlisted tool
 * (`webfetch`) ask while a listed one (`opensteer_thread_read`) did not.
 */
export type OpencodePermissionConfiguration = Readonly<
  Record<string, OpencodePermissionAction | Readonly<Record<string, OpencodePermissionAction>>>
>;

/**
 * OpenCode's built-in tool ids that never touch anything outside the model's
 * own reading of the Workspace. They are allowed in every mode so an approval
 * prompt means something.
 */
const opencodeReadOnlyTools = [
  "read",
  "glob",
  "grep",
  "list",
  "todowrite",
  "lsp",
  "skill",
  "question",
] as const;

/**
 * OpenCode's built-in tool ids that act: they write, run commands or reach the
 * network. Each mode states an action for every one of them, so a
 * tool OpenCode adds later is caught by the `"*"` entry rather than inheriting
 * an allowance nobody chose.
 */
const opencodeActingTools = [
  "edit",
  "bash",
  "webfetch",
  "websearch",
  "external_directory",
  "doom_loop",
] as const;

/**
 * How one `ThreadAccessMode` becomes OpenCode's `permission` configuration.
 *
 * `auto` is deliberately absent from this table and from the driver's declared
 * access modes: it means "approve routine actions and ask about the rest", and
 * OpenCode has no routine/non-routine judgement to make that distinction with
 * — its rules are per tool and per glob only.
 *
 * Opensteer's own tools are approved without a prompt in every mode, which is
 * why their flat ids are passed in and listed explicitly rather than left to
 * the `"*"` entry.
 */
export function opencodeAccessModeConfiguration(
  accessMode: ThreadAccessMode,
  openSteerToolIds: readonly string[] = [],
): OpencodePermissionConfiguration {
  const fallback: OpencodePermissionAction = accessMode === "full-access" ? "allow" : "ask";
  const acting: OpencodePermissionAction = accessMode === "full-access" ? "allow" : "ask";
  const permission: Record<
    string,
    OpencodePermissionAction | Readonly<Record<string, OpencodePermissionAction>>
  > = { "*": fallback };
  for (const tool of opencodeReadOnlyTools) permission[tool] = "allow";
  for (const tool of openSteerToolIds) permission[tool] = "allow";
  for (const tool of opencodeActingTools) permission[tool] = acting;
  // Only OpenCode's own subagents, by name: an agent defined anywhere else
  // could carry rules of its own. Each runs under this same table, so a
  // subagent can never do more than the Run may, and asks as the Run does.
  permission.task = { "*": "deny", explore: "allow", general: "allow" };
  // The one difference between the two gated modes: edits inside the Workspace
  // are pre-approved, while commands and the network still ask.
  if (accessMode === "auto-accept-edits") permission.edit = "allow";
  return Object.freeze(permission);
}

export interface OpencodeMcpServerPlan {
  readonly token: string;
  readonly url: string;
}

export interface OpencodeSessionConfigurationInput {
  readonly accessMode: ThreadAccessMode;
  readonly agentTools: OpencodeMcpServerPlan;
  readonly baseUrl: string | undefined;
  readonly instructionsFile: string;
  readonly integrationTools: OpencodeMcpServerPlan;
  readonly modelId: string;
  readonly modelContextWindow?: number;
  readonly modelMaxOutputTokens?: number;
  readonly modelAcceptsImages?: boolean;
  readonly openSteerToolIds: readonly string[];
  readonly providerId: string;
  readonly skillsDirectory: string;
  readonly sourceId: string;
}

/**
 * The whole `opencode.json` one session runs under.
 *
 * It is written per Thread rather than into the account's home because a
 * configuration is not hot-reloaded and two Runs of one account are two
 * servers: the model, the access mode, the instructions and the MCP tokens all
 * belong to the Run, not to the account. `OPENCODE_CONFIG_CONTENT` would carry
 * the same document in the environment, and OpenCode's `bash` tool hands the
 * server's environment to the model, so the file is the only place the MCP
 * bearer tokens can sit at 0600.
 */
export function opencodeSessionConfiguration(
  input: OpencodeSessionConfigurationInput,
): Record<string, unknown> {
  const model = `${input.providerId}/${input.modelId}`;
  return {
    $schema: "https://opencode.ai/config.json",
    // Opensteer names Threads in a separate process; the native title agent
    // would duplicate that request inside the Run's warm server.
    agent: { title: { disable: true } },
    autoupdate: false,
    // A denied tool call is reported to the model and the turn carries on, so a
    // person's "no, do it another way" is answerable rather than fatal.
    experimental: { continue_loop_on_deny: true },
    formatter: false,
    instructions: [input.instructionsFile],
    lsp: false,
    mcp: {
      [opencodeAgentToolsServer]: opencodeMcpServer(input.agentTools),
      [opencodeIntegrationToolsServer]: opencodeMcpServer(input.integrationTools),
    },
    model,
    permission: opencodeAccessModeConfiguration(input.accessMode, input.openSteerToolIds),
    ...opencodeProviderDeclaration(input),
    share: "disabled",
    skills: { paths: [input.skillsDirectory] },
    // Pinned to the same model, because OpenCode reads `small_model` verbatim
    // and an unpinned one falls back to the provider catalogue's own choice,
    // which can name another provider entirely (opencode-facts §5).
    small_model: model,
    snapshot: false,
    // A subagent never starts subagents of its own.
    subagent_depth: 1,
    ...opencodeAccountPin(input.providerId),
  };
}

/** The configuration one inspection runs under: the account's pin and nothing else. */
export function opencodeInspectionConfiguration(input: {
  readonly baseUrl: string | undefined;
  readonly modelId?: string;
  readonly modelContextWindow?: number;
  readonly modelMaxOutputTokens?: number;
  readonly modelAcceptsImages?: boolean;
  readonly providerId: string;
  readonly sourceId: string;
}): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    formatter: false,
    lsp: false,
    share: "disabled",
    snapshot: false,
    ...opencodeProviderDeclaration(input),
    ...opencodeAccountPin(input.providerId),
  };
}

/**
 * `enabled_providers` is what keeps one account's Runs on one account: with it
 * set, `GET /provider` reports that provider alone and every other provider —
 * OpenCode Zen's free tier included — disappears, so a Run cannot bill an
 * account the person did not choose.
 */
function opencodeAccountPin(providerId: string): Record<string, unknown> {
  return { enabled_providers: [providerId] };
}

/**
 * A compatible endpoint is a provider OpenCode does not know, so it is declared
 * in full. The key is deliberately absent: it lives in the account's
 * `auth.json`, which OpenCode resolves for a config-declared provider exactly
 * as for a built-in one (verified live — the endpoint received
 * `Authorization: Bearer <the stored key>`).
 */
function opencodeProviderDeclaration(input: {
  readonly baseUrl: string | undefined;
  readonly modelId?: string;
  readonly modelContextWindow?: number;
  readonly modelMaxOutputTokens?: number;
  readonly modelAcceptsImages?: boolean;
  readonly providerId: string;
  readonly sourceId: string;
}): Record<string, unknown> {
  if (input.sourceId !== opencodeCompatibleSourceId || input.baseUrl === undefined) return {};
  return {
    provider: {
      [opencodeCompatibleProviderId]: {
        name: compatibleEndpointHost(input.baseUrl),
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: input.baseUrl },
        ...(input.modelId && input.modelContextWindow
          ? {
              models: {
                [input.modelId]: {
                  id: input.modelId,
                  name: input.modelId,
                  limit: {
                    context: input.modelContextWindow,
                    output:
                      input.modelMaxOutputTokens ??
                      Math.max(1, Math.floor(input.modelContextWindow / 4)),
                  },
                  modalities: {
                    input: input.modelAcceptsImages ? ["text", "image"] : ["text"],
                    output: ["text"],
                  },
                },
              },
            }
          : {}),
      },
    },
  };
}

function opencodeMcpServer(plan: OpencodeMcpServerPlan): Record<string, unknown> {
  return {
    enabled: true,
    headers: { Authorization: `Bearer ${plan.token}` },
    // Without this OpenCode may try to negotiate OAuth against the Opensteer
    // tool endpoint instead of presenting the bearer token it was given.
    oauth: false,
    timeout: 120_000,
    type: "remote",
    url: plan.url,
  };
}
