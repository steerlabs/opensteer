import { type ClaudeExecutableInspection } from "./executable.js";
import { delay } from "@opensteer/shared/delay";
import { isRecord } from "@opensteer/shared/isRecord";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  query as anthropicQuery,
  startup as anthropicStartup,
  type AccountInfo,
  type CanUseTool,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKMessageOrigin,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { toolsForCapabilityProfile } from "@opensteer/agent-tools";
import { integrationGatewayToolNames } from "@opensteer/integration-core";
import {
  attachmentMaxBytes,
  attachmentImageMaxPixels,
  attachmentNativeImageMediaTypes,
  HarnessIdSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  OpensteerError,
  RequestFormAnswersSchema,
  RunUsageSchema,
  createId,
  harnessUsageLimitFailureCode,
  normalizeToolOutput,
  type HarnessInstanceId,
  type PendingRequest,
  type RequestFormAnswers,
  type RequestFormField,
  type ExecutionNodeId,
  type RequestId,
  type RequestResponse,
  type RunUsage,
  type ThreadAccessMode,
  type ToolIdentity,
  type UserId,
} from "@opensteer/core";
import {
  Deferred,
  withTitleDirectory,
  collectStreamText,
  type SupervisedProcess,
  type HarnessTitleInput,
  HarnessSessionRegistry,
  SubagentNodes,
  TurnPublisher,
  attachmentSandboxPaths,
  assertFreshProviderSessionContext,
  initialContinuationContextPrompt,
  clampConnectionLabel,
  EventBufferOverflowError,
  harnessTurnPreamble,
  harnessInputHeader,
  meetsMinimumVersion,
  nativeImageBase64Budget,
  prepareNativeImage,
  resolvedInputParts,
  resolvedInputSequence,
  opensteerToolIdentity,
  providerSecretFile,
  reasoningEffortLabel,
  runHarnessCliLogout,
  runEndedEvent,
  runFailedEvent,
  runStartedEvent,
  secretInputAuthentication,
  titleCase,
  toHarnessTransportError,
  type HarnessAdapter,
  type HarnessAuthenticationContext,
  type HarnessAuthenticationResult,
  type HarnessAuthenticationSelection,
  type HarnessAuthenticationStart,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessDriverCreateContext,
  type HarnessEvent,
  type HarnessInspectionContext,
  type HarnessInspectionResult,
  type HarnessLogoutSelection,
  type HarnessObservedConnection,
  type HarnessProviderState,
  type HarnessProviderStoreScope,
  profileHarnessProviderStoreScope,
  spawnSupervised,
  type HarnessInput,
  type HarnessSession,
  type HarnessSessionContext,
  type HarnessSourceDescriptor,
  type HarnessSteerInput,
  type HarnessRunInput,
  type ResolvedAttachment,
} from "@opensteer/harness";
import {
  ClaudeHarnessConfigSchema,
  MINIMUM_CLAUDE_CODE_VERSION,
  type ClaudeHarnessConfig,
} from "./config.js";

const requiredRuntimeCapabilities = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"] as const;

const claudeBuiltinTools = [
  "AskUserQuestion",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "Skill",
  "ToolSearch",
  "Write",
] as const;
/**
 * The plugins Claude Code builds in and loads in every session; no setting
 * turns them off. Each is inert in a Run: `cc-plugin-agents-md` loads AGENTS.md
 * only where CLAUDE.md would load, and a Run loads neither;
 * `cc-plugin-plugin-authoring` contributes a skill the Run's skill list leaves
 * out; `cc-plugin-sec-default` adds no policy of its own. A built-in plugin a
 * later release adds is refused until it is reviewed here.
 */
const claudeBuiltinPlugins: ReadonlySet<string> = new Set([
  "cc-plugin-agents-md",
  "cc-plugin-plugin-authoring",
  "cc-plugin-sec-default",
]);
const claudeDelegationTools = ["Agent", "Task"] as const;
/** The subagent tool Claude Code runs in the foreground; `Task` is its older name. */
const claudeSubagentTool = "Agent";
/** Stops a background task, which runs on after its turn inside the same Run. */
const claudeTaskStopTool = "TaskStop";
/** How long a subagent's question waits for the report that names its subagent. */
const subagentAttributionWaitMs = 2_000;
/**
 * How long an idle Run with no background work left waits for the turn a
 * finished task wakes, the CLI's own grace for it; nothing says one is queued.
 */
const backgroundWakeGraceMs = 5_000;

/** `supportedModels()` lists the model it recommends under this value, beside the model's own rows. */
const claudeRecommendedModelValue = "default";
const claudeEffortOptionId = "effort";
/**
 * The reasoning choice that sends no level. Claude Code lists the levels a
 * model takes but not the one it uses unasked, so leaving the choice to Claude
 * Code is offered as a choice of its own, and it is the default.
 */
const claudeEngineDefaultEffort = "default";
const claudeFastModeOptionId = "fast";
const opensteerMcpServerNames = new Set(["opensteer", "opensteer_integrations"]);
const currentRunContextHeading = "Opensteer current Run context — computer inventory:";
const claudeManagedBoundarySettings = Object.freeze({
  disableAllHooks: true,
  disableBundledSkills: true,
  disableClaudeAiConnectors: true,
  disableRemoteControl: true,
  disableWorkflows: true,
}) satisfies NonNullable<Options["managedSettings"]>;

export function managedClaudeSettings(
  context: Pick<
    HarnessSessionContext,
    "machineAccessPlatform" | "machineAccessRelaySocket" | "runtimeBoundary" | "providerState"
  > &
    Pick<Partial<HarnessSessionContext>, "attachmentDirectory" | "attachmentRoot">,
): NonNullable<Options["managedSettings"]> {
  if (context.runtimeBoundary.kind === "native-user") return claudeManagedBoundarySettings;
  // The denied root is the Runner's whole data directory — its identity keys
  // and every profile's provider state, not merely this harness's own files —
  // so nothing the model runs may read or write any part of it.
  const privateRoot = resolve(context.providerState.privateStateRoot);
  const attachmentPaths = attachmentSandboxPaths({
    attachmentDirectory: context.attachmentDirectory,
    attachmentRoot: context.attachmentRoot,
    privateStateRoot: privateRoot,
  });
  return {
    ...claudeManagedBoundarySettings,
    permissions: {
      deny: [`Read(${privateRoot}/**)`, `Edit(${privateRoot}/**)`],
    },
    sandbox: {
      allowUnsandboxedCommands: false,
      enabled: true,
      failIfUnavailable: true,
      filesystem: {
        ...(attachmentPaths ? { allowRead: [attachmentPaths.directory] } : {}),
        denyRead: [privateRoot, ...(attachmentPaths ? [attachmentPaths.root] : [])],
        denyWrite: [privateRoot, ...(attachmentPaths ? [attachmentPaths.root] : [])],
      },
      // Linux has no path-selective form, so the allowance is every Unix socket.
      // That is accepted because an isolated-service pod's only other AF_UNIX
      // endpoint is Claude's own mux-proxy bridge, egress is already restricted,
      // and the relay grants no more than the far machine's policy allows.
      // Revisit if a pod ever exposes a sensitive Unix socket. macOS has the
      // path-selective form and must use it.
      ...(context.machineAccessRelaySocket
        ? {
            network:
              context.machineAccessPlatform === "linux"
                ? { allowAllUnixSockets: true }
                : { allowUnixSockets: [context.machineAccessRelaySocket] },
          }
        : {}),
    },
  };
}

const providerRouteFlags = [
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

const inheritedEnvironmentKeys = [
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
] as const;

const credentialNamePattern =
  /(?:API_KEY|AUTH_TOKEN|ACCESS_KEY|SECRET|PASSWORD|PRIVATE_KEY|BEARER_TOKEN|CREDENTIAL)/iu;

export function claudeAccessModeConfiguration(accessMode: ThreadAccessMode): {
  readonly allowDangerouslySkipPermissions: boolean;
  readonly permissionMode: PermissionMode;
} {
  switch (accessMode) {
    case "approval-required":
      return { allowDangerouslySkipPermissions: false, permissionMode: "default" };
    case "auto-accept-edits":
      return { allowDangerouslySkipPermissions: false, permissionMode: "acceptEdits" };
    case "auto":
      return { allowDangerouslySkipPermissions: false, permissionMode: "auto" };
    case "full-access":
      return { allowDangerouslySkipPermissions: true, permissionMode: "bypassPermissions" };
  }
}

type SessionMode =
  | { readonly type: "start" }
  | { readonly providerSessionReference: string; readonly type: "resume" };

export interface ClaudeQueryHandle extends AsyncIterable<SDKMessage> {
  close(): void;
  interrupt(): Promise<unknown>;
}

export interface ClaudeAgentSdk {
  query(parameters: {
    readonly options: Options;
    readonly prompt: string | AsyncIterable<SDKUserMessage>;
  }): ClaudeQueryHandle;
  inspectModels?(
    options: Options,
    initializeTimeoutMs: number,
    signal: AbortSignal,
  ): Promise<ClaudeInspection>;
}

export interface ClaudeInspection {
  readonly account: AccountInfo | undefined;
  readonly models: readonly ModelInfo[];
}

export interface ClaudeHarnessDependencies {
  readonly executable: string;
  readonly nodeExecutable?: string;
  readonly sdk: ClaudeAgentSdk;
  readonly inspectExecutable?: (
    executable: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<ClaudeExecutableInspection>;
  readonly spawnAuthenticationProcess?: (
    options: ClaudeAuthenticationProcessOptions,
  ) => ClaudeAuthenticationProcess;
}

export interface ClaudeAuthenticationProcessOptions {
  readonly nodeExecutable?: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly signal: AbortSignal;
}

export interface ClaudeAuthenticationProcess {
  readonly child: { readonly stdin: NodeJS.WritableStream };
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly stdout: AsyncIterable<Buffer>;
  readonly stderr: AsyncIterable<Buffer>;
  terminate(graceMs?: number): Promise<void>;
}

interface PendingApproval {
  readonly abort: () => void;
  readonly responses: ReadonlyMap<string, PermissionResult>;
  readonly resolve: (result: PermissionResult) => void;
  readonly type: "approval";
}

interface PendingInput {
  readonly abort: () => void;
  readonly input: Readonly<Record<string, unknown>>;
  readonly questions: readonly ParsedQuestion[];
  readonly resolve: (result: PermissionResult) => void;
  readonly type: "input";
}

type PendingProviderRequest = PendingApproval | PendingInput;

interface ParsedQuestion {
  readonly id: string;
  readonly providerPrompt: string;
  readonly question: RequestFormField;
}

interface StreamThinkingBlock {
  readonly blockId: string;
  text: string;
}

interface ActiveTurn {
  readonly abortController: AbortController;
  /** Live background tasks, by task id: the roster Claude replaces on every change. */
  readonly background: Set<string>;
  /** Ends the Run once a woken turn did not come. */
  endTimer?: NodeJS.Timeout;
  /** Between turns: the engine answered and only background work may still run. */
  idle: boolean;
  /** A finished task's notification may still wake a turn. */
  wakePending: boolean;
  /**
   * Messages steered into the Run, by client uuid, that no result has yet
   * reported consuming. Claude answers each, folded into the turn under way or
   * as a turn of its own, so the Run is not over while any is outstanding.
   */
  readonly unanswered: Set<string>;
  /**
   * Messages sent as context for the next one (`shouldQuery: false`). Claude
   * runs each as a command of its own and answers it at once with an empty
   * result, which is not a reply.
   */
  readonly contextOnly: Set<string>;
  /** The last result said more of the person's sends wait to run as turns. */
  queuedTurns: boolean;
  /** What the Run consumed, as of its latest turn; stated once, when it ends. */
  usage?: RunUsage;
  /** Arms the execution deadline of a turn, or disarms it between turns. */
  turnDeadline?: (armed: boolean) => void;
  /** Each subagent's id, as Claude names it to `canUseTool`, mapped to the call that started it. */
  readonly agentCalls: Map<string, string>;
  /** A subagent's own tool calls, mapped to the call that started that subagent. */
  readonly childToolCalls: Map<string, string>;
  readonly completion: Deferred<void>;
  /** This turn's subagents, keyed by the Agent call that started each. */
  readonly nodes: SubagentNodes;
  readonly environment: Readonly<Record<string, string>>;
  readonly input: ClaudeTurnInput;
  readonly stderr: BoundedTextCollector;
  interrupted: boolean;
  readonly requestedBy: UserId;
  readonly runId: HarnessRunInput["runId"];
  query?: ClaudeQueryHandle;
  sawInit: boolean;
  started: boolean;
  terminal: boolean;
  timedOut: "startup" | "turn" | undefined;
}

interface ClaudeSkillPlugin {
  readonly path: string;
  readonly skills: readonly string[];
}

/**
 * Claude loads Agent Skills only through a plugin, so the vendor-neutral plan
 * is wrapped here in one synthetic plugin whose skills link to the resolved
 * directories. Claude retains skill paths across Runs of a provider session, so
 * the wrapper is rebuilt in place inside the deterministic per-Thread directory
 * the Runner supplies.
 */
/**
 * Moves the SDK's inline `--mcp-config` document, which carries the tool
 * endpoints' secret, into a private file the flag names instead: any user can
 * read a process's arguments, but only its owner can read that file.
 */
function privateMcpConfig(
  args: readonly string[],
  directory: string,
): { readonly args: string[]; readonly remove: () => void } {
  const at = args.indexOf("--mcp-config");
  const inline = at < 0 ? undefined : args[at + 1];
  if (inline === undefined || !inline.trimStart().startsWith("{")) {
    return { args: [...args], remove: () => undefined };
  }
  const path = join(directory, `mcp-config-${randomUUID()}.json`);
  writeFileSync(path, inline, { flag: "wx", mode: 0o600 });
  return {
    args: [...args.slice(0, at + 1), path, ...args.slice(at + 2)],
    remove: () => rmSync(path, { force: true }),
  };
}

async function synthesizeSkillPlugin(
  context: HarnessSessionContext,
): Promise<ClaudeSkillPlugin | undefined> {
  const selected = context.skills?.skills ?? [];
  if (selected.length === 0) return undefined;
  const path = join(context.threadStateDirectory, "claude-plugin");
  await rm(path, { force: true, recursive: true });
  await mkdir(join(path, ".claude-plugin"), { mode: 0o700, recursive: true });
  await writeFile(
    join(path, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "opensteer", version: "1.0.0" }),
    { flag: "wx", mode: 0o600 },
  );
  await mkdir(join(path, "skills"), { mode: 0o700 });
  for (const skill of selected) {
    await symlink(skill.path, join(path, "skills", skill.name), "dir");
  }
  return Object.freeze({
    // Claude reports the canonical plugin path back in its init message, which
    // the runtime boundary check compares against.
    path: await realpath(path),
    skills: Object.freeze(selected.map(({ name }) => `opensteer:${name}`)),
  });
}

/** Every Claude adapter runs with the same provider capabilities. */
const claudeHarnessCapabilities: HarnessCapabilities = Object.freeze({
  approvals: true,
  attachments: true,
  messageAttachments: {
    darwinIsolatedServiceSandbox: true as const,
    nativeImages: {
      maxBytes: attachmentMaxBytes,
      maxPixels: attachmentImageMaxPixels,
      mediaTypes: attachmentNativeImageMediaTypes,
      steering: true,
    },
  },
  interruption: true,
  // The Claude Agent SDK renders an MCP image content block to the model.
  mcpImageContent: true,
  resume: true,
  steering: true,
  toolCalls: true,
  userInput: true,
});

export const claudeAgentSdk: ClaudeAgentSdk = {
  inspectModels: inspectClaudeModels,
  query: (parameters) => anthropicQuery(parameters),
};

function spawnClaudeAuthenticationProcess(
  options: ClaudeAuthenticationProcessOptions,
): ClaudeAuthenticationProcess {
  const supervised = spawnSupervised({
    args: options.executable.endsWith(".js") ? [options.executable, ...options.args] : options.args,
    cwd: options.cwd,
    environment: options.environment,
    executable: options.executable.endsWith(".js")
      ? (options.nodeExecutable ?? process.execPath)
      : options.executable,
    maxOutputBytes: claudeAuthenticationOutputLimit,
    signal: options.signal,
  });
  if (!supervised.child.stdin) throw new Error("Claude authentication stdin is unavailable");
  return { ...supervised, child: { stdin: supervised.child.stdin } };
}

async function inspectClaudeModels(
  options: Options,
  initializeTimeoutMs: number,
  signal: AbortSignal,
): Promise<ClaudeInspection> {
  const warm = await anthropicStartup({ initializeTimeoutMs, options });
  const promptAbort = new AbortController();
  const abort = () => promptAbort.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  let query: ReturnType<typeof warm.query> | undefined;
  try {
    query = warm.query(pendingClaudePrompt(promptAbort.signal));
    const [models, account] = await Promise.all([query.supportedModels(), query.accountInfo()]);
    return { account, models };
  } finally {
    signal.removeEventListener("abort", abort);
    promptAbort.abort(new Error("Claude inspection completed"));
    query?.close();
    warm.close();
  }
}

async function* pendingClaudePrompt(signal: AbortSignal): AsyncGenerator<never> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  yield* [] as never[];
}

const claudeAuthenticationTimeoutMs = 10 * 60_000;
const claudeAuthenticationOutputLimit = 256 * 1_024;
const claudeAuthenticationTailChars = 4 * 1_024;
const claudeAuthenticationDetailChars = 400;
const claudeAuthenticationDetailBytes = 500;

async function authenticateClaudeHarness(
  config: ClaudeHarnessConfig,
  context: HarnessAuthenticationContext,
  dependencies: ClaudeHarnessDependencies,
): Promise<HarnessAuthenticationStart> {
  if (config.provider !== "anthropic") {
    throw new OpensteerError({
      code: "conflict",
      message: "Claude subscription sign in is unavailable for cloud-provider profiles",
    });
  }
  if (context.signal.aborted) throw context.signal.reason ?? new Error("Claude sign-in canceled");
  const lifetime = new AbortController();
  const environment = await claudeAuthenticationEnvironment(
    context.environment,
    context.providerState,
  );
  // Cancelling before the flow is pending still throws to the caller; once it
  // is pending the same signal must settle the pending result as a cancel.
  let cancelSignIn = () => void process.terminate().catch(() => undefined);
  const abort = () => cancelSignIn();
  const process = (dependencies.spawnAuthenticationProcess ?? spawnClaudeAuthenticationProcess)({
    args: ["auth", "login"],
    cwd: context.workingDirectory,
    environment,
    ...(dependencies.nodeExecutable ? { nodeExecutable: dependencies.nodeExecutable } : {}),
    executable: dependencies.executable,
    signal: lifetime.signal,
  });
  context.signal.addEventListener("abort", abort, { once: true });
  const tail = new BoundedTextTail(claudeAuthenticationTailChars);
  let authorization: ClaudeAuthorizationOutcome;
  try {
    authorization = await waitForClaudeAuthorizationUrl(process, context.signal, tail, environment);
  } catch (error) {
    context.signal.removeEventListener("abort", abort);
    await process.terminate().catch(() => undefined);
    throw error;
  }
  if (authorization.kind === "ready") {
    context.signal.removeEventListener("abort", abort);
    await removeClaudeProfileApiKey(context.providerState);
    return { status: "ready" };
  }
  let settled = false;
  let resolveResult!: (result: HarnessAuthenticationResult) => void;
  const result = new Promise<HarnessAuthenticationResult>((resolve) => {
    resolveResult = resolve;
  });
  let authenticationTimer: NodeJS.Timeout | undefined;
  const finish = async (outcome: HarnessAuthenticationResult, terminate = false) => {
    if (settled) return;
    settled = true;
    if (authenticationTimer) clearTimeout(authenticationTimer);
    context.signal.removeEventListener("abort", abort);
    lifetime.abort(new Error("Claude authentication finished"));
    if (terminate) await process.terminate().catch(() => undefined);
    resolveResult(outcome);
  };
  authenticationTimer = setTimeout(
    () => void finish({ detail: "Claude sign-in timed out", status: "failed" }, true),
    claudeAuthenticationTimeoutMs,
  );
  authenticationTimer.unref?.();
  const succeed = async () => {
    // A completed subscription sign-in supersedes any stored profile API key;
    // leaving it would keep billing the replaced key on every later Run.
    try {
      await removeClaudeProfileApiKey(context.providerState);
    } catch {
      await finish({
        detail: "Claude signed in but could not remove the stored Anthropic API key",
        status: "failed",
      });
      return;
    }
    await finish({ status: "ready" });
  };
  cancelSignIn = () =>
    void finish({ detail: "Claude sign-in was canceled", status: "failed" }, true);
  process.child.stdin.on(
    "error",
    (error: Error) =>
      void finish(
        {
          detail: clipUtf8(
            `Claude sign-in could not send input: ${error.message}`,
            claudeAuthenticationDetailBytes,
          ),
          status: "failed",
        },
        true,
      ),
  );
  void process.exited.then(
    async (exit) => {
      if (exit.code === 0) await succeed();
      else
        await finish({
          detail: claudeSignInFailureDetail(exit, tail, environment),
          status: "failed",
        });
    },
    async () => {
      await finish({ detail: "Claude sign-in process failed", status: "failed" });
    },
  );
  return {
    cancel: async () => finish({ detail: "Claude sign-in was canceled", status: "failed" }, true),
    challenge: {
      authorizationUrl: authorization.url,
      inputPrompt: "Paste code here if prompted",
      kind: "browser-code",
    },
    result,
    status: "pending",
    submit: async (value: string) => {
      if (settled)
        throw new OpensteerError({
          code: "conflict",
          message: "Claude sign-in is no longer pending",
        });
      const code = value.trim();
      if (code.length === 0 || code.length > 2_048) {
        throw new OpensteerError({
          code: "bad_request",
          message: "Enter the Claude one-time code",
        });
      }
      process.child.stdin.write(`${code}\n`, (error) => {
        if (!error) return;
        void finish(
          {
            detail: clipUtf8(
              `Claude sign-in could not receive the one-time code: ${error.message}`,
              claudeAuthenticationDetailBytes,
            ),
            status: "failed",
          },
          true,
        );
      });
    },
  };
}

function authenticateClaudeApiKey(
  config: ClaudeHarnessConfig,
  context: HarnessAuthenticationContext,
): HarnessAuthenticationStart {
  if (config.provider !== "anthropic") {
    throw new OpensteerError({
      code: "conflict",
      message: "Anthropic API keys cannot be used with this Claude cloud-provider route",
    });
  }
  if (context.providerState.kind !== "isolated") {
    throw new OpensteerError({
      code: "conflict",
      message: "Add a private Claude profile to store an Anthropic API key",
    });
  }
  return secretInputAuthentication({
    cancelledDetail: "Claude API-key setup was canceled",
    engineLabel: "Claude",
    inputLabel: "Anthropic API key",
    inputPlaceholder: "sk-ant-…",
    maximumLength: claudeProfileApiKeyMaxLength,
    requiredMessage: "Anthropic API key is required",
    signal: context.signal,
    store: (apiKey) => claudeProfileApiKey(context.providerState).write(apiKey),
    storeFailedDetail: "Claude could not store the API key",
  });
}

async function claudeAuthenticationEnvironment(
  supplied: Readonly<Record<string, string>>,
  providerState: HarnessProviderState,
): Promise<Record<string, string>> {
  const environment = await claudeProviderEnvironment(supplied, "anthropic", providerState);
  // The driver's own sign-in and sign-out subprocesses are the only Claude
  // processes allowed to run these commands; every model-executed session keeps
  // them disabled through buildClaudeEnvironment.
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "DISABLE_LOGIN_COMMAND",
    "DISABLE_LOGOUT_COMMAND",
  ]) {
    delete environment[key];
  }
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

type ClaudeAuthorizationOutcome =
  { readonly kind: "ready" } | { readonly kind: "url"; readonly url: string };

async function waitForClaudeAuthorizationUrl(
  process: ClaudeAuthenticationProcess,
  signal: AbortSignal,
  tail: BoundedTextTail,
  environment: Readonly<Record<string, string>>,
): Promise<ClaudeAuthorizationOutcome> {
  let buffered = "";
  let resolved = false;
  let resolveUrl!: (outcome: ClaudeAuthorizationOutcome) => void;
  let rejectUrl!: (error: unknown) => void;
  const url = new Promise<ClaudeAuthorizationOutcome>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  // The process supervisor bounds retained output, so the stream keeps draining
  // here and a breach surfaces as a stream error instead of stalling the CLI.
  const consume = async (stream: AsyncIterable<Buffer>) => {
    try {
      for await (const chunk of stream) {
        const text = chunk.toString("utf8");
        tail.append(text);
        if (resolved) continue;
        buffered = `${buffered}${text}`;
        const match = buffered.match(/https:\/\/[^\s<>"']+/u);
        if (match) {
          resolved = true;
          resolveUrl({ kind: "url", url: match[0].replace(/[.,;]+$/u, "") });
          buffered = "";
        }
      }
    } catch (error) {
      rejectUrl(error);
    }
  };
  void Promise.all([consume(process.stdout), consume(process.stderr)]);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OpensteerError({ code: "timeout", message: "Claude sign-in timed out" })),
      claudeAuthenticationTimeoutMs,
    );
    timer.unref?.();
  });
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Claude sign-in canceled"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const exited = process.exited.then((exit): ClaudeAuthorizationOutcome => {
    // An already signed-in CLI, or one that completed through its localhost
    // callback, exits successfully without ever printing a browser URL.
    if (exit.code === 0) return { kind: "ready" };
    throw new OpensteerError({
      code: "harness_error",
      message: claudeSignInFailureDetail(exit, tail, environment),
    });
  });
  void exited.catch(() => undefined);
  try {
    return await Promise.race([url, timeout, abort, exited]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Reports why the official CLI refused the sign-in. The retained output tail is
 * redacted, and only its most recent characters survive because a protocol
 * authentication detail is capped well below the retained window.
 */
function claudeSignInFailureDetail(
  exit: Awaited<ClaudeAuthenticationProcess["exited"]>,
  tail: BoundedTextTail,
  environment: Readonly<Record<string, string>>,
): string {
  const base = `Claude sign-in failed (exit ${exit.code ?? "unknown"})`;
  const output = sanitizeErrorMessage(
    tail.value(),
    environment,
    claudeAuthenticationTailChars,
  ).trim();
  if (output.length === 0) return base;
  return clipUtf8(
    `${base}: ${output.slice(-claudeAuthenticationDetailChars)}`,
    claudeAuthenticationDetailBytes,
  );
}

/**
 * Simultaneous isolated Claude subscription accounts on macOS are gated
 * behind a Keychain qualification that has not been performed. Settings must be able to say so before the person picks the
 * source, not only once they have clicked Add.
 */
const anthropicSourceDetail =
  process.platform === "darwin"
    ? "A Claude subscription or an Anthropic API key. On a Mac, a second Claude account can only use an API key."
    : "A Claude subscription or an Anthropic API key.";

const claudeSources: readonly HarnessSourceDescriptor[] = [
  {
    detail: anthropicSourceDetail,
    fields: [],
    kind: "first-party",
    label: "Anthropic",
    // The driver reports no consumption windows today, so a usage bar on an
    // Anthropic account would be an empty promise rather than a missing
    // reading.
    quota: "none",
    sourceId: "anthropic",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "Signed in through this computer's AWS credentials.",
    fields: [],
    kind: "cloud-identity",
    label: "Amazon Bedrock",
    quota: "none",
    sourceId: "bedrock",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "Signed in through this computer's Google Cloud credentials.",
    fields: [],
    kind: "cloud-identity",
    label: "Google Vertex AI",
    quota: "none",
    sourceId: "vertex",
    stateKinds: ["ambient", "isolated"],
  },
  {
    detail: "Signed in through this computer's Azure credentials.",
    fields: [],
    kind: "cloud-identity",
    label: "Azure AI Foundry",
    quota: "none",
    sourceId: "foundry",
    stateKinds: ["ambient", "isolated"],
  },
] as const satisfies readonly HarnessSourceDescriptor[];

/**
 * The route Claude Code takes for one account. It follows from the source the
 * account was added for and from nothing else: a stored `provider` that
 * disagreed with the source would route a Run past the credentials the person
 * actually connected.
 */
function claudeProviderForSource(sourceId: string): ClaudeHarnessConfig["provider"] {
  switch (sourceId) {
    case "anthropic":
      return "anthropic";
    case "bedrock":
      return "bedrock";
    case "vertex":
      return "vertex";
    case "foundry":
      return "foundry";
    default:
      throw new OpensteerError({
        code: "bad_request",
        message: `Claude Code cannot drive the source ${sourceId}`,
      });
  }
}

/** One place derives the route, so no caller can read a stale stored `provider`. */
function claudeConfigForSource(config: unknown, sourceId: string): ClaudeHarnessConfig {
  return {
    ...ClaudeHarnessConfigSchema.parse(config),
    provider: claudeProviderForSource(sourceId),
  };
}

/** What a cloud route needs from the computer when it reports no models. */
const cloudIdentityDetails: Readonly<Record<string, string>> = {
  bedrock: "No AWS credentials for Amazon Bedrock are available on this computer",
  foundry: "No Azure credentials for Azure AI Foundry are available on this computer",
  vertex: "No Google Cloud credentials for Vertex AI are available on this computer",
};

/**
 * A cloud route's sign-in is the computer's own credential chain, and a
 * missing one surfaces as a failed startup rather than as a signed-out
 * account. Reporting that as an inspection error would put a stack trace where
 * "sign in to AWS" belongs, so the failure becomes a missing cloud identity —
 * for Anthropic, where a real sign-in exists, the error still stands.
 */
async function inspectCloudTolerantly(
  provider: ClaudeHarnessConfig["provider"],
  signal: AbortSignal,
  inspect: () => Promise<ClaudeInspection>,
): Promise<ClaudeInspection | undefined> {
  if (provider === "anthropic") return inspect();
  try {
    return await inspect();
  } catch (error) {
    // A cancelled inspection observed nothing about the computer's credential
    // chain, so it must not answer as a missing cloud identity: that would ask
    // a person to sign in to a cloud they may well be signed in to already.
    if (signal.aborted) throw error;
    return undefined;
  }
}

function claudeCloudIdentityRequired(
  provider: ClaudeHarnessConfig["provider"],
): HarnessInspectionResult {
  return {
    connections: [
      {
        authKind: "cloud-identity",
        connectionSlot: "primary",
        label: "Claude Code",
        status: "authentication-required",
      },
    ],
    detail:
      cloudIdentityDetails[provider] ??
      "This computer has no cloud credentials for the configured Claude route",
    // The machine's own credentials are the sign-in; there is nothing for
    // Opensteer to set up on the person's behalf.
    setupMethods: [],
    status: "authentication-required",
  };
}

export class ClaudeHarnessDriver implements HarnessDriver {
  readonly kind = HarnessIdSchema.parse("claude");
  readonly sources = claudeSources;
  /** `claudeAccessModeConfiguration` translates every one of them explicitly. */
  readonly accessModes = [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ] as const satisfies readonly ThreadAccessMode[];
  readonly capabilities = claudeHarnessCapabilities;
  readonly configSchema = ClaudeHarnessConfigSchema;
  readonly environmentVariables = ["CLAUDE_CONFIG_DIR"] as const;
  /**
   * A Claude profile's provider home is its own session store: the CLI keeps
   * conversations beside the credentials that created them, so nothing here can
   * be shared across profiles without moving that state first.
   */
  readonly providerStoreScope: HarnessProviderStoreScope = profileHarnessProviderStoreScope;
  readonly #dependencies: ClaudeHarnessDependencies;

  constructor(dependencies: ClaudeHarnessDependencies) {
    this.#dependencies = dependencies;
  }

  async #runtimeDependencies(environment: NodeJS.ProcessEnv): Promise<ClaudeHarnessDependencies> {
    const inspect = this.#dependencies.inspectExecutable;
    if (!inspect) return this.#dependencies;
    const result = await inspect(this.#dependencies.executable, environment);
    if (result.status !== "available")
      throw new OpensteerError({ code: "not_found", message: result.detail });
    return { ...this.#dependencies, executable: result.executable };
  }

  async authenticate(
    context: HarnessAuthenticationContext,
    selection: HarnessAuthenticationSelection = { methodId: "claude-subscription" },
  ): Promise<HarnessAuthenticationStart> {
    if (selection.connectionSlot && selection.connectionSlot !== "primary") {
      throw new OpensteerError({ code: "bad_request", message: "Unknown Claude connection" });
    }
    const config = claudeConfigForSource(context.config, context.sourceId);
    if (selection.methodId === "claude-subscription") {
      return authenticateClaudeHarness(
        config,
        context,
        await this.#runtimeDependencies(context.environment),
      );
    }
    if (selection.methodId === "claude-api-key") {
      return authenticateClaudeApiKey(config, context);
    }
    throw new OpensteerError({ code: "bad_request", message: "Unknown Claude setup method" });
  }

  async logout(
    context: HarnessAuthenticationContext,
    selection: HarnessLogoutSelection = {},
  ): Promise<void> {
    const config = claudeConfigForSource(context.config, context.sourceId);
    if (selection.connectionSlot && selection.connectionSlot !== "primary") {
      throw new OpensteerError({ code: "bad_request", message: "Unknown Claude connection" });
    }
    if (config.provider !== "anthropic") {
      throw new OpensteerError({
        code: "conflict",
        message: "Claude subscription sign out is unavailable for cloud-provider profiles",
      });
    }
    await removeClaudeProfileApiKey(context.providerState);
    const dependencies = await this.#runtimeDependencies(context.environment);
    const lifetime = new AbortController();
    const process = (dependencies.spawnAuthenticationProcess ?? spawnClaudeAuthenticationProcess)({
      args: ["auth", "logout"],
      cwd: context.workingDirectory,
      environment: await claudeAuthenticationEnvironment(
        context.environment,
        context.providerState,
      ),
      ...(dependencies.nodeExecutable ? { nodeExecutable: dependencies.nodeExecutable } : {}),
      executable: dependencies.executable,
      signal: lifetime.signal,
    });
    const abort = () => lifetime.abort(context.signal.reason);
    if (context.signal.aborted) abort();
    else context.signal.addEventListener("abort", abort, { once: true });
    try {
      await runHarnessCliLogout({
        engineLabel: "Claude",
        process,
        timeoutMs: claudeAuthenticationTimeoutMs,
      });
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
  }

  async removeProfile(context: HarnessAuthenticationContext): Promise<void> {
    // Removing the Opensteer record never removes ambient provider files: an
    // ambient profile shares the machine's own Claude configuration.
    if (context.providerState.kind !== "isolated") return;
    if (claudeProviderForSource(context.sourceId) === "anthropic") await this.logout(context);
  }

  async inspect(context: HarnessInspectionContext): Promise<HarnessInspectionResult> {
    let dependencies: ClaudeHarnessDependencies;
    try {
      dependencies = await this.#runtimeDependencies(context.environment);
    } catch (error) {
      return {
        status: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const config = claudeConfigForSource(context.config, context.sourceId);
    const inspectModels = this.#dependencies.sdk.inspectModels;
    if (!inspectModels) {
      return {
        detail: "Claude model inspection is unavailable in this Runner build",
        status: "unavailable",
      };
    }
    const abortController = new AbortController();
    const abort = () => abortController.abort(context.signal.reason);
    if (context.signal.aborted) abort();
    else context.signal.addEventListener("abort", abort, { once: true });
    try {
      const environment = await claudeProviderEnvironment(
        context.environment,
        config.provider,
        context.providerState,
      );
      const inspection = await inspectCloudTolerantly(config.provider, context.signal, () =>
        inspectModels(
          {
            abortController,
            cwd: context.workingDirectory,
            disallowedTools: [...claudeDelegationTools],
            env: environment,
            managedSettings: managedClaudeSettings({
              machineAccessPlatform: undefined,
              machineAccessRelaySocket: undefined,
              providerState: context.providerState,
              runtimeBoundary: context.runtimeBoundary,
            }),
            pathToClaudeCodeExecutable: dependencies.executable,
            permissionMode: "default",
            persistSession: false,
            settingSources: [],
            strictMcpConfig: true,
            tools: [],
          },
          config.startupTimeoutMs,
          context.signal,
        ),
      );
      if (!inspection) return claudeCloudIdentityRequired(config.provider);
      const { account, models } = inspection;
      if (config.provider === "anthropic" && !isClaudeAccountAuthenticated(account)) {
        return claudeAuthenticationRequired(config, context.providerState);
      }
      // A cloud route authenticates outside the CLI, so an empty catalog is
      // the only evidence the machine's credentials did not reach the
      // provider.
      if (config.provider !== "anthropic" && models.length === 0) {
        return claudeCloudIdentityRequired(config.provider);
      }
      const providerId = ModelProviderIdSchema.parse("anthropic");
      const groups = new Map<string, ModelInfo[]>();
      for (const model of models) {
        const modelId = ModelIdSchema.parse(model.resolvedModel ?? model.value);
        const group = groups.get(modelId) ?? [];
        group.push(model);
        groups.set(modelId, group);
      }
      const descriptors = [...groups.entries()].map(([modelId, aliases]) => {
        const representative =
          aliases.find((model) => model.value === modelId) ??
          aliases.find((model) => model.value !== claudeRecommendedModelValue) ??
          aliases[0];
        if (!representative) throw new Error("Claude returned an empty model alias group");
        const supportedEfforts = [
          ...new Set(
            aliases.flatMap((model) =>
              model.supportsEffort ? (model.supportedEffortLevels ?? []) : [],
            ),
          ),
        ];
        if ((supportedEfforts as readonly string[]).includes(claudeEngineDefaultEffort)) {
          throw new Error(`Claude Code lists a reasoning level named ${claudeEngineDefaultEffort}`);
        }
        return {
          // Every model Claude Code offers reads images; the CLI has never
          // listed one that does not.
          acceptsImages: true,
          ...(representative.description
            ? { description: representative.description.slice(0, 500) }
            : {}),
          displayName: representative.displayName,
          isDefault: aliases.some((model) => model.value === claudeRecommendedModelValue),
          modelId: ModelIdSchema.parse(modelId),
          options: [
            ...(supportedEfforts.length > 0
              ? [
                  {
                    defaultValue: claudeEngineDefaultEffort,
                    id: claudeEffortOptionId,
                    label: "Reasoning",
                    type: "select" as const,
                    values: [
                      {
                        description: "Claude Code chooses for this model",
                        label: "Default",
                        value: claudeEngineDefaultEffort,
                      },
                      ...supportedEfforts.map((value) => ({
                        label: reasoningEffortLabel(value),
                        value,
                      })),
                    ],
                  },
                ]
              : []),
            ...(aliases.some((model) => model.supportsFastMode === true)
              ? [
                  {
                    defaultValue: false,
                    id: claudeFastModeOptionId,
                    label: "Fast mode",
                    type: "toggle" as const,
                  },
                ]
              : []),
          ],
          providerId,
        };
      });
      if (descriptors.length === 0) {
        return { detail: "Claude did not report any available models", status: "unavailable" };
      }
      return {
        connections: [claudeConnectionSummary(account, config.provider)],
        detail: "Claude Code is signed in and ready",
        models: descriptors,
        setupMethods:
          config.provider === "anthropic" ? claudeSetupMethods(context.providerState) : [],
        status: "ready",
      };
    } finally {
      context.signal.removeEventListener("abort", abort);
      abortController.abort(new Error("Claude inspection completed"));
    }
  }

  async create(context: HarnessDriverCreateContext): Promise<HarnessAdapter> {
    const config = claudeConfigForSource(context.config, context.sourceId);
    return new ClaudeHarnessAdapter(context.instanceId, config, this.#dependencies);
  }
}

function claudeConnectionSummary(
  account: AccountInfo | undefined,
  provider: ClaudeHarnessConfig["provider"],
): HarnessObservedConnection {
  const accountLabel = clampConnectionLabel(account?.email ?? account?.organization);
  const authKind = claudeAuthKind(account, provider);
  const billingLabel = clampConnectionLabel(
    account?.subscriptionType ??
      account?.tokenSource ??
      account?.apiKeySource ??
      account?.apiProvider ??
      (provider === "anthropic" ? undefined : provider),
  );
  return {
    ...(accountLabel ? { accountLabel } : {}),
    ...(authKind ? { authKind } : {}),
    ...(billingLabel ? { billingLabel: titleCase(billingLabel.replaceAll("_", " ")) } : {}),
    connectionSlot: "primary",
    label: "Claude Code",
    ...(provider === "anthropic" ? { logoutSupported: true } : {}),
    status: "connected" as const,
  };
}

/**
 * How the connection is authorised, read from the account rather than from the
 * label the CLI happened to report: a cloud route is the machine's identity, a
 * plan is a person's subscription, and a key source is a key.
 */
function claudeAuthKind(
  account: AccountInfo | undefined,
  provider: ClaudeHarnessConfig["provider"],
): HarnessObservedConnection["authKind"] {
  if (provider !== "anthropic") return "cloud-identity";
  if (account?.subscriptionType !== undefined && account.subscriptionType !== "none") {
    return "subscription";
  }
  if (account?.apiKeySource !== undefined || account?.tokenSource !== undefined) return "api-key";
  return undefined;
}

const claudeSubscriptionSetupMethods = [
  {
    connectionSlot: "primary",
    detail: "Sign in through Anthropic's official Claude Code browser flow.",
    kind: "browser-code",
    label: "Claude subscription",
    methodId: "claude-subscription",
  },
] as const;

const claudeApiKeySetupMethod = {
  connectionSlot: "primary",
  detail: "Store an Anthropic API key in this private Claude profile.",
  inputLabel: "Anthropic API key",
  inputPlaceholder: "sk-ant-…",
  kind: "secret-input",
  label: "Anthropic API key",
  methodId: "claude-api-key",
} as const;

function claudeSetupMethods(providerState: HarnessProviderState) {
  if (providerState.kind !== "isolated") return claudeSubscriptionSetupMethods;
  // The same macOS gate the Anthropic source's detail states up front.
  return process.platform === "darwin"
    ? [claudeApiKeySetupMethod]
    : [...claudeSubscriptionSetupMethods, claudeApiKeySetupMethod];
}

function claudeAuthenticationRequired(
  config: ClaudeHarnessConfig,
  providerState: HarnessProviderState,
): HarnessInspectionResult {
  const setupMethods = config.provider === "anthropic" ? claudeSetupMethods(providerState) : [];
  return {
    connections: [
      {
        connectionSlot: "primary",
        label: "Claude Code",
        status: "authentication-required",
      },
    ],
    detail: "Sign in to Claude Code on this Runner before using the Claude engine",
    setupMethods,
    status: "authentication-required",
  };
}

/**
 * Claude reports authentication structurally rather than through error prose. A
 * first-party profile that is not signed in carries no account identity and no
 * token source, while Bedrock, Vertex, Foundry, and gateway routes authenticate
 * outside the CLI and report only their `apiProvider`.
 */
function isClaudeAccountAuthenticated(account: AccountInfo | undefined): boolean {
  if (!account) return false;
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") return true;
  return (
    account.email !== undefined ||
    account.organization !== undefined ||
    (account.subscriptionType !== undefined && account.subscriptionType !== "none") ||
    account.tokenSource !== undefined ||
    account.apiKeySource !== undefined
  );
}

class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly capabilities = claudeHarnessCapabilities;
  readonly instanceId: HarnessInstanceId;
  readonly #config: ClaudeHarnessConfig;
  readonly #dependencies: ClaudeHarnessDependencies;
  readonly #sessions = new HarnessSessionRegistry<ClaudeHarnessSession>("Claude");

  constructor(
    instanceId: HarnessInstanceId,
    config: ClaudeHarnessConfig,
    dependencies: ClaudeHarnessDependencies,
  ) {
    this.instanceId = instanceId;
    this.#config = config;
    this.#dependencies = dependencies;
  }

  async startSession(context: HarnessSessionContext): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    assertFreshProviderSessionContext(context);
    // Claude names the conversation, so a fresh session picks a reference this
    // adapter is not already serving before it asks the runtime for one.
    let reference = randomUUID();
    while (this.#sessions.holds(reference)) reference = randomUUID();
    return this.#sessions.open(reference, () => this.#open(reference, context, { type: "start" }));
  }

  async resumeSession(
    providerSessionReference: string,
    context: HarnessSessionContext,
  ): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    const reference = validateProviderSessionReference(providerSessionReference);
    return this.#sessions.open(reference, () =>
      this.#open(reference, context, { providerSessionReference: reference, type: "resume" }),
    );
  }

  async close(): Promise<void> {
    await this.#sessions.close();
  }

  async #open(
    reference: string,
    context: HarnessSessionContext,
    mode: SessionMode,
  ): Promise<ClaudeHarnessSession> {
    let dependencies = this.#dependencies;
    if (dependencies.inspectExecutable) {
      const result = await dependencies.inspectExecutable(
        dependencies.executable,
        context.environment,
      );
      if (result.status !== "available")
        throw new OpensteerError({ code: "not_found", message: result.detail });
      dependencies = { ...dependencies, executable: result.executable };
    }
    return ClaudeHarnessSession.open(
      reference,
      context,
      mode,
      this.#config,
      dependencies,
      (session) => this.#sessions.release(session),
    );
  }
}

class ClaudeHarnessSession implements HarnessSession {
  readonly providerSessionReference: string;
  readonly events: AsyncIterable<HarnessEvent>;
  readonly #config: ClaudeHarnessConfig;
  readonly #context: HarnessSessionContext;
  readonly #dependencies: ClaudeHarnessDependencies;
  readonly #publisher: TurnPublisher;
  readonly #lifetimeAbortListener: () => void;
  readonly #onClose: (session: ClaudeHarnessSession) => void;
  readonly #pendingRequests = new Map<RequestId, PendingProviderRequest>();
  readonly #skillPlugin: ClaudeSkillPlugin | undefined;
  readonly #startedToolCalls = new Set<string>();
  /**
   * Calls opened from the stream, before their arguments had arrived. The
   * complete block restates each once, because `tool.started` is the record
   * of what a call was asked to do, and streamed arguments are only deltas.
   */
  readonly #streamedArgumentToolCalls = new Set<string>();
  readonly #streamToolCalls = new Map<number, string>();
  readonly #streamThinkingBlocks = new Map<number, StreamThinkingBlock>();
  readonly #completedThinkingBlocks = new Set<string>();
  #activeTurn: ActiveTurn | undefined;
  #assistantThinkingBlocksSeen = 0;
  #thinkingBlockCounter = 0;
  #closed = false;
  #hasProviderTranscript: boolean;
  #latestAssistantText = "";
  #lastAssistantError: string | undefined;
  /**
   * The provider's last word on whether this account's plan still admits work.
   * It is session-scoped because Claude reports it when it changes, not per
   * turn, so the most recent reading is the only reading there is.
   */
  #planRejected = false;
  #stopPromise: Promise<void> | undefined;

  private constructor(
    providerSessionReference: string,
    context: HarnessSessionContext,
    mode: SessionMode,
    config: ClaudeHarnessConfig,
    dependencies: ClaudeHarnessDependencies,
    onClose: (session: ClaudeHarnessSession) => void,
    skillPlugin: ClaudeSkillPlugin | undefined,
  ) {
    this.providerSessionReference = providerSessionReference;
    this.#context = context;
    this.#config = config;
    this.#dependencies = dependencies;
    this.#onClose = onClose;
    this.#skillPlugin = skillPlugin;
    this.#hasProviderTranscript = mode.type === "resume";
    this.#publisher = new TurnPublisher({
      maxBytes: config.maxEventBytes,
      maxItems: config.maxEventItems,
    });
    this.events = this.#publisher.events;
    this.#lifetimeAbortListener = () => void this.stop();
    context.signal.addEventListener("abort", this.#lifetimeAbortListener, { once: true });
  }

  static async open(
    providerSessionReference: string,
    context: HarnessSessionContext,
    mode: SessionMode,
    config: ClaudeHarnessConfig,
    dependencies: ClaudeHarnessDependencies,
    onClose: (session: ClaudeHarnessSession) => void,
  ): Promise<ClaudeHarnessSession> {
    if (context.signal.aborted) {
      throw new OpensteerError({
        code: "harness_error",
        message: "Claude session was cancelled before startup",
      });
    }
    if (!isAbsolute(context.workspacePath) || !isAbsolute(context.providerState.privateStateRoot)) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Claude harness requires absolute workspace and state paths",
      });
    }
    return new ClaudeHarnessSession(
      providerSessionReference,
      context,
      mode,
      config,
      dependencies,
      onClose,
      await synthesizeSkillPlugin(context),
    );
  }

  async generateTitle({ prompt, signal }: HarnessTitleInput): Promise<string> {
    const environment = await claudeProviderEnvironment(
      this.#context.environment,
      this.#config.provider,
      this.#context.providerState,
    );
    return withTitleDirectory(this.#context, async (directory) => {
      const modelRefused = (text: string) =>
        /model/iu.test(text) &&
        /unavailable|not found|not available|not supported|unsupported|access|invalid|permission|denied/iu.test(
          text,
        );
      const attempt = async (model: string): Promise<{ text: string; refused: boolean }> => {
        signal.throwIfAborted();
        const abortController = new AbortController();
        const abort = () => abortController.abort();
        signal.addEventListener("abort", abort, { once: true });
        let child: SupervisedProcess | undefined;
        let stderr: Promise<string> | undefined;
        let query: ClaudeQueryHandle | undefined;
        try {
          query = this.#dependencies.sdk.query({
            prompt,
            options: {
              abortController,
              cwd: directory,
              env: environment,
              pathToClaudeCodeExecutable: this.#dependencies.executable,
              managedSettings: managedClaudeSettings(this.#context),
              skills: [],
              plugins: [],
              tools: [],
              mcpServers: {},
              strictMcpConfig: true,
              settingSources: [],
              persistSession: false,
              maxTurns: 1,
              permissionMode: "default",
              title: "Thread title",
              model,
              canUseTool: async () => ({
                behavior: "deny",
                message: "Tools are disabled for Thread titles",
              }),
              spawnClaudeCodeProcess: ({ args, command, cwd, env }) => {
                const inherited: Record<string, string> = {};
                for (const [name, value] of Object.entries(env))
                  if (value !== undefined) inherited[name] = value;
                child = spawnSupervised({
                  ...this.#context.wrapProcessLaunch({
                    executable: command,
                    args,
                    cwd: cwd ?? directory,
                    environment: inherited,
                  }),
                  maxOutputBytes: 8192,
                });
                stderr = collectStreamText(child.stderr);
                void stderr.catch(() => undefined);
                const stop = () => void child?.terminate(0).catch(() => undefined);
                abortController.signal.addEventListener("abort", stop, { once: true });
                if (abortController.signal.aborted) stop();
                return child.child;
              },
            },
          });
          let text = "";
          let refused = false;
          for await (const message of query) {
            signal.throwIfAborted();
            if (message.type === "result") {
              if (message.subtype === "success") text = message.result;
              else {
                const errorText = message.errors.join(" ");
                refused = modelRefused(errorText);
                if (!refused) throw new Error("Claude Thread title request failed");
              }
            }
          }
          return { text, refused };
        } catch (error) {
          if (!signal.aborted && error instanceof Error && modelRefused(error.message))
            return { text: "", refused: true };
          throw error;
        } finally {
          signal.removeEventListener("abort", abort);
          abortController.abort();
          try {
            query?.close();
          } finally {
            await child?.terminate(0);
            await child?.exited;
            await stderr;
          }
        }
      };
      const first = await attempt("haiku");
      if (!first.refused) return first.text;
      signal.throwIfAborted();
      const fallback = await attempt(
        this.#context.modelSelection.nativeModelId ?? this.#context.modelSelection.modelId,
      );
      if (fallback.refused) throw new Error("Claude refused the Thread title model");
      return fallback.text;
    });
  }

  async execute(run: HarnessRunInput): Promise<void> {
    this.#assertUsable();
    if (this.#activeTurn) {
      throw new OpensteerError({
        code: "conflict",
        message: "Claude session already has an active turn",
      });
    }
    const environment = mergeEnvironments(this.#context.environment, run.environment);
    const active: ActiveTurn = {
      abortController: new AbortController(),
      agentCalls: new Map(),
      background: new Set(),
      idle: false,
      wakePending: false,
      unanswered: new Set(),
      contextOnly: new Set(),
      queuedTurns: false,
      childToolCalls: new Map(),
      completion: new Deferred<void>(),
      nodes: new SubagentNodes((event) => this.#publish(event)),
      environment,
      input: new ClaudeTurnInput(),
      interrupted: run.signal.aborted,
      requestedBy: run.requestedBy,
      runId: run.runId,
      sawInit: false,
      started: false,
      stderr: new BoundedTextCollector(this.#config.maxStderrBytes),
      terminal: false,
      timedOut: undefined,
    };
    this.#latestAssistantText = "";
    this.#lastAssistantError = undefined;
    // A plan refusal is this turn's fact: the next turn asks the provider again.
    this.#planRejected = false;
    this.#streamToolCalls.clear();
    this.#streamThinkingBlocks.clear();
    this.#completedThinkingBlocks.clear();
    this.#assistantThinkingBlocksSeen = 0;
    this.#activeTurn = active;
    const abort = () => {
      active.interrupted = true;
      this.#abortActive(active, run.signal.reason ?? new Error("Claude turn interrupted"));
    };
    if (!run.signal.aborted) run.signal.addEventListener("abort", abort, { once: true });

    try {
      if (run.signal.aborted) {
        this.#publishInterrupted(active);
        return;
      }
      await this.#runTurn(run, active);
    } finally {
      run.signal.removeEventListener("abort", abort);
      if (this.#activeTurn === active) this.#activeTurn = undefined;
      active.completion.resolve();
    }
  }

  async interrupt(): Promise<void> {
    const active = this.#activeTurn;
    if (!active || active.terminal) return;
    active.interrupted = true;
    this.#abortActive(active, new Error("Claude turn interrupted"));
    await active.completion.promise;
  }

  async steer(input: HarnessSteerInput): Promise<void> {
    this.#assertUsable();
    const active = this.#activeTurn;
    if (!active || active.terminal) {
      throw new OpensteerError({
        code: "conflict",
        message: "Claude session has no active turn to steer",
      });
    }
    // The push is synchronous, so an already-aborted signal is the only point
    // at which the message can still be withheld. Pushing it anyway would let
    // the model read a message the Host will never record as delivered.
    if (input.signal?.aborted) {
      throw new OpensteerError({
        code: "conflict",
        message: "Claude steering was cancelled before the message entered the turn",
      });
    }
    await this.#pushInput(active, input.input, {
      attachments: input.attachments,
      priority: "next",
      shouldQuery: true,
      signal: input.signal,
      steered: true,
    });
  }

  async resolveRequest(requestId: RequestId, response: RequestResponse): Promise<void> {
    this.#assertUsable();
    const pending = this.#pendingRequests.get(requestId);
    if (!pending) {
      throw new OpensteerError({ code: "not_found", message: "Claude request not found" });
    }
    if (pending.type === "approval") {
      if (response.kind !== "choice") throw invalidClaudeRequestResponse();
      const result = pending.responses.get(response.optionId);
      if (!result) throw invalidClaudeRequestResponse();
      this.#pendingRequests.delete(requestId);
      pending.abort();
      const note = response.text?.trim();
      pending.resolve(result.behavior === "deny" && note ? { ...result, message: note } : result);
      return;
    }
    if (response.kind !== "form") throw invalidClaudeRequestResponse();
    const parsed = RequestFormAnswersSchema.parse(response.answers);
    validateAnswers(pending.questions, parsed);
    const providerAnswers = Object.fromEntries(
      pending.questions.map(({ id, providerPrompt, question }) => {
        const values = parsed[id];
        if (!values) throw new Error(`Validated answer ${id} disappeared`);
        return [providerPrompt, question.multiSelect ? values.join(", ") : values[0]];
      }),
    );
    this.#pendingRequests.delete(requestId);
    pending.abort();
    pending.resolve({
      behavior: "allow",
      updatedInput: { ...pending.input, answers: providerAnswers },
    });
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #runTurn(run: HarnessRunInput, active: ActiveTurn): Promise<void> {
    let startupTimer: NodeJS.Timeout | undefined;
    let turnTimer: NodeJS.Timeout | undefined;
    try {
      await this.#pushTurnInputs(active, run.inputs, run, run.attachments);
      const environment = await claudeProviderEnvironment(
        active.environment,
        this.#config.provider,
        this.#context.providerState,
      );
      const options = this.#queryOptions(environment, active);
      const query = this.#dependencies.sdk.query({ options, prompt: active.input });
      active.query = query;
      active.abortController.signal.addEventListener("abort", () => query.close(), { once: true });

      startupTimer = setTimeout(() => {
        if (active.sawInit || active.terminal) return;
        active.timedOut = "startup";
        this.#abortActive(active, new Error("Claude runtime startup timed out"));
      }, this.#config.startupTimeoutMs);
      startupTimer.unref();
      // Each turn has its deadline; background work between turns runs
      // against the Run's own, which the Host keeps.
      active.turnDeadline = (armed) => {
        if (turnTimer) clearTimeout(turnTimer);
        turnTimer = undefined;
        if (!armed) return;
        turnTimer = setTimeout(() => {
          if (active.terminal) return;
          active.timedOut = "turn";
          this.#abortActive(active, new Error("Claude turn exceeded its execution deadline"));
        }, this.#config.maxTurnDurationMs);
        turnTimer.unref();
      };
      active.turnDeadline(true);

      for await (const message of query) {
        this.#handleMessage(message, active);
        if (active.sawInit && startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = undefined;
        }
        if (active.terminal) active.input.end();
      }

      if (!active.terminal) {
        if (active.interrupted) this.#publishInterrupted(active);
        else if (active.timedOut) {
          this.#publishFailure(
            active,
            new OpensteerError({
              code: "timeout",
              message:
                active.timedOut === "startup"
                  ? "Claude runtime did not initialize before the startup deadline"
                  : "Claude turn exceeded its execution deadline",
              retryable: true,
            }),
          );
        } else {
          this.#publishFailure(
            active,
            new OpensteerError({
              code: "harness_error",
              message: "Claude runtime ended without a terminal result",
              retryable: true,
            }),
          );
        }
      }
    } catch (error) {
      if (error instanceof EventBufferOverflowError) {
        const overflow = new OpensteerError({
          cause: error,
          code: "harness_error",
          message: "Claude event buffer overflowed; the session was closed to prevent event loss",
        });
        this.#publisher.latchUnusable(overflow);
        throw overflow;
      }
      if (!active.terminal) {
        if (active.interrupted) this.#publishInterrupted(active);
        else if (active.timedOut) {
          this.#publishFailure(
            active,
            new OpensteerError({
              cause: error,
              code: "timeout",
              message:
                active.timedOut === "startup"
                  ? "Claude runtime did not initialize before the startup deadline"
                  : "Claude turn exceeded its execution deadline",
              retryable: true,
            }),
          );
        } else {
          const converted = toHarnessTransportError(error, "Claude turn failed");
          const stderr = active.stderr.value();
          const message = stderr
            ? `${converted.message}\n\nClaude runtime stderr:\n${stderr}`
            : converted.message;
          this.#publishFailure(
            active,
            new OpensteerError({
              cause: error,
              code: converted.code,
              message,
              retryable: converted.retryable,
            }),
          );
        }
      }
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
      if (turnTimer) clearTimeout(turnTimer);
      if (active.endTimer) clearTimeout(active.endTimer);
      active.input.end();
      active.query?.close();
      delete active.query;
    }
  }

  async #pushTurnInputs(
    active: ActiveTurn,
    inputs: readonly HarnessInput[],
    turn: Pick<HarnessRunInput, "context" | "reports">,
    attachments?: ReadonlyMap<string, ResolvedAttachment>,
  ): Promise<void> {
    if (inputs.length === 0) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Claude turn inputs cannot be empty",
      });
    }
    const reportPrompt = harnessTurnPreamble(turn, (input) =>
      contentToPrompt(input, attachments, false),
    );
    const initialContext = initialContinuationContextPrompt(this.#context);
    const deliveryImageCount = inputs.reduce(
      (count, input) => count + resolvedInputParts(input, attachments).images.length,
      0,
    );
    const prompts = inputs.map((input, index) =>
      index === 0 && reportPrompt
        ? `${reportPrompt}\n\n${contentToPrompt(input, attachments)}`
        : contentToPrompt(input, attachments),
    );
    assertClaudeInputBytes(
      [
        ...prompts,
        currentRunContextPrompt(this.#context.machineAccessNotice),
        ...(initialContext ? [initialContext] : []),
      ],
      this.#config.maxTurnInputBytes,
    );
    for (const [index, input] of inputs.entries()) {
      const prompt = prompts[index];
      if (prompt === undefined) {
        throw new OpensteerError({
          code: "harness_error",
          message: "Claude turn input projection lost an input",
        });
      }
      await this.#pushInput(active, input, {
        attachments,
        deliveryImageCount,
        ...(index === 0 && initialContext ? { initialContext } : {}),
        ...(index === 0 && reportPrompt ? { reportPrompt } : {}),
        ...(index === inputs.length - 1
          ? { currentRunContext: this.#context.machineAccessNotice }
          : {}),
        prompt,
        shouldQuery: index === inputs.length - 1,
      });
    }
  }

  async #pushInput(
    active: ActiveTurn,
    input: HarnessInput,
    options: {
      readonly attachments?: ReadonlyMap<string, ResolvedAttachment> | undefined;
      readonly initialContext?: string;
      readonly currentRunContext?: string;
      readonly priority?: SDKUserMessage["priority"];
      readonly prompt?: string;
      readonly reportPrompt?: string;
      readonly signal?: AbortSignal | undefined;
      readonly shouldQuery: boolean;
      /** A message steered into the Run, which the Run then owes an answer. */
      readonly steered?: boolean;
      /** Images across every message of this delivery, which share one request. */
      readonly deliveryImageCount?: number;
    },
  ): Promise<void> {
    const prompt = options.prompt ?? contentToPrompt(input, options.attachments);
    assertClaudeInputBytes(
      options.currentRunContext
        ? [prompt, currentRunContextPrompt(options.currentRunContext)]
        : [prompt],
      this.#config.maxTurnInputBytes,
    );
    const images = resolvedInputParts(input, options.attachments).images;
    const blocks: ClaudeContentBlock[] = [];
    if (images.length === 0) blocks.push({ text: prompt, type: "text" });
    else {
      const maxBytes = nativeImageBase64Budget({
        count: options.deliveryImageCount ?? images.length,
        perImage: claudeImageMaxBase64,
        total: claudeDeliveryImageMaxBase64,
      });
      // One image at a time keeps decoding memory bounded to a single picture.
      for (const part of resolvedInputSequence(input, options.attachments)) {
        if (part.type === "text") {
          blocks.push({ text: part.text, type: "text" });
          continue;
        }
        const prepared = await prepareNativeImage(part.attachment, {
          ...claudeNativeImageLimits,
          maxBytes,
        });
        blocks.push({
          source: {
            data: prepared.bytes.toString("base64"),
            media_type: claudeImageMediaType(prepared.mediaType),
            type: "base64",
          },
          type: "image",
        });
      }
    }
    if (options.initialContext) blocks.unshift({ text: options.initialContext, type: "text" });
    if (options.signal?.aborted)
      throw new OpensteerError({
        code: "conflict",
        message: "Claude input was cancelled before delivery",
      });
    if (active.interrupted || active.terminal)
      throw new OpensteerError({
        code: "conflict",
        message: "Claude input stream is already closed",
      });
    // A client uuid lets each result say which of these messages it consumed.
    const uuid = randomUUID();
    if (!options.shouldQuery) active.contextOnly.add(uuid);
    else if (options.steered) active.unanswered.add(uuid);
    active.input.push(contentToUserMessage(input, prompt, { ...options, blocks, uuid }));
  }

  #queryOptions(environment: Record<string, string | undefined>, active: ActiveTurn): Options {
    const access = claudeAccessModeConfiguration(this.#context.accessMode);
    const systemAppend = this.#systemPromptAppend();
    const opensteerTools = toolsForCapabilityProfile(
      this.#context.agentTools.capabilityProfileId,
    ).map(({ name }) => `mcp__opensteer__${name}`);
    const integrationTools = integrationGatewayToolNames.map(
      (name) => `mcp__opensteer_integrations__${name}`,
    );
    const { options: selectedOptions } = this.#context.modelSelection;
    const effort = selectedOptions[claudeEffortOptionId];
    const options: Options = {
      abortController: active.abortController,
      // The signed Host profile is the authority for product tools. Letting
      // Claude ask again would turn a durable capability decision into
      // provider-specific approval noise; the Host still reauthorizes every
      // actual call against the live Run binding.
      allowedTools: [...new Set(["ToolSearch", ...opensteerTools, ...integrationTools])],
      canUseTool: this.#canUseTool(active),
      cwd: this.#context.workspacePath,
      additionalDirectories: [
        ...this.#context.writableRoots.filter((root) => root !== this.#context.workspacePath),
        ...(this.#context.attachmentDirectory ? [this.#context.attachmentDirectory] : []),
      ],
      env: { ...environment, ENABLE_TOOL_SEARCH: "true" },
      includePartialMessages: true,
      maxTurns: this.#config.maxTurns,
      managedSettings: managedClaudeSettings(this.#context),
      mcpServers: {
        opensteer: {
          alwaysLoad: false,
          timeout: 120_000,
          headers: { Authorization: `Bearer ${this.#context.agentTools.token}` },
          type: "http",
          url: this.#context.agentTools.url,
        },
        opensteer_integrations: {
          alwaysLoad: false,
          timeout: 120_000,
          headers: { Authorization: `Bearer ${this.#context.integrationTools.token}` },
          type: "http",
          url: this.#context.integrationTools.url,
        },
      },
      // A catalog folds a foreign endpoint's spelling onto the canonical pair
      // and keeps the original as `nativeModelId`; that original is the only
      // string such an account answers to. Claude Code's own catalog sets none.
      model: this.#context.modelSelection.nativeModelId ?? this.#context.modelSelection.modelId,
      pathToClaudeCodeExecutable: this.#dependencies.executable,
      permissionMode: access.permissionMode,
      ...(access.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      ...(this.#skillPlugin
        ? {
            plugins: [
              { path: this.#skillPlugin.path, skipMcpDiscovery: true, type: "local" as const },
            ],
            skills: [...this.#skillPlugin.skills],
          }
        : { skills: [] }),
      persistSession: true,
      settingSources: [],
      strictMcpConfig: true,
      systemPrompt: {
        append: systemAppend,
        excludeDynamicSections: true,
        preset: "claude_code",
        type: "preset",
      },
      tools: [...claudeBuiltinTools, claudeSubagentTool, claudeTaskStopTool],
      stderr: (chunk) => active.stderr.append(chunk),
      // The Runner's sandbox has to enclose the whole harness process tree, and
      // a custom spawn is the SDK's only seam for that. The SDK reads nothing
      // but stdin and stdout from what this returns — the `stderr` option above
      // is wired by the spawn it replaces — so stderr is forwarded here.
      spawnClaudeCodeProcess: ({ args, command, cwd, env, signal }) => {
        const environment: Record<string, string> = {};
        for (const [name, value] of Object.entries(env)) {
          if (value !== undefined) environment[name] = value;
        }
        const mcpConfig = privateMcpConfig(args, this.#context.threadStateDirectory);
        // The wrapper runs last so the Runner's sandbox sees the complete
        // command: every provider flag the SDK added is already in place.
        const launch = this.#context.wrapProcessLaunch({
          args: mcpConfig.args,
          cwd: cwd ?? this.#context.workspacePath,
          environment,
          executable: command,
        });
        const child = spawn(launch.executable, launch.args, {
          cwd: launch.cwd,
          env: { ...launch.environment },
          signal,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        child.once("exit", mcpConfig.remove);
        child.once("error", mcpConfig.remove);
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => active.stderr.append(chunk));
        return child;
      },
      ...(this.#hasProviderTranscript
        ? { resume: this.providerSessionReference }
        : { sessionId: this.providerSessionReference }),
      // The Host admits only a level Claude Code listed for this model.
      ...(typeof effort === "string" && effort !== claudeEngineDefaultEffort
        ? { effort: effort as NonNullable<Options["effort"]> }
        : {}),
      // Flag settings are the Agent SDK's opt-in to fast mode; without one
      // Claude Code refuses it as `sdk_opt_in_required`.
      ...(selectedOptions[claudeFastModeOptionId] === true ? { settings: { fastMode: true } } : {}),
      ...(this.#config.maxBudgetUsd ? { maxBudgetUsd: this.#config.maxBudgetUsd } : {}),
    };
    return options;
  }

  #canUseTool(active: ActiveTurn): CanUseTool {
    return async (toolName, input, options) => {
      if (active.abortController.signal.aborted || options.signal.aborted) {
        return { behavior: "deny", interrupt: true, message: "Opensteer interrupted the turn" };
      }
      this.#ensureRunStarted(active);
      // Starting a subagent is not itself an action: everything it does asks.
      if ((claudeDelegationTools as readonly string[]).includes(toolName)) {
        return { behavior: "allow", updatedInput: { ...input } };
      }
      const nodeId = await this.#requestingNode(active, options);
      if (toolName === "AskUserQuestion") {
        return this.#requestInput(input, options, nodeId);
      }
      return this.#requestApproval(toolName, input, options, active, nodeId);
    };
  }

  /**
   * The subagent a permission check comes from. Claude names the subagent by
   * its own id, which reaches the driver only with the subagent's report, and
   * the check can overtake that report; it waits a moment for it. One that
   * never comes is asked as the Run's own when no single subagent is running.
   */
  async #requestingNode(
    active: ActiveTurn,
    options: Parameters<CanUseTool>[2],
  ): Promise<ExecutionNodeId | undefined> {
    const agentId = options.agentID;
    if (!agentId) return undefined;
    const lookup = () => {
      const callId = active.agentCalls.get(agentId) ?? active.childToolCalls.get(options.toolUseID);
      return callId === undefined ? undefined : active.nodes.nodeId(callId);
    };
    const deadline = Date.now() + subagentAttributionWaitMs;
    let nodeId = lookup();
    while (nodeId === undefined && Date.now() < deadline && !options.signal.aborted) {
      await delay(25);
      nodeId = lookup();
    }
    if (nodeId !== undefined) return nodeId;
    const live = active.nodes.liveKeys();
    return live.length === 1 ? active.nodes.nodeId(live[0]!) : undefined;
  }

  #requestApproval(
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    options: Parameters<CanUseTool>[2],
    active: ActiveTurn,
    nodeId: ExecutionNodeId | undefined,
  ): Promise<PermissionResult> {
    const requestId = createId("request");
    const callId = requireNonEmptyString(options.toolUseID, "Claude tool call id");
    const detail = options.description ?? options.title ?? describeToolRequest(toolName, input);
    const responses = new Map<string, PermissionResult>([
      [
        "allow-once",
        {
          behavior: "allow",
          decisionClassification: "user_temporary",
          updatedInput: { ...input },
        },
      ],
      [
        "reject",
        {
          behavior: "deny",
          decisionClassification: "user_reject",
          message: "The user denied this action",
        },
      ],
    ]);
    const requestOptions: Extract<PendingRequest["presentation"], { kind: "choice" }>["options"] = [
      { hint: "allow-once", id: "allow-once", label: "Allow once" },
    ];
    if (options.suggestions && options.suggestions.length > 0) {
      responses.set("allow-run", {
        behavior: "allow",
        decisionClassification: "user_permanent",
        updatedInput: { ...input },
        updatedPermissions: options.suggestions.map((suggestion) => ({
          ...suggestion,
          destination: "session",
        })),
      });
      requestOptions.push({
        hint: "allow-for-run",
        id: "allow-run",
        label: "Allow for this Run",
      });
    }
    requestOptions.push({ hint: "reject-once", id: "reject", label: "Reject" });
    return new Promise<PermissionResult>((resolvePermission) => {
      const abort = () => {
        const pending = this.#pendingRequests.get(requestId);
        if (!pending) return;
        this.#pendingRequests.delete(requestId);
        pending.abort();
        this.#publish({
          data: { reason: "source-closed", requestId },
          type: "request.cancelled",
        });
        resolvePermission({
          behavior: "deny",
          interrupt: active.interrupted || active.abortController.signal.aborted,
          message: "Opensteer cancelled the pending approval",
        });
      };
      this.#pendingRequests.set(requestId, {
        abort: () => options.signal.removeEventListener("abort", abort),
        responses,
        resolve: resolvePermission,
        type: "approval",
      });
      this.#publish({
        data: {
          request: this.#pendingRequest(
            requestId,
            callId,
            "harness.approval",
            {
              detail,
              kind: "choice",
              options: requestOptions,
              risk: classifyToolRisk(toolName),
              title: options.displayName ?? options.title ?? `Approve ${toolName}`,
            },
            nodeId,
          ),
        },
        type: "request.opened",
      });
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    });
  }

  #requestInput(
    input: Readonly<Record<string, unknown>>,
    options: Parameters<CanUseTool>[2],
    nodeId: ExecutionNodeId | undefined,
  ): Promise<PermissionResult> {
    const questions = parseQuestions(input);
    const requestId = createId("request");
    const callId = requireNonEmptyString(options.toolUseID, "Claude tool call id");
    const { signal } = options;
    return new Promise<PermissionResult>((resolvePermission) => {
      const abort = () => {
        const pending = this.#pendingRequests.get(requestId);
        if (!pending) return;
        this.#pendingRequests.delete(requestId);
        pending.abort();
        this.#publish({
          data: { reason: "source-closed", requestId },
          type: "request.cancelled",
        });
        resolvePermission({
          behavior: "deny",
          interrupt: true,
          message: "Opensteer cancelled the pending input request",
        });
      };
      this.#pendingRequests.set(requestId, {
        abort: () => signal.removeEventListener("abort", abort),
        input,
        questions,
        resolve: resolvePermission,
        type: "input",
      });
      this.#publish({
        data: {
          request: this.#pendingRequest(
            requestId,
            callId,
            "harness.input",
            {
              fields: questions.map(({ question }) => ({
                ...(question.choices ? { choices: question.choices } : {}),
                id: question.id,
                multiSelect: question.multiSelect,
                prompt: question.prompt,
                secret: question.secret,
              })),
              kind: "form",
              title: "More information needed",
            },
            nodeId,
          ),
        },
        type: "request.opened",
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  #pendingRequest(
    id: RequestId,
    callId: string,
    kind: "harness.approval" | "harness.input",
    presentation: PendingRequest["presentation"],
    nodeId: ExecutionNodeId | undefined,
  ): PendingRequest {
    const active = this.#activeTurn;
    if (!active || active.terminal) {
      throw new OpensteerError({
        code: "harness_error",
        message: "Claude opened a Request without an active turn",
      });
    }
    return {
      callId,
      cancellationReason: null,
      createdAt: new Date().toISOString(),
      id,
      kind,
      mode: "live",
      ...(nodeId ? { originatingNodeId: nodeId } : {}),
      originatingOccurrenceId: null,
      originatingRunId: active.runId,
      originatingThreadId: this.#context.threadId,
      originatingWorkspaceId: this.#context.workspaceId,
      payload: { kind },
      presentation,
      requestedBy: active.requestedBy,
      requiredActor: "requester",
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
      targetWorkspaceId: this.#context.workspaceId,
    };
  }

  #handleMessage(message: SDKMessage, active: ActiveTurn): void {
    this.#assertMessageSession(message);
    // Claude reports where each uuid-stamped message is in its queue in a frame
    // the SDK does not type. Results already say which messages a turn consumed.
    const frame: string = message.type;
    if (frame === "command_lifecycle") return;

    if (message.type === "system" && message.subtype === "init") {
      this.#validateInit(message);
      // Every turn opens with its own init: one after the first is a turn a
      // finished task woke, or a message steered in, inside this same Run.
      if (active.sawInit && active.idle && !active.terminal) {
        active.idle = false;
        active.wakePending = false;
        active.queuedTurns = false;
        if (active.endTimer) clearTimeout(active.endTimer);
        active.turnDeadline?.(true);
        this.#publish({ data: { phase: "turn" }, type: "run.phase" });
      }
      active.sawInit = true;
      this.#hasProviderTranscript = true;
      return;
    }
    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      active.background.clear();
      for (const task of message.tasks) if (!task.ambient) active.background.add(task.task_id);
      this.#endIfSettled(active);
      return;
    }
    if (message.type === "system" && message.subtype === "task_updated") {
      if (message.patch.is_backgrounded === true) {
        this.#backgroundTask(
          active,
          message.task_id,
          message.patch.description ?? null,
          null,
          null,
        );
      }
      return;
    }
    if (message.type === "system" && message.subtype === "task_notification") {
      this.#settleBackgroundTask(active, message);
      return;
    }
    if (!active.sawInit) {
      this.#markUnusable("Claude emitted an event before its required initialization event");
    }

    if (message.type === "system" && message.subtype === "task_started") {
      // Names the subagent the way `canUseTool` will: its id is the task's.
      if (message.tool_use_id && message.task_type !== "local_bash") {
        active.agentCalls.set(message.task_id, message.tool_use_id);
        active.nodes.update(message.tool_use_id, { title: message.description });
      }
      if (message.is_backgrounded === true) {
        this.#backgroundTask(
          active,
          message.task_id,
          message.description,
          message.tool_use_id ?? null,
          message.task_type ?? null,
        );
      }
      return;
    }
    // A subagent's messages are its own steps and result: they never become
    // Opensteer Thread messages or the root answer's text.
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) {
      this.#handleSubagentMessage(message, message.parent_tool_use_id, active);
      return;
    }

    if (message.type === "stream_event") {
      this.#ensureRunStarted(active);
      this.#handleStreamEvent(message.event);
      return;
    }
    if (message.type === "assistant") {
      this.#ensureRunStarted(active);
      if (message.error) this.#lastAssistantError = message.error;
      this.#handleAssistantContent(message.message.content);
      this.#openSubagents(message.message.content, null, active);
      return;
    }
    if (message.type === "user") {
      if (!("isReplay" in message && message.isReplay === true)) this.#ensureRunStarted(active);
      this.#handleUserContent(message.message.content);
      this.#settleSubagents(message.message.content, message.tool_use_result, active);
      return;
    }
    // Claude states a subscription's remaining capacity rather than describing
    // it in prose: `rejected` is the plan refusing further work, which is the
    // one condition another account can answer.
    if (message.type === "rate_limit_event") {
      this.#planRejected = message.rate_limit_info.status === "rejected";
      return;
    }
    if (message.type === "result") {
      this.#ensureRunStarted(active);
      // Claude's own account of what this Run cost, before the Run ends. A
      // later result belongs to a turn this Run no longer owns, so the
      // already-claimed terminal is what excludes it.
      const usage = active.terminal ? undefined : claudeRunUsage(message);
      if (usage) active.usage = usage;
      const consumed =
        message.user_message_uuids ??
        (message.user_message_uuid ? [message.user_message_uuid] : []);
      for (const uuid of consumed) active.unanswered.delete(uuid);
      active.queuedTurns = (message.queued_turn_count ?? 0) > 0;
      // Claude's receipt for context sent ahead of the message that asks.
      if (
        message.subtype === "success" &&
        !message.is_error &&
        consumed.length > 0 &&
        consumed.every((uuid) => active.contextOnly.has(uuid))
      )
        return;
      if (message.subtype === "success" && !message.is_error) {
        const text = message.result || this.#latestAssistantText;
        this.#publish({
          data: { content: [{ text, type: "text" }], messageId: createId("message") },
          type: "assistant.message",
        });
        // The turn answered. Work it started in the background keeps the Run,
        // and so does a steered message Claude runs as a turn of its own.
        if (
          active.background.size > 0 ||
          active.wakePending ||
          active.unanswered.size > 0 ||
          active.queuedTurns
        ) {
          active.idle = true;
          active.turnDeadline?.(false);
          this.#publish({ data: { phase: "background" }, type: "run.phase" });
          this.#endIfSettled(active);
          return;
        }
        this.#completeRun(active);
      } else {
        const errors = "errors" in message ? message.errors.filter(Boolean).join("; ") : "";
        const providerDetail =
          errors ||
          (this.#lastAssistantError ? this.#latestAssistantText : "") ||
          ("result" in message ? message.result : "") ||
          this.#latestAssistantText ||
          "Claude execution failed";
        const detail =
          this.#lastAssistantError === "authentication_failed"
            ? `${providerDetail}. Sign in to Claude again.`
            : providerDetail;
        const failureMessage =
          message.subtype === "success" ? detail : `${message.subtype}: ${detail}`;
        const retryable = isRetryableClaudeFailure(this.#lastAssistantError);
        this.#publishFailure(
          active,
          new OpensteerError({
            code: "harness_error",
            message: failureMessage,
            retryable,
          }),
        );
      }
    }
  }

  #ensureRunStarted(active: ActiveTurn): void {
    if (active.started) return;
    active.started = true;
    this.#publish(runStartedEvent());
  }

  /** The Run is done: its last turn answered and nothing it started still runs. */
  #completeRun(active: ActiveTurn): void {
    if (active.endTimer) clearTimeout(active.endTimer);
    if (!this.#publisher.claimTerminal(active)) return;
    this.#cancelPendingRequests("Claude Run ended before the user responded", "run-ended");
    active.nodes.endAll();
    this.#publishUsage(active);
    this.#publish(runEndedEvent("completed"));
    active.input.end();
  }

  /**
   * Ends a Run between turns once its background work is gone. A finished
   * task's notification may still wake a turn, which nothing announces, so
   * the Run waits the CLI's own grace for one first.
   */
  #endIfSettled(active: ActiveTurn): void {
    if (!active.idle || active.terminal || active.background.size > 0) return;
    // A message Claude has not answered yet starts a turn of its own.
    if (active.unanswered.size > 0 || active.queuedTurns) return;
    if (!active.wakePending) {
      this.#completeRun(active);
      return;
    }
    if (active.endTimer) clearTimeout(active.endTimer);
    active.endTimer = setTimeout(() => {
      if (
        active.idle &&
        active.background.size === 0 &&
        active.unanswered.size === 0 &&
        !active.queuedTurns
      )
        this.#completeRun(active);
    }, backgroundWakeGraceMs);
    active.endTimer.unref();
  }

  /** A task left running past its turn: a background subagent, or a shell as a task node. */
  #backgroundTask(
    active: ActiveTurn,
    taskId: string,
    description: string | null,
    toolUseId: string | null,
    taskType: string | null,
  ): void {
    active.background.add(taskId);
    if (active.agentCalls.has(taskId) || (toolUseId && active.nodes.nodeId(toolUseId))) return;
    if (taskType !== null && taskType !== "local_bash") return;
    active.nodes.ensure(`task:${taskId}`, {
      kind: "task",
      nativeRef: taskId,
      originCallId: toolUseId,
      title: description,
    });
  }

  /** A background task finished; its notification may wake a turn of its own. */
  #settleBackgroundTask(
    active: ActiveTurn,
    message: Extract<SDKMessage, { type: "system"; subtype: "task_notification" }>,
  ): void {
    active.background.delete(message.task_id);
    if (!message.ambient && !message.skip_transcript) active.wakePending = true;
    const outcome =
      message.status === "completed"
        ? "completed"
        : message.status === "failed"
          ? "failed"
          : "interrupted";
    const callId = active.agentCalls.get(message.task_id);
    active.nodes.complete(callId ?? `task:${message.task_id}`, outcome, {
      result: message.summary || null,
    });
    this.#endIfSettled(active);
  }

  /** What the Run consumed, stated once and always before its terminal event. */
  #publishUsage(active: ActiveTurn): void {
    const usage = active.usage;
    if (!usage) return;
    delete active.usage;
    this.#publish({ data: usage, type: "run.usage" });
  }

  #handleStreamEvent(event: SDKMessage extends never ? never : unknown): void {
    if (!isRecord(event) || typeof event.type !== "string") return;
    if (event.type === "content_block_start") {
      const contentBlock = isRecord(event.content_block) ? event.content_block : undefined;
      if (contentBlock?.type === "tool_use") {
        const callId = requireNonEmptyString(contentBlock.id, "Claude tool call id");
        const name = requireNonEmptyString(contentBlock.name, "Claude tool name");
        if (typeof event.index === "number") this.#streamToolCalls.set(event.index, callId);
        if (!this.#startedToolCalls.has(callId)) {
          this.#startedToolCalls.add(callId);
          this.#streamedArgumentToolCalls.add(callId);
          this.#publish({
            data: { arguments: contentBlock.input ?? {}, callId, tool: claudeToolIdentity(name) },
            type: "tool.started",
          });
        }
      }
      if (contentBlock?.type === "thinking" && typeof event.index === "number") {
        this.#streamThinkingBlocks.set(event.index, {
          blockId: this.#nextThinkingBlockId(),
          text: "",
        });
      }
      return;
    }
    if (event.type === "content_block_stop") {
      const index = typeof event.index === "number" ? event.index : undefined;
      const block = index === undefined ? undefined : this.#streamThinkingBlocks.get(index);
      if (index !== undefined && block) {
        this.#streamThinkingBlocks.delete(index);
        this.#completedThinkingBlocks.add(block.blockId);
        this.#publish({
          data: { blockId: block.blockId, text: truncateThinkingText(block.text) },
          type: "reasoning.completed",
        });
      }
      return;
    }
    if (event.type !== "content_block_delta") return;
    const delta = isRecord(event.delta) ? event.delta : undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      this.#publish({ data: { text: delta.text }, type: "assistant.delta" }, "disposable");
      return;
    }
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      const index = typeof event.index === "number" ? event.index : undefined;
      const block = index === undefined ? undefined : this.#streamThinkingBlocks.get(index);
      if (block) {
        block.text += delta.thinking;
        this.#publish(
          { data: { blockId: block.blockId, text: delta.thinking }, type: "reasoning.delta" },
          "disposable",
        );
      }
      return;
    }
    if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const index = typeof event.index === "number" ? event.index : undefined;
      const callId = index === undefined ? undefined : this.#toolCallIdAtIndex(index);
      if (callId) {
        this.#publish(
          {
            data: { callId, text: normalizeToolOutput(delta.partial_json).text },
            type: "tool.delta",
          },
          "disposable",
        );
      }
    }
  }

  #handleAssistantContent(content: unknown): void {
    if (!Array.isArray(content)) return;
    let text = "";
    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== "string") continue;
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      if (block.type === "tool_use") {
        const callId = requireNonEmptyString(block.id, "Claude tool call id");
        const name = requireNonEmptyString(block.name, "Claude tool name");
        const restates = this.#streamedArgumentToolCalls.delete(callId);
        if (restates || !this.#startedToolCalls.has(callId)) {
          this.#startedToolCalls.add(callId);
          this.#publish({
            data: { arguments: block.input ?? {}, callId, tool: claudeToolIdentity(name) },
            type: "tool.started",
          });
        }
      }
      if (block.type === "thinking" && typeof block.thinking === "string") {
        this.#assistantThinkingBlocksSeen += 1;
        if (this.#assistantThinkingBlocksSeen > this.#completedThinkingBlocks.size) {
          const blockId = this.#nextThinkingBlockId();
          this.#completedThinkingBlocks.add(blockId);
          this.#publish({
            data: { blockId, text: truncateThinkingText(block.thinking) },
            type: "reasoning.completed",
          });
        }
      }
    }
    if (text) this.#latestAssistantText = text;
  }

  #handleUserContent(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const callId = requireNonEmptyString(block.tool_use_id, "Claude tool result id");
      this.#publish({
        data: {
          callId,
          isError: block.is_error === true,
          output: normalizeToolOutput(block.content ?? null),
        },
        type: "tool.completed",
      });
    }
  }

  /** Opens a node for each Agent call, under the subagent that made it when one did. */
  #openSubagents(content: unknown, parentCallId: string | null, active: ActiveTurn): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (!(claudeDelegationTools as readonly string[]).includes(name)) continue;
      const callId = requireNonEmptyString(block.id, "Claude tool call id");
      const input = isRecord(block.input) ? block.input : {};
      active.nodes.ensure(callId, {
        model: typeof input.model === "string" ? input.model : null,
        nativeRef: callId,
        originCallId: callId,
        parentKey: parentCallId,
        prompt: typeof input.prompt === "string" ? input.prompt : null,
        title: typeof input.description === "string" ? input.description : null,
      });
    }
  }

  /** Ends the node of each Agent call whose result arrived, with what it returned. */
  #settleSubagents(content: unknown, toolUseResult: unknown, active: ActiveTurn): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (!active.nodes.nodeId(callId)) continue;
      const output = isRecord(toolUseResult) ? toolUseResult : {};
      // A background subagent's call returns at launch; it ends with its task.
      if (output.status === "async_launched") continue;
      if (typeof output.resolvedModel === "string") {
        active.nodes.update(callId, { model: output.resolvedModel });
      }
      // Claude states only its last model call's usage for a subagent, which
      // is not what the subagent consumed; the Run's own usage includes it.
      active.nodes.complete(callId, block.is_error === true ? "failed" : "completed", {
        result: claudeTextContent(output.content) ?? claudeTextContent(block.content),
      });
    }
  }

  /** A subagent's own message: its tool calls and results, attributed to its node. */
  #handleSubagentMessage(message: SDKMessage, parentCallId: string, active: ActiveTurn): void {
    if (message.type !== "assistant" && message.type !== "user") return;
    this.#ensureRunStarted(active);
    const nodeId = active.nodes.ensure(parentCallId, {
      nativeRef: parentCallId,
      originCallId: parentCallId,
    });
    const content: unknown = message.message.content;
    if (!Array.isArray(content)) return;
    if (message.type === "assistant") {
      let text = "";
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") text += block.text;
        if (block.type !== "tool_use") continue;
        const callId = requireNonEmptyString(block.id, "Claude tool call id");
        const name = requireNonEmptyString(block.name, "Claude tool name");
        active.childToolCalls.set(callId, parentCallId);
        this.#publish({
          data: { arguments: block.input ?? {}, callId, nodeId, tool: claudeToolIdentity(name) },
          type: "tool.started",
        });
      }
      if (text) active.nodes.noteResult(parentCallId, text);
      this.#openSubagents(content, parentCallId, active);
      return;
    }
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const callId = requireNonEmptyString(block.tool_use_id, "Claude tool result id");
      this.#publish({
        data: {
          callId,
          isError: block.is_error === true,
          nodeId,
          output: normalizeToolOutput(block.content ?? null),
        },
        type: "tool.completed",
      });
    }
    this.#settleSubagents(content, message.tool_use_result, active);
  }

  #toolCallIdAtIndex(index: number): string | undefined {
    return this.#streamToolCalls.get(index);
  }

  #nextThinkingBlockId(): string {
    this.#thinkingBlockCounter += 1;
    return `thinking_${this.#thinkingBlockCounter}`;
  }

  #validateInit(message: Extract<SDKMessage, { type: "system"; subtype: "init" }>): void {
    if (!meetsMinimumVersion(message.claude_code_version, MINIMUM_CLAUDE_CODE_VERSION)) {
      this.#markUnusable(
        `Claude Code ${message.claude_code_version} is older than Opensteer supports; update it to ${MINIMUM_CLAUDE_CODE_VERSION} or newer`,
      );
    }
    const unexpectedMcpServers = message.mcp_servers
      .map(({ name }) => name)
      .filter((name) => !opensteerMcpServerNames.has(name));
    if (unexpectedMcpServers.length > 0) {
      this.#markUnusable(
        `Claude exposed MCP servers outside the Opensteer runtime boundary: ${unexpectedMcpServers.join(", ")}`,
      );
    }
    const builtinTools = new Set<string>([
      ...claudeBuiltinTools,
      ...claudeDelegationTools,
      claudeTaskStopTool,
    ]);
    const unexpectedTools = message.tools.filter(
      (name) =>
        !builtinTools.has(name) &&
        !name.startsWith("mcp__opensteer__") &&
        !name.startsWith("mcp__opensteer_integrations__"),
    );
    if (unexpectedTools.length > 0) {
      this.#markUnusable(
        `Claude exposed tools outside the Opensteer runtime boundary: ${unexpectedTools.join(", ")}`,
      );
    }
    const unexpectedPlugins = message.plugins.filter(
      ({ name, path }) =>
        path !== this.#skillPlugin?.path && !(path === "builtin" && claudeBuiltinPlugins.has(name)),
    );
    if (unexpectedPlugins.length > 0) {
      this.#markUnusable(
        `Claude exposed plugins outside the Opensteer runtime boundary: ${unexpectedPlugins.map(({ name }) => name).join(", ")}`,
      );
    }
    const advertised = new Set(message.capabilities ?? []);
    const missing = requiredRuntimeCapabilities.filter((capability) => !advertised.has(capability));
    if (missing.length > 0) {
      this.#markUnusable(`Claude runtime is missing required capabilities: ${missing.join(", ")}`);
    }
  }

  #assertMessageSession(message: SDKMessage): void {
    if (!("session_id" in message) || message.session_id === undefined) return;
    if (message.session_id !== this.providerSessionReference) {
      this.#markUnusable(
        `Claude emitted session ${message.session_id} for Opensteer session ${this.providerSessionReference}`,
      );
    }
  }

  #systemPromptAppend(): string {
    return [this.#context.platformGuide, this.#config.systemPrompt, this.#context.instructions]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
  }

  #publishFailure(active: ActiveTurn, error: OpensteerError): void {
    if (!this.#publisher.claimTerminal(active)) return;
    this.#cancelPendingRequests("Claude Run ended before the user responded", "run-ended");
    active.nodes.endAll();
    this.#publishUsage(active);
    this.#publish(
      runFailedEvent({
        code: this.#failureCode(error),
        message: sanitizeErrorMessage(
          error.message,
          active.environment,
          this.#config.maxErrorMessageBytes,
        ),
        retryable: error.retryable,
      }),
    );
  }

  /**
   * An exhausted plan is promoted to the shared code so the reader is offered
   * another account, instead of a provider word only this driver understands.
   */
  #failureCode(error: OpensteerError): string {
    if (this.#planRejected) return harnessUsageLimitFailureCode;
    return error.code === "harness_error" ? "claude_harness_error" : error.code;
  }

  #publishInterrupted(active: ActiveTurn): void {
    if (!this.#publisher.claimTerminal(active)) return;
    this.#cancelPendingRequests("Claude Run was interrupted", "run-ended");
    active.nodes.endAll();
    this.#publishUsage(active);
    this.#publish(runEndedEvent("interrupted"));
  }

  #publish(event: HarnessEvent, delivery: "must-deliver" | "disposable" = "must-deliver"): void {
    this.#publisher.publish(event, delivery);
  }

  #abortActive(active: ActiveTurn, reason: unknown): void {
    if (!active.abortController.signal.aborted) active.abortController.abort(reason);
    active.input.end();
    active.query?.close();
    this.#cancelPendingRequests("Opensteer cancelled the pending Claude request", "run-ended");
  }

  #cancelPendingRequests(message: string, reason: "run-ended" | "source-closed"): void {
    let publishError: unknown;
    for (const [requestId, pending] of this.#pendingRequests) {
      this.#pendingRequests.delete(requestId);
      pending.abort();
      if (!this.#publisher.streamClosed) {
        try {
          this.#publish({ data: { reason, requestId }, type: "request.cancelled" });
        } catch (error) {
          publishError ??= error;
        }
      }
      pending.resolve({ behavior: "deny", interrupt: true, message });
    }
    if (publishError) throw publishError;
  }

  async #stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#activeTurn;
    if (active && !active.terminal) {
      active.interrupted = true;
      this.#abortActive(active, new Error("Claude session stopped"));
      await active.completion.promise;
    }
    this.#cancelPendingRequests("Claude session stopped", "run-ended");
    this.#context.signal.removeEventListener("abort", this.#lifetimeAbortListener);
    this.#publisher.closeStream();
    this.#onClose(this);
  }

  #assertUsable(): void {
    if (this.#publisher.unusable) throw this.#publisher.unusable;
    if (this.#closed) {
      throw new OpensteerError({ code: "harness_error", message: "Claude session is closed" });
    }
  }

  #markUnusable(message: string): never {
    const error = new OpensteerError({ code: "harness_error", message });
    this.#publisher.latchUnusable(error);
    throw error;
  }
}

function validateProviderSessionReference(reference: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(reference)
  ) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Claude provider session reference must be a UUID",
    });
  }
  return reference;
}

function mergeEnvironments(
  sessionEnvironment: Readonly<Record<string, string>>,
  turnEnvironment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return { ...sessionEnvironment, ...turnEnvironment };
}

async function claudeProviderEnvironment(
  supplied: Readonly<Record<string, string>>,
  provider: ClaudeHarnessConfig["provider"],
  providerState: HarnessProviderState,
): Promise<Record<string, string | undefined>> {
  const providerHome = providerState.providerHomeDirectory;
  if (providerState.kind === "isolated" && !providerHome) {
    throw new Error("Isolated Claude profile has no provider home");
  }
  if (providerState.kind === "isolated") {
    const environment = buildClaudeEnvironment(
      { ...supplied, CLAUDE_CONFIG_DIR: providerHome! },
      provider,
    );
    if (provider === "anthropic") {
      const apiKey = await claudeProfileApiKey(providerState).read();
      if (apiKey !== undefined) environment.ANTHROPIC_API_KEY = apiKey;
    }
    return environment;
  }
  return buildClaudeEnvironment(supplied, provider);
}

const claudeProfileApiKeyFileName = ".opensteer-anthropic-api-key";
/** Generous next to the longest key Anthropic issues, and far short of a file. */
const claudeProfileApiKeyMaxBytes = 32 * 1_024;
const claudeProfileApiKeyMaxLength = 16_384;

/** The Anthropic key this profile holds, when the profile keeps one of its own. */
function claudeProfileApiKey(providerState: HarnessProviderState) {
  return providerSecretFile(providerState, claudeProfileApiKeyFileName, {
    description: "Anthropic API key",
    maximumBytes: claudeProfileApiKeyMaxBytes,
  });
}

async function removeClaudeProfileApiKey(providerState: HarnessProviderState): Promise<void> {
  // An ambient profile never held a key of its own; the machine's own Claude
  // configuration is not Opensteer's to edit.
  if (providerState.kind !== "isolated") return;
  await claudeProfileApiKey(providerState).remove();
}

function buildClaudeEnvironment(
  supplied: Readonly<Record<string, string>>,
  provider: ClaudeHarnessConfig["provider"],
): Record<string, string | undefined> {
  assertProviderConfiguration(supplied, provider);
  const environment: Record<string, string | undefined> = {};
  for (const key of inheritedEnvironmentKeys) {
    const value = supplied[key] ?? process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  Object.assign(environment, supplied);

  for (const flag of providerRouteFlags) {
    delete environment[flag];
  }
  if (provider === "bedrock") environment.CLAUDE_CODE_USE_BEDROCK = "1";
  if (provider === "vertex") environment.CLAUDE_CODE_USE_VERTEX = "1";
  if (provider === "foundry") environment.CLAUDE_CODE_USE_FOUNDRY = "1";

  environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  environment.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = "1";
  environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  environment.CLAUDE_CODE_DISABLE_WORKFLOWS = "1";
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = "opensteer/0.0.0";
  // A model-executed session must never sign this profile — or the machine's
  // own ambient Claude configuration — in or out.
  environment.DISABLE_LOGIN_COMMAND = "1";
  environment.DISABLE_LOGOUT_COMMAND = "1";
  environment.DISABLE_UPGRADE_COMMAND = "1";
  environment.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return environment;
}

function assertProviderConfiguration(
  supplied: Readonly<Record<string, string>>,
  provider: ClaudeHarnessConfig["provider"],
): void {
  const selectedFlag =
    provider === "anthropic"
      ? undefined
      : provider === "bedrock"
        ? "CLAUDE_CODE_USE_BEDROCK"
        : provider === "vertex"
          ? "CLAUDE_CODE_USE_VERTEX"
          : "CLAUDE_CODE_USE_FOUNDRY";
  const allowedFlags = new Set<string>(selectedFlag ? [selectedFlag] : []);
  for (const flag of providerRouteFlags) {
    if (!allowedFlags.has(flag) && isTruthyEnvironmentValue(supplied[flag])) {
      throw new OpensteerError({
        code: "bad_request",
        message: `${flag} conflicts with configured Claude provider ${provider}`,
      });
    }
  }
  if (provider !== "anthropic" && (supplied.ANTHROPIC_API_KEY || supplied.ANTHROPIC_AUTH_TOKEN)) {
    throw new OpensteerError({
      code: "bad_request",
      message: `Anthropic API credentials conflict with configured Claude provider ${provider}`,
    });
  }
}

function isTruthyEnvironmentValue(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false", "no"].includes(value.toLowerCase());
}

function contentToPrompt(
  input: HarnessInput,
  attachments?: ReadonlyMap<string, ResolvedAttachment>,
  allowImages = true,
): string {
  const projected = resolvedInputParts(input, attachments);
  if (!allowImages && projected.images.length > 0)
    throw new OpensteerError({
      code: "bad_request",
      message: "Claude report context cannot contain native image input",
    });
  return claudeReadsHeader(input) ? harnessInputHeader(input, projected.body) : projected.body;
}

/**
 * Whether Claude reads a text input under the shared header. Claude Code's own
 * origin names a person or a peer agent in full, but an automation only as a
 * notification, without its name or occurrence, and it has no place for a quote.
 */
function claudeReadsHeader(input: HarnessInput): boolean {
  return (
    input.quote !== undefined || input.author.kind === "trigger" || input.author.kind === "watch"
  );
}

type ClaudeContentBlock =
  | { readonly text: string; readonly type: "text" }
  | {
      readonly source: {
        readonly data: string;
        readonly media_type: "image/png" | "image/jpeg" | "image/webp";
        readonly type: "base64";
      };
      readonly type: "image";
    };

/**
 * Claude Code fits the images of the prompt that starts a turn to 2000×2000
 * and 5 MiB of base64, but sends a message added to a running turn as it is
 * and fails the turn when an image exceeds 5 MiB. Every image is fitted here to
 * what Claude Code itself would send, so both paths deliver the same picture.
 */
const claudeNativeImageLimits = {
  maxEdge: 2_000,
  mediaTypes: attachmentNativeImageMediaTypes,
} as const;
const claudeImageMaxBase64 = 5 * 1_024 * 1_024;
/** The Messages API takes 32 MiB per request; a delivery's images leave 8 MiB for the rest. */
const claudeDeliveryImageMaxBase64 = 24 * 1_024 * 1_024;

function claudeImageMediaType(value: string): "image/png" | "image/jpeg" | "image/webp" {
  if (value === "image/png" || value === "image/jpeg" || value === "image/webp") return value;
  throw new OpensteerError({
    code: "bad_request",
    message: `Claude cannot accept ${value} image input`,
  });
}

function assertClaudeInputBytes(prompts: readonly string[], maxBytes: number): void {
  const bytes = prompts.reduce((total, prompt) => total + Buffer.byteLength(prompt, "utf8"), 0);
  if (bytes > maxBytes) {
    throw new OpensteerError({
      code: "bad_request",
      message: `Claude turn input is ${bytes} bytes, exceeding the configured ${maxBytes}-byte limit`,
    });
  }
}

function currentRunContextPrompt(machineAccessNotice: string): string {
  return `${currentRunContextHeading}\n${machineAccessNotice}`;
}

/**
 * Mirrors the message the SDK writes for a one-shot string prompt so streaming
 * input reaches the runtime as the same user turn.
 */
function contentToUserMessage(
  input: HarnessInput,
  prompt: string,
  options: {
    readonly blocks?: readonly ClaudeContentBlock[];
    readonly reportPrompt?: string;
    readonly currentRunContext?: string;
    readonly priority?: SDKUserMessage["priority"];
    readonly shouldQuery: boolean;
    readonly uuid?: SDKUserMessage["uuid"];
  },
): SDKUserMessage {
  return {
    message: {
      content: [
        ...(options.currentRunContext
          ? [
              {
                text: currentRunContextPrompt(options.currentRunContext),
                type: "text" as const,
              },
            ]
          : []),
        ...(options.reportPrompt && options.blocks?.some((block) => block.type === "image")
          ? [{ text: options.reportPrompt, type: "text" as const }]
          : []),
        ...(options.blocks ?? [{ text: prompt, type: "text" as const }]),
      ],
      role: "user",
    },
    origin: claudeMessageOrigin(input, prompt),
    parent_tool_use_id: null,
    ...(options.priority ? { priority: options.priority } : {}),
    shouldQuery: options.shouldQuery,
    session_id: "",
    timestamp: input.createdAt,
    type: "user",
    ...(options.uuid ? { uuid: options.uuid } : {}),
  };
}

function claudeMessageOrigin(input: HarnessInput, body: string): SDKMessageOrigin {
  const author = input.author;
  switch (author.kind) {
    case "human":
      return { kind: "human" };
    case "agent":
      return { body, from: author.threadId, kind: "peer", name: author.displayName };
    case "trigger":
      return author.source === "schedule"
        ? { kind: "task-notification", subkind: "scheduled-trigger" }
        : { kind: "task-notification" };
    case "watch":
      return { kind: "task-notification" };
    case "platform":
      return { kind: "task-notification" };
  }
}

function parseQuestions(input: Readonly<Record<string, unknown>>): readonly ParsedQuestion[] {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 3) {
    throw new OpensteerError({
      code: "harness_error",
      message: "Claude AskUserQuestion must contain between one and three questions",
    });
  }
  return input.questions.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new OpensteerError({
        code: "harness_error",
        message: "Claude emitted an invalid question",
      });
    }
    const providerPrompt = requireNonEmptyString(candidate.question, "Claude question prompt");
    const choices = parseQuestionChoices(candidate.options);
    const id = `question_${index + 1}`;
    return {
      id,
      providerPrompt,
      question: {
        ...(choices ? { choices: [...choices] } : {}),
        id,
        multiSelect: candidate.multiSelect === true,
        prompt: providerPrompt,
        secret: false,
      },
    };
  });
}

function parseQuestionChoices(value: unknown): RequestFormField["choices"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new OpensteerError({
      code: "harness_error",
      message: "Claude emitted an invalid question choices list",
    });
  }
  const choices = value.map((option) => {
    if (!isRecord(option)) {
      throw new OpensteerError({
        code: "harness_error",
        message: "Claude emitted an invalid question choice",
      });
    }
    const label = requireNonEmptyString(option.label, "Claude question choice label");
    const description =
      option.description === undefined
        ? undefined
        : requireNonEmptyString(option.description, "Claude question choice description");
    return { ...(description ? { description } : {}), label, value: label };
  });
  return choices.length > 0 ? choices : undefined;
}

function validateAnswers(questions: readonly ParsedQuestion[], answers: RequestFormAnswers): void {
  const expected = new Set(questions.map(({ id }) => id));
  const actual = Object.keys(answers);
  const unexpected = actual.filter((id) => !expected.has(id));
  const missing = questions.filter(({ id }) => !(id in answers)).map(({ id }) => id);
  if (unexpected.length > 0 || missing.length > 0) {
    throw new OpensteerError({
      code: "bad_request",
      message: [
        unexpected.length > 0 ? `unexpected answers: ${unexpected.join(", ")}` : "",
        missing.length > 0 ? `missing answers: ${missing.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    });
  }
  for (const { id, question } of questions) {
    const values = answers[id];
    if (!values || values.length === 0) {
      throw new OpensteerError({ code: "bad_request", message: `Answer ${id} must not be empty` });
    }
    if (!question.multiSelect && values.length !== 1) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Answer ${id} accepts exactly one value`,
      });
    }
  }
}

function invalidClaudeRequestResponse(): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: "Response does not match the pending Claude Request",
  });
}

function describeToolRequest(toolName: string, input: Readonly<Record<string, unknown>>): string {
  const encoded = safeJson(input);
  const clipped = clipUtf8(encoded, 8 * 1_024);
  return `Claude wants to use ${toolName} with: ${clipped}`;
}

function classifyToolRisk(toolName: string): "low" | "medium" | "high" {
  if (/^(Read|Glob|Grep|WebSearch)$/u.test(toolName)) return "low";
  if (/^(Bash|Write|Edit|NotebookEdit|WebFetch)$/u.test(toolName)) return "high";
  return "medium";
}

function claudeToolIdentity(name: string): ToolIdentity {
  const mcpPrefix = "mcp__";
  if (name.startsWith(mcpPrefix)) {
    const separator = name.indexOf("__", mcpPrefix.length);
    if (separator > mcpPrefix.length && separator + 2 < name.length) {
      return opensteerToolIdentity(
        name.slice(mcpPrefix.length, separator),
        name.slice(separator + 2),
      );
    }
  }
  return { name, namespace: "claude" };
}

function isRetryableClaudeFailure(error: string | undefined): boolean {
  return error === "rate_limit" || error === "overloaded" || error === "server_error";
}

/**
 * What the `query()` call behind this Run consumed, as Claude states it.
 *
 * `modelUsage` is the SDK's stated field for token and cost accounting: it
 * covers every model call the query pipeline made — the main agent loop, Task
 * subagents, sidechains and compaction — where `usage` covers the main loop
 * alone. Its totals are cumulative across the turns of one `query()` call and
 * a resumed session starts them fresh; this driver opens exactly one call per
 * Run, so they are this Run's own totals and never a session running total.
 *
 * Claude reports no separate reasoning count — its output tokens already
 * include it — so `reasoningTokens` is left unstated rather than derived.
 * A crash or startup-error result carries no per-model entries at all, and
 * a Run then reports nothing instead of a row of zeroes.
 */
function claudeRunUsage(message: SDKResultMessage): RunUsage | undefined {
  const models = Object.values(message.modelUsage);
  if (models.length === 0) return undefined;
  const totals = models.reduce(
    (sum, model) => ({
      cacheWriteTokens: sum.cacheWriteTokens + model.cacheCreationInputTokens,
      cachedInputTokens: sum.cachedInputTokens + model.cacheReadInputTokens,
      inputTokens: sum.inputTokens + model.inputTokens,
      outputTokens: sum.outputTokens + model.outputTokens,
    }),
    { cacheWriteTokens: 0, cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 },
  );
  // The provider's numbers are evidence, not a contract: anything that is not
  // a usable count leaves the Run with no usage rather than a repaired one.
  const parsed = RunUsageSchema.safeParse({
    cacheWriteTokens: Math.round(totals.cacheWriteTokens),
    cachedInputTokens: Math.round(totals.cachedInputTokens),
    costUsd: message.total_cost_usd,
    inputTokens: Math.round(totals.inputTokens),
    outputTokens: Math.round(totals.outputTokens),
  });
  return parsed.success ? parsed.data : undefined;
}

function sanitizeErrorMessage(
  message: string,
  environment: Readonly<Record<string, string>>,
  maxBytes: number,
): string {
  let sanitized = message;
  for (const [name, value] of Object.entries(environment)) {
    if (!credentialNamePattern.test(name) || value.length < 4) continue;
    sanitized = sanitized.split(value).join("[REDACTED]");
  }
  sanitized = sanitized.replace(/os_secret_[A-Za-z0-9_-]+/gu, "[OPAQUE_CREDENTIAL]");
  return clipUtf8(sanitized, maxBytes);
}

const maxThinkingTextChars = 250_000;

/** The text of a Claude content array or string, or null when it has none. */
function claudeTextContent(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((block: unknown) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
  return text || null;
}

function truncateThinkingText(text: string): string {
  return text.length > maxThinkingTextChars ? `${text.slice(0, maxThinkingTextChars)}…` : text;
}

function clipUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n[truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const target = Math.max(0, maxBytes - suffixBytes);
  let clipped = Buffer.from(value, "utf8").subarray(0, target).toString("utf8");
  while (Buffer.byteLength(clipped, "utf8") > target) clipped = clipped.slice(0, -1);
  return `${clipped}${suffix}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[non-serializable input]";
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OpensteerError({ code: "harness_error", message: `${label} is missing` });
  }
  return value;
}

/**
 * The turn's input stream stays open for the whole turn so the runtime keeps a
 * streaming session; the turn ends on the SDK result message, never on input
 * exhaustion.
 */
class ClaudeTurnInput implements AsyncIterable<SDKUserMessage> {
  readonly #queued: SDKUserMessage[] = [];
  #ended = false;
  #wake: (() => void) | undefined;

  push(message: SDKUserMessage): void {
    if (this.#ended) {
      throw new OpensteerError({
        code: "conflict",
        message: "Claude turn input stream is already closed",
      });
    }
    this.#queued.push(message);
    this.#wake?.();
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
    for (;;) {
      const next = this.#queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolveWake) => {
        this.#wake = resolveWake;
      });
      this.#wake = undefined;
    }
  }
}

/** Retains only the trailing window of provider output for a failure report. */
class BoundedTextTail {
  readonly #maxChars: number;
  #text = "";

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  append(chunk: string): void {
    const combined = `${this.#text}${chunk}`;
    this.#text =
      combined.length > this.#maxChars
        ? combined.slice(combined.length - this.#maxChars)
        : combined;
  }

  value(): string {
    return this.#text;
  }
}

class BoundedTextCollector {
  readonly #maxBytes: number;
  #bytes = 0;
  #chunks: string[] = [];
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: string): void {
    if (this.#truncated || chunk.length === 0) return;
    const remaining = this.#maxBytes - this.#bytes;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    const clipped = clipUtf8(chunk, remaining);
    const bytes = Buffer.byteLength(clipped, "utf8");
    this.#chunks.push(clipped);
    this.#bytes += bytes;
    if (bytes < Buffer.byteLength(chunk, "utf8") || this.#bytes >= this.#maxBytes) {
      this.#truncated = true;
    }
  }

  value(): string {
    const combined = this.#chunks.join("");
    return this.#truncated && !combined.endsWith("[truncated]")
      ? clipUtf8(`${combined}\n[truncated]`, this.#maxBytes)
      : combined;
  }
}
