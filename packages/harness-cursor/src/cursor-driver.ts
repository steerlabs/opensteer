import { rm, stat, mkdir, copyFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  HarnessIdSchema,
  OpensteerError,
  createId,
  harnessCatalogEntry,
  harnessUsageLimitFailureCode,
  normalizeToolOutput,
  type HarnessInstanceId,
  type PendingRequest,
  type RequestId,
  type RequestResponse,
  type ThreadAccessMode,
  type UserId,
} from "@opensteer/core";
import { toolsForCapabilityProfile } from "@opensteer/agent-tools";
import { integrationGatewayToolNames } from "@opensteer/integration-core";
import { delay } from "@opensteer/shared/delay";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  Deferred,
  withTitleDirectory,
  runTitleProcess,
  type HarnessTitleInput,
  HarnessSessionRegistry,
  TurnPublisher,
  assertFreshProviderSessionContext,
  initialContinuationContextPrompt,
  boundedDenialNote,
  clampConnectionLabel,
  collectStreamText,
  durableHistoryWindowNotice,
  harnessInputHeader,
  harnessTurnPreamble,
  meetsMinimumVersion,
  resolvedInputParts,
  profileHarnessProviderStoreScope,
  renderHarnessSkillCatalog,
  runEndedEvent,
  runFailedEvent,
  runStartedEvent,
  spawnSupervised,
  toHarnessError,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessDriverCreateContext,
  type HarnessEvent,
  type HarnessInput,
  type HarnessInspectionContext,
  type HarnessInspectionResult,
  type HarnessProcessLaunchWrapper,
  type HarnessProviderStoreScope,
  type HarnessRunInput,
  type HarnessSession,
  type HarnessSessionContext,
  type ResolvedAttachment,
  type HarnessSourceDescriptor,
  type SupervisedProcess,
} from "@opensteer/harness";
import { CursorHarnessConfigSchema, type CursorHarnessConfig } from "./config.js";
import {
  CursorHookBridge,
  createCursorHookSocketDirectory,
  cursorHookSocketPath,
  type CursorHookPayload,
  type CursorHookVerdict,
} from "./hook-bridge.js";
import {
  cursorAccessModeHooks,
  cursorAgentToolsServerName,
  cursorIntegrationToolsServerName,
  cursorMcpServerIdentifier,
  cursorOpensteerMcpServerIdentifiers,
  cursorPreToolUseDecision,
  materializeCursorPlugin,
  type CursorHookEvent,
} from "./plugin.js";
import {
  cursorModelArgument,
  cursorModelDescriptors,
  parseCursorModelListing,
  type CursorModelListing,
} from "./model-catalog.js";
import {
  CursorStreamReader,
  cursorFrameText,
  isCursorAssistantDelta,
  readCursorToolCall,
  readCursorUsage,
  type CursorFrame,
} from "./stream.js";

/**
 * The one source Cursor has: the person's own CLI sign-in on this computer.
 *
 * It is a `gateway` because a Cursor plan pays for Anthropic's, OpenAI's and
 * Google's models as well as Cursor's own, and `ambient` only because the
 * sign-in lives in the macOS keychain rather than in a directory a
 * Runner-private profile could own (cursor-facts §A.2).
 *
 * There is deliberately no API-key source. `CURSOR_API_KEY` is the only way to
 * point the CLI at a key, and a model-run shell command sees the harness
 * process environment: verified 2026-09-17 by giving the CLI a marker variable
 * and asking the model to print it, which it did. A key there would be a key
 * the model can read.
 */
const cursorSourceId = "cursor";

const cursorSources: readonly HarnessSourceDescriptor[] = [
  {
    detail: "Your Cursor plan, signed in with the Cursor CLI on this computer.",
    fields: [],
    kind: "gateway",
    label: "Cursor",
    quota: "none",
    sourceId: cursorSourceId,
    stateKinds: ["ambient"],
  },
] as const satisfies readonly HarnessSourceDescriptor[];

const cursorHarnessCapabilities: HarnessCapabilities = Object.freeze({
  approvals: true,
  /**
   * Print mode takes a prompt string and nothing else: an image can only reach
   * the model as a path it reads with a tool, which is a file the Run would
   * have to write into the Workspace (cursor-facts §6).
   */
  attachments: true,
  messageAttachments: { nativeImages: null },
  interruption: true,
  /**
   * cursor-agent hands an MCP tool result's `image` content blocks to the
   * model as images; only the transcript renders them as text.
   */
  mcpImageContent: true,
  resume: true,
  /** Print mode reads nothing from stdin; there is no input stream to steer. */
  steering: false,
  toolCalls: true,
  /** Cursor has no question tool and hooks cannot carry one. */
  userInput: false,
});

/** What a Run reports when the engine itself, rather than the model, failed. */
export const cursorFailureCode = "cursor_harness_error";
/** The account's own sign-in is gone; another account is the only way on. */
export const cursorAuthenticationFailureCode = "cursor_authentication";

export interface CursorRunFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** How long the kernel is given to reap a process that was sent SIGKILL. */
const cursorKillGraceMs = 2_000;

/** How long a denial note may be, in the bytes the Request schema counts. */
const cursorDenialNoteMaxBytes = 20_000;

const cursorIsolatedServiceDetail = "Cursor runs only on a computer you signed in on.";
const cursorSignInDetail = "Sign in to use Cursor. Run `agent login` on this computer.";

export interface CursorHarnessDependencies {
  /** The installed `agent` CLI. */
  readonly executable: string;
  /**
   * The Runner's own Node, used to run the plugin's hook program. It is not
   * `process.execPath`: that is Electron when the desktop app hosts the Runner.
   */
  readonly nodeExecutable: string;
}

export class CursorHarnessDriver implements HarnessDriver {
  readonly kind = HarnessIdSchema.parse("cursor");
  readonly sources = cursorSources;
  /**
   * `cursorAccessModeHooks` translates each of them into hook events, all
   * three proved live against the real CLI under `--force`. `auto` is not
   * declared: Cursor's classifier mode (`--auto-review`) decides on its own
   * and has no channel that could ask a person, so nothing would enforce it.
   */
  readonly accessModes = [
    "approval-required",
    "auto-accept-edits",
    "full-access",
  ] as const satisfies readonly ThreadAccessMode[];
  readonly capabilities = cursorHarnessCapabilities;
  readonly configSchema = CursorHarnessConfigSchema;
  /**
   * An ambient profile is the person's own CLI installation, so the two
   * variables that say where that installation keeps its settings and its
   * transcripts have to reach it — the driver resolves a chat's transcript
   * directory from `CURSOR_DATA_DIR` itself, and would look in the wrong place
   * if the CLI honoured a value the Runner had filtered out. Both are
   * locations, never secrets.
   */
  readonly environmentVariables = ["CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR"] as const;
  /** Cursor keys its transcripts by working directory, never by account. */
  readonly providerStoreScope: HarnessProviderStoreScope = profileHarnessProviderStoreScope;
  readonly #dependencies: CursorHarnessDependencies;

  constructor(dependencies: CursorHarnessDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(context: HarnessInspectionContext): Promise<HarnessInspectionResult> {
    const config = CursorHarnessConfigSchema.parse(context.config);
    if (context.runtimeBoundary.kind === "isolated-service") {
      return { detail: cursorIsolatedServiceDetail, status: "unavailable" };
    }
    const entry = harnessCatalogEntry("cursor");
    const runtime = entry?.runtime.shape === "installed" ? entry.runtime : undefined;
    if (!runtime) {
      throw new OpensteerError({
        code: "internal",
        message: "The Cursor harness catalog entry does not describe an installed runtime",
      });
    }
    let version: string;
    try {
      version = (await this.#run(config, context, ["--version"])).stdout.trim();
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT" || (error as OpensteerError).code === "not_found") {
        return {
          detail: `Cursor's CLI is not installed on this computer. Install it from ${runtime.installUrl}`,
          status: "unavailable",
        };
      }
      throw error;
    }
    if (!meetsMinimumVersion(version, runtime.minimumVersion)) {
      return {
        detail: `Cursor's CLI is version ${version || "unknown"}; Opensteer needs ${runtime.minimumVersion} or newer. Run \`agent update\``,
        status: "unavailable",
      };
    }
    const signInRequired: HarnessInspectionResult = {
      connections: [
        {
          authKind: "subscription",
          connectionSlot: "primary",
          label: "Cursor",
          status: "authentication-required",
        },
      ],
      detail: cursorSignInDetail,
      setupMethods: [],
      status: "authentication-required",
    };
    let status: Record<string, unknown>;
    let about: Record<string, unknown> | undefined;
    let modelOutput: string;
    try {
      const observed = await this.#readJson(config, context, ["status", "--format", "json"]);
      if (observed?.isAuthenticated !== true) return signInRequired;
      status = observed;
      about = await this.#readJson(config, context, ["about", "--format", "json"]);
      modelOutput = (await this.#run(config, context, ["models"])).stdout;
    } catch (error) {
      const stderr =
        error instanceof OpensteerError && typeof error.details?.stderr === "string"
          ? error.details.stderr
          : error instanceof Error
            ? error.message
            : "";
      if (cursorExitFailure(null, stderr).code !== cursorAuthenticationFailureCode) throw error;
      return signInRequired;
    }
    const listing = parseCursorModelListing(modelOutput);
    const models = cursorModelDescriptors(listing, context.sourceId);
    if (models.length === 0) {
      return { detail: "Cursor did not report any available models", status: "unavailable" };
    }
    const userInfo =
      typeof status.userInfo === "object" && status.userInfo !== null
        ? (status.userInfo as Record<string, unknown>)
        : {};
    const accountLabel = clampConnectionLabel(
      typeof userInfo.email === "string" ? userInfo.email : undefined,
    );
    const billingLabel = clampConnectionLabel(
      typeof about?.subscriptionTier === "string" ? about.subscriptionTier : undefined,
    );
    const result: HarnessInspectionResult = {
      connections: [
        {
          ...(accountLabel ? { accountLabel } : {}),
          authKind: "subscription",
          ...(billingLabel ? { billingLabel } : {}),
          connectionSlot: "primary",
          label: "Cursor",
          // The CLI signs out only through `agent logout`, which would end the
          // person's own sign-in on this computer rather than an account's.
          logoutSupported: false,
          status: "connected",
        },
      ],
      detail: `Cursor ${version} is signed in and ready`,
      models,
      status: "ready",
    };
    return result;
  }
  async create(context: HarnessDriverCreateContext): Promise<HarnessAdapter> {
    const config = CursorHarnessConfigSchema.parse(context.config);
    if (context.sourceId !== cursorSourceId) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown Cursor source" });
    }
    return new CursorHarnessAdapter(context.instanceId, config, this.#dependencies);
  }

  async #run(
    config: CursorHarnessConfig,
    context: HarnessInspectionContext,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }> {
    return runCursorCommand(this.#dependencies.executable, {
      args,
      cwd: context.workingDirectory,
      environment: context.environment,
      signal: context.signal,
      timeoutMs: config.subcommandTimeoutMs,
    });
  }

  async #readJson(
    config: CursorHarnessConfig,
    context: HarnessInspectionContext,
    args: readonly string[],
  ): Promise<Record<string, unknown> | undefined> {
    const { stdout } = await this.#run(config, context, args);
    try {
      const parsed: unknown = JSON.parse(stdout);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

class CursorHarnessAdapter implements HarnessAdapter {
  readonly capabilities = cursorHarnessCapabilities;
  readonly instanceId: HarnessInstanceId;
  readonly #config: CursorHarnessConfig;
  readonly #dependencies: CursorHarnessDependencies;
  readonly #sessions = new HarnessSessionRegistry<CursorHarnessSession>("Cursor");

  constructor(
    instanceId: HarnessInstanceId,
    config: CursorHarnessConfig,
    dependencies: CursorHarnessDependencies,
  ) {
    this.instanceId = instanceId;
    this.#config = config;
    this.#dependencies = dependencies;
  }

  async startSession(context: HarnessSessionContext): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    assertNativeUserBoundary(context);
    assertFreshProviderSessionContext(context);
    // `agent create-chat` mints the id without contacting a model and without
    // writing a transcript, and `--resume` accepts it for the very first turn
    // (verified live), so the Run's continuation identity exists before the
    // Run does — the same shape as Codex's pre-created thread.
    const { stdout } = await runCursorCommand(this.#dependencies.executable, {
      args: ["create-chat"],
      cwd: context.workspacePath,
      environment: context.environment,
      signal: context.signal,
      timeoutMs: this.#config.subcommandTimeoutMs,
    });
    const reference = validateProviderReference(stdout.trim());
    return this.#sessions.open(reference, () =>
      CursorHarnessSession.open(
        this.#config,
        this.#dependencies,
        context,
        reference,
        false,
        (closed) => this.#sessions.release(closed),
      ),
    );
  }

  async resumeSession(
    providerSessionReference: string,
    context: HarnessSessionContext,
  ): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    assertNativeUserBoundary(context);
    const reference = validateProviderReference(providerSessionReference);
    return this.#sessions.open(reference, () =>
      CursorHarnessSession.open(
        this.#config,
        this.#dependencies,
        context,
        reference,
        true,
        (closed) => this.#sessions.release(closed),
      ),
    );
  }

  async close(): Promise<void> {
    await this.#sessions.close();
  }
}

interface ActiveTurn {
  readonly completedToolCalls: Set<string>;
  readonly startedToolArguments: Map<string, unknown>;
  readonly requestedBy: UserId;
  readonly runId: HarnessRunInput["runId"];
  interruptRequested: boolean;
  started: boolean;
  terminal: boolean;
  usageReported: boolean;
}

interface PendingApproval {
  readonly settle: (verdict: CursorHookVerdict) => void;
  readonly subject: string;
}

/**
 * One Cursor Run.
 *
 * Print mode has no resident process: the CLI is spawned for the turn, reads
 * nothing from stdin, streams JSONL to stdout and exits. What the session owns
 * across that is the Thread's plugin directory and the approval socket, which
 * is why they are materialized when the session opens rather than per turn.
 */
class CursorHarnessSession implements HarnessSession {
  readonly events: AsyncIterable<HarnessEvent>;
  readonly providerSessionReference: string;
  readonly #config: CursorHarnessConfig;
  readonly #context: HarnessSessionContext;
  readonly #dependencies: CursorHarnessDependencies;
  readonly #onClose: (session: CursorHarnessSession) => void;
  readonly #pendingApprovals = new Map<RequestId, PendingApproval>();
  readonly #publisher: TurnPublisher;
  readonly #abortListener: () => void;
  #activeTurn: ActiveTurn | undefined;
  #bridge: CursorHookBridge | undefined;
  #closed = false;
  #listing: Promise<CursorModelListing> | undefined;
  /** Ends the session's model listing when the session stops. */
  readonly #listingLifetime = new AbortController();
  #pluginPath: string | undefined;
  #process: SupervisedProcess | undefined;
  #socketDirectory: string | undefined;
  #skillCatalog: string | undefined;
  #reasoningBlocks = 0;
  /** The open reasoning block's text, which Cursor's completion frame omits. */
  #reasoningText = "";
  #stopPromise: Promise<void> | undefined;

  private constructor(
    config: CursorHarnessConfig,
    dependencies: CursorHarnessDependencies,
    context: HarnessSessionContext,
    reference: string,
    onClose: (session: CursorHarnessSession) => void,
  ) {
    this.#config = config;
    this.#context = context;
    this.#dependencies = dependencies;
    this.#onClose = onClose;
    this.providerSessionReference = reference;
    this.#publisher = new TurnPublisher({
      maxBytes: config.maxEventBytes,
      maxItems: config.maxEventItems,
    });
    this.events = this.#publisher.events;
    this.#abortListener = () => void this.stop();
    context.signal.addEventListener("abort", this.#abortListener, { once: true });
  }

  static async open(
    config: CursorHarnessConfig,
    dependencies: CursorHarnessDependencies,
    context: HarnessSessionContext,
    reference: string,
    resume: boolean,
    onClose: (session: CursorHarnessSession) => void,
  ): Promise<CursorHarnessSession> {
    if (context.signal.aborted) {
      throw new OpensteerError({
        code: "harness_error",
        message: "Cursor session was cancelled before startup",
      });
    }
    assertNativeUserBoundary(context);
    const session = new CursorHarnessSession(config, dependencies, context, reference, onClose);
    try {
      if (resume) await assertCursorTranscriptExists(context, reference);
      await session.#materialize();
      return session;
    } catch (error) {
      await session.#stop(false);
      throw error;
    }
  }

  async generateTitle({ prompt, signal }: HarnessTitleInput): Promise<string> {
    return withTitleDirectory(this.#context, async (directory) => {
      const workspace = join(directory, "workspace");
      const config = join(directory, ".cursor");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      await mkdir(config, { recursive: true, mode: 0o700 });
      const inherited = this.#context.environment;
      // macOS credentials remain in the same keychain. On file-backed
      // platforms copy only auth, never ambient MCP, plugins, hooks or rules.
      const originalHome = inherited.HOME ?? homedir();
      const authRoot =
        platform() === "darwin"
          ? join(originalHome, ".cursor")
          : platform() === "win32"
            ? join(inherited.APPDATA ?? join(originalHome, "AppData", "Roaming"), "Cursor")
            : join(inherited.XDG_CONFIG_HOME ?? join(originalHome, ".config"), "cursor");
      const titleAuthRoot =
        platform() === "darwin"
          ? config
          : platform() === "win32"
            ? join(directory, "Cursor")
            : join(directory, "cursor");
      await mkdir(titleAuthRoot, { recursive: true, mode: 0o700 });
      await copyFile(join(authRoot, "auth.json"), join(titleAuthRoot, "auth.json")).catch(
        (error: unknown) => {
          if (nodeErrorCode(error) !== "ENOENT") throw error;
        },
      );
      const plugin = await materializeCursorPlugin({
        accessMode: "approval-required",
        titleOnly: true,
        agentTools: this.#context.agentTools,
        integrationTools: this.#context.integrationTools,
        // The existing hook fails closed without a socket, denying every tool.
        hookSocketPath: "",
        hookTimeoutSeconds: this.#config.hookTimeoutSeconds,
        nodeExecutable: this.#dependencies.nodeExecutable,
        threadStateDirectory: directory,
      });
      const listing = await this.#modelListing(signal);
      return runTitleProcess(
        this.#context,
        {
          executable: this.#dependencies.executable,
          args: [
            "-p",
            "--output-format",
            "text",
            "--trust",
            "--disable-auto-update",
            "--workspace",
            workspace,
            "--plugin-dir",
            plugin.path,
            "--model",
            cursorModelArgument(listing, this.#context.modelSelection),
            prompt,
          ],
          cwd: workspace,
          environment: {
            ...inherited,
            HOME: directory,
            USERPROFILE: directory,
            APPDATA: directory,
            XDG_CONFIG_HOME: directory,
            CURSOR_CONFIG_DIR: config,
            CURSOR_DATA_DIR: join(directory, "data"),
          },
        },
        signal,
      );
    });
  }

  async execute(run: HarnessRunInput): Promise<void> {
    this.#assertUsable();
    if (this.#activeTurn) {
      throw new OpensteerError({
        code: "conflict",
        message: "Cursor session already has an active turn",
      });
    }
    const prompt = this.#turnPrompt(run.inputs, run, run.attachments);
    const model = cursorModelArgument(
      await this.#modelListing(run.signal),
      this.#context.modelSelection,
    );
    const active: ActiveTurn = {
      completedToolCalls: new Set(),
      startedToolArguments: new Map(),
      interruptRequested: run.signal.aborted,
      requestedBy: run.requestedBy,
      runId: run.runId,
      started: false,
      terminal: false,
      usageReported: false,
    };
    this.#activeTurn = active;
    const abort = () => void this.interrupt();
    if (!run.signal.aborted) run.signal.addEventListener("abort", abort, { once: true });
    try {
      if (run.signal.aborted) {
        this.#publishTerminal(active, "interrupted");
        return;
      }
      await this.#runTurn(active, run, model, prompt);
    } catch (error) {
      if (!active.terminal) {
        if (active.interruptRequested || this.#closed) this.#publishTerminal(active, "interrupted");
        else this.#publishFailure(active, toHarnessError(error, "Cursor turn failed"));
      }
    } finally {
      run.signal.removeEventListener("abort", abort);
      this.#cancelPendingApprovals("run-ended");
      this.#process = undefined;
      if (this.#activeTurn === active) this.#activeTurn = undefined;
    }
  }

  async interrupt(): Promise<void> {
    const active = this.#activeTurn;
    if (!active || active.terminal) return;
    active.interruptRequested = true;
    // Whatever the CLI does next, nobody is going to answer these: the tool
    // calls they gate are being abandoned with the turn.
    this.#cancelPendingApprovals("run-ended");
    const supervised = this.#process;
    const child = supervised?.child;
    if (!supervised || !child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    // SIGINT reaches the foreground CLI only, by pid. Cursor also keeps a
    // detached per-version worker daemon that outlives any one command and is
    // shared with the person's own sessions (cursor-facts §A.10), so the
    // process group is never signalled here.
    if (!signalPid(child.pid, "SIGINT")) return;
    if (await cursorExitedWithin(supervised.exited, this.#config.shutdownGraceMs)) return;
    // A CLI that ignores SIGINT would otherwise leave `execute` waiting on an
    // exit that never comes, with the Run unable to end.
    signalPid(child.pid, "SIGKILL");
    // SIGKILL cannot be caught, so this is the kernel reaping the process, not
    // the CLI deciding anything. Waiting for it means `execute` observes a real
    // exit by the time `interrupt` resolves.
    await cursorExitedWithin(supervised.exited, cursorKillGraceMs);
  }

  async resolveRequest(requestId: RequestId, response: RequestResponse): Promise<void> {
    this.#assertUsable();
    const pending = this.#pendingApprovals.get(requestId);
    if (!pending) {
      throw new OpensteerError({ code: "not_found", message: "Cursor Request not found" });
    }
    if (
      response.kind !== "choice" ||
      (response.optionId !== "allow-once" && response.optionId !== "reject")
    ) {
      throw invalidCursorRequestResponse();
    }
    this.#pendingApprovals.delete(requestId);
    if (response.optionId === "allow-once") {
      pending.settle({ permission: "allow" });
      return;
    }
    const note = boundedDenialNote(response.text, {
      maximumBytes: cursorDenialNoteMaxBytes,
      tooLong: invalidCursorRequestResponse,
    });
    // Cursor reports a hook denial to the model as a blocked tool carrying
    // this text, and the turn continues — which is how Opensteer already
    // treats a rejected approval.
    pending.settle({
      agentMessage: `Opensteer: the person denied this ${pending.subject}.${note ? `\n\nTheir note:\n${note}` : ""}`,
      permission: "deny",
      userMessage: note ? `denied: ${note}` : "denied in Opensteer",
    });
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop(true);
    return this.#stopPromise;
  }

  /**
   * The plugin carries the MCP servers and the hooks and nothing else: a
   * `rules/` directory inside a `--plugin-dir` does not reach the model in
   * print mode, verified 2026-09-17 with a rule carrying a codeword the model
   * then said it could not find. Every instruction travels on the turn's
   * prompt instead, which is what a resumed conversation needs anyway.
   */
  async #materialize(): Promise<void> {
    this.#skillCatalog = await renderHarnessSkillCatalog(this.#context.skills);
    this.#socketDirectory = await createCursorHookSocketDirectory();
    const socketPath = cursorHookSocketPath(this.#socketDirectory);
    const plugin = await materializeCursorPlugin({
      accessMode: this.#context.accessMode,
      agentTools: this.#context.agentTools,
      hookSocketPath: socketPath,
      hookTimeoutSeconds: this.#config.hookTimeoutSeconds,
      integrationTools: this.#context.integrationTools,
      nodeExecutable: this.#dependencies.nodeExecutable,
      threadStateDirectory: this.#context.threadStateDirectory,
    });
    this.#pluginPath = plugin.path;
    this.#bridge = await CursorHookBridge.listen({
      decide: (payload, abandoned) => this.#decideHook(payload, abandoned),
      maximumPayloadBytes: this.#config.maxStreamLineBytes,
      socketPath,
    });
  }

  /**
   * One `agent models` per session, whoever asks first, under the session's
   * lifetime rather than the asker's: naming asks before the Run's turn does,
   * and a name given up must not end the Run's listing. It runs inside the
   * Run's launch wrapper, and stopping the session ends it and waits for it.
   */
  #modelListing(signal: AbortSignal): Promise<CursorModelListing> {
    if (!this.#listing) {
      const listing = runCursorCommand(this.#dependencies.executable, {
        args: ["models"],
        cwd: this.#context.workspacePath,
        environment: this.#context.environment,
        signal: AbortSignal.any([this.#context.signal, this.#listingLifetime.signal]),
        timeoutMs: this.#config.subcommandTimeoutMs,
        wrapProcessLaunch: this.#context.wrapProcessLaunch,
      })
        // `--model` takes one of these flat ids and nothing else, so the
        // listing is the only authority for what this account can be asked to run.
        .then(({ stdout }) => parseCursorModelListing(stdout));
      this.#listing = listing;
      listing.catch(() => {
        if (this.#listing === listing) this.#listing = undefined;
      });
    }
    return withTimeout(this.#listing, this.#config.subcommandTimeoutMs, {
      signal,
      timeoutError: () =>
        new OpensteerError({ code: "timeout", message: "Cursor did not list its models" }),
    });
  }

  async #runTurn(
    active: ActiveTurn,
    run: HarnessRunInput,
    model: string,
    prompt: string,
  ): Promise<void> {
    const pluginPath = this.#pluginPath;
    if (!pluginPath) {
      throw new OpensteerError({
        code: "harness_error",
        message: "Cursor session has no plugin directory",
      });
    }
    const launch = this.#context.wrapProcessLaunch({
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        // The workspace is trusted by Opensteer's own admission, and the
        // untrusted CLI refuses to run at all (exit 1, nothing on stdout).
        "--trust",
        // Cursor's own classifier can only deny, never ask; the plugin's hooks
        // are the approval channel and they override `--force` (§A.5, §A.6).
        "--force",
        "--approve-mcps",
        "--disable-auto-update",
        "--workspace",
        this.#context.workspacePath,
        "--plugin-dir",
        pluginPath,
        "--model",
        model,
        "--resume",
        this.providerSessionReference,
        prompt,
      ],
      cwd: this.#context.workspacePath,
      environment: run.environment,
      executable: this.#dependencies.executable,
    });
    const supervised = spawnSupervised({
      args: launch.args,
      cwd: launch.cwd,
      environment: launch.environment,
      executable: launch.executable,
      maxOutputBytes: this.#config.maxEventBytes,
    });
    this.#process = supervised;
    // Print mode reads nothing from stdin; leaving it open would hold a pipe
    // the CLI never drains.
    supervised.child.stdin?.end();
    const stderr = new BoundedStderr(this.#config.maxStderrBytes);
    const stderrDrain = (async () => {
      for await (const chunk of supervised.stderr) stderr.append(chunk.toString("utf8"));
    })();
    const reader = new CursorStreamReader(this.#config.maxStreamLineBytes);
    let streamFailure: unknown;
    const stdoutDrain = (async () => {
      try {
        for await (const chunk of supervised.stdout) {
          for (const frame of reader.push(chunk.toString("utf8"))) this.#handleFrame(active, frame);
        }
      } catch (error) {
        streamFailure ??= error;
        await supervised.terminate(0).catch(() => undefined);
      }
    })();
    let startupTimedOut = false;
    const startupTimer = setTimeout(() => {
      if (active.started) return;
      startupTimedOut = true;
      void supervised.terminate(0).catch(() => undefined);
    }, this.#config.startupTimeoutMs);
    startupTimer.unref?.();
    let exit: Awaited<SupervisedProcess["exited"]>;
    try {
      exit = await supervised.exited;
    } finally {
      clearTimeout(startupTimer);
    }
    await Promise.allSettled([stdoutDrain, stderrDrain]);
    if (active.terminal) return;
    if (streamFailure) {
      this.#publishFailure(active, toHarnessError(streamFailure, "Cursor stream failed"));
      return;
    }
    if (active.interruptRequested || exit.signal === "SIGINT" || exit.code === 130) {
      this.#publishTerminal(active, "interrupted");
      return;
    }
    if (startupTimedOut) {
      this.#publishFailure(
        active,
        new OpensteerError({
          code: "timeout",
          message: `Cursor printed nothing within ${this.#config.startupTimeoutMs}ms`,
          retryable: true,
        }),
      );
      return;
    }
    // Every failure the CLI reports before it can stream lands here: an
    // untrusted workspace, an invalid key and an unknown model all exit 1 with
    // an empty stdout and one sentence on stderr (verified).
    this.#publishRunFailure(active, cursorExitFailure(exit.code, stderr.text()));
  }

  #handleFrame(active: ActiveTurn, frame: CursorFrame): void {
    // A `result` frame ends the turn, and the CLI has been seen to put more on
    // the same stdout chunk. Nothing after a Run's terminal event belongs to
    // that Run.
    if (active.terminal) return;
    const type = typeof frame.type === "string" ? frame.type : "";
    if (type === "system") {
      const sessionId = typeof frame.session_id === "string" ? frame.session_id : undefined;
      if (sessionId && sessionId !== this.providerSessionReference) {
        throw new OpensteerError({
          code: "harness_error",
          message: `Cursor opened session ${sessionId} for Opensteer session ${this.providerSessionReference}`,
        });
      }
      // Cursor emits system/init when its process and session are ready, before
      // it echoes or otherwise proves acceptance of this submitted user turn.
      return;
    }
    this.#ensureRunStarted(active);
    switch (type) {
      case "assistant": {
        const text = cursorFrameText(frame);
        if (isCursorAssistantDelta(frame)) {
          if (text) this.#publish({ data: { text }, type: "assistant.delta" });
          return;
        }
        this.#publish({
          data: { content: [{ text, type: "text" }], messageId: createId("message") },
          type: "assistant.message",
        });
        return;
      }
      case "thinking": {
        const blockId = `cursor-reasoning-${this.#reasoningBlocks}`;
        if (frame.subtype === "completed") {
          this.#reasoningBlocks += 1;
          // Cursor's completion frame carries no text of its own, so the block
          // is closed on the text its deltas delivered, kept here because the
          // completion is the only durable record of it.
          const text = truncateCursorReasoning(this.#reasoningText);
          this.#reasoningText = "";
          this.#publish({ data: { blockId, text }, type: "reasoning.completed" });
          return;
        }
        const text = typeof frame.text === "string" ? frame.text : "";
        if (text) {
          this.#reasoningText += text;
          this.#publish({ data: { blockId, text }, type: "reasoning.delta" });
        }
        return;
      }
      case "tool_call": {
        const callId = typeof frame.call_id === "string" ? frame.call_id : undefined;
        const call = readCursorToolCall(frame);
        if (!callId || !call) return;
        if (frame.subtype === "started") {
          if (active.completedToolCalls.has(callId)) return;
          const earlierArguments = active.startedToolArguments.get(callId);
          if (earlierArguments !== undefined) {
            if (
              typeof call.arguments !== "object" ||
              call.arguments === null ||
              Array.isArray(call.arguments) ||
              Object.keys(call.arguments).length === 0 ||
              isDeepStrictEqual(earlierArguments, call.arguments)
            ) {
              return;
            }
          }
          active.startedToolArguments.set(callId, call.arguments);
          this.#publish({
            data: { arguments: call.arguments, callId, tool: call.identity },
            type: "tool.started",
          });
          return;
        }
        if (frame.subtype === "completed") {
          if (active.completedToolCalls.has(callId)) return;
          const startedArguments = active.startedToolArguments.get(callId);
          if (startedArguments === undefined) {
            this.#publish({
              data: { arguments: call.arguments, callId, tool: call.identity },
              type: "tool.started",
            });
          } else if (
            typeof startedArguments === "object" &&
            startedArguments !== null &&
            !Array.isArray(startedArguments) &&
            typeof call.arguments === "object" &&
            call.arguments !== null &&
            !Array.isArray(call.arguments) &&
            Object.keys(startedArguments).every((key) =>
              Object.hasOwn(call.arguments as Record<string, unknown>, key),
            ) &&
            !isDeepStrictEqual(startedArguments, call.arguments)
          ) {
            this.#publish({
              data: { arguments: call.arguments, callId, tool: call.identity },
              type: "tool.started",
            });
          }
          active.startedToolArguments.delete(callId);
          active.completedToolCalls.add(callId);
          this.#publish({
            data: { callId, isError: call.isError, output: normalizeToolOutput(call.output) },
            type: "tool.completed",
          });
        }
        return;
      }
      case "result": {
        this.#publishUsage(active, frame);
        const failed = frame.is_error === true || frame.subtype !== "success";
        if (!failed) {
          this.#publishTerminal(active, "completed");
          return;
        }
        this.#publishFailure(
          active,
          new OpensteerError({
            code: "harness_error",
            message:
              typeof frame.result === "string" && frame.result.trim()
                ? frame.result.trim().slice(0, 2_000)
                : "Cursor ended the turn with an error",
          }),
        );
        return;
      }
      default:
        // `user` echoes the prompt back, and Cursor adds frame types without
        // notice; neither is an Opensteer event.
        return;
    }
  }

  #publishUsage(active: ActiveTurn, frame: CursorFrame): void {
    if (active.usageReported) return;
    const usage = readCursorUsage(frame);
    if (!usage) return;
    active.usageReported = true;
    this.#publish({
      data: {
        ...(usage.cacheReadTokens === undefined
          ? {}
          : { cachedInputTokens: usage.cacheReadTokens }),
        ...(usage.cacheWriteTokens === undefined
          ? {}
          : { cacheWriteTokens: usage.cacheWriteTokens }),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
      type: "run.usage",
    });
  }

  /**
   * Answers one hook. Only the events this Run's access mode actually asked
   * for can open a Request; anything else is allowed, because a hook Opensteer
   * did not register is one Cursor fired for its own reasons.
   */
  async #decideHook(
    payload: CursorHookPayload,
    abandoned: AbortSignal,
  ): Promise<CursorHookVerdict> {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
    const registered = cursorAccessModeHooks(this.#context.accessMode);
    if (!registered.includes(event as CursorHookEvent)) return { permission: "allow" };
    const approval = this.#hookApproval(event as CursorHookEvent, payload);
    if (!approval) return { permission: "allow" };
    const active = this.#activeTurn;
    if (!active || active.terminal || active.interruptRequested || this.#closed) {
      return {
        permission: "deny",
        userMessage: "the Opensteer Run is no longer accepting approvals",
      };
    }
    const requestId = createId("request");
    const settlement = new Deferred<CursorHookVerdict>();
    this.#pendingApprovals.set(requestId, {
      settle: (verdict) => settlement.resolve(verdict),
      subject: approval.subject,
    });
    try {
      this.#publish({
        data: {
          request: this.#pendingRequest(active, requestId, approval.callId, approval.presentation),
        },
        type: "request.opened",
      });
    } catch (error) {
      this.#pendingApprovals.delete(requestId);
      throw error;
    }
    // Cursor kills its hook at the hook's own timeout. The tool call is
    // blocked either way, but the Request goes with it rather than staying
    // answerable in front of a person who can no longer affect anything.
    abandoned.addEventListener(
      "abort",
      () => this.#cancelPendingApproval(requestId, "source-closed"),
      { once: true },
    );
    return settlement.promise;
  }

  #hookApproval(
    event: CursorHookEvent,
    payload: CursorHookPayload,
  ):
    | {
        readonly callId: string;
        readonly presentation: Extract<PendingRequest["presentation"], { kind: "choice" }>;
        readonly subject: string;
      }
    | undefined {
    const options = [
      { hint: "allow-once", id: "allow-once", label: "Allow once" },
      { hint: "reject-once", id: "reject", label: "Reject" },
    ] as const;
    if (event === "beforeShellExecution") {
      const command = typeof payload.command === "string" ? payload.command : "a command";
      return {
        callId: hookCallId(payload),
        presentation: {
          detail: command.slice(0, 20_000),
          kind: "choice",
          options: [...options],
          risk: "medium",
          title: "Approve command",
        },
        subject: "command",
      };
    }
    if (event === "beforeMCPExecution") {
      const server = typeof payload.mcp_server_name === "string" ? payload.mcp_server_name : "";
      // Opensteer's own tools are approved by the signed capability profile, as
      // they are for Codex; asking again would turn a durable decision into
      // provider-specific approval noise.
      if (cursorOpensteerMcpServerIdentifiers.includes(server)) return undefined;
      const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "a tool";
      return {
        callId: hookCallId(payload),
        presentation: {
          detail: `${server || "An MCP server"} · ${toolName}`.slice(0, 20_000),
          kind: "choice",
          options: [...options],
          risk: "medium",
          title: "Approve MCP tool",
        },
        subject: "MCP tool call",
      };
    }
    // `preToolUse` is the catch-all, so what it does with one tool depends on
    // the tool and the mode; `cursorPreToolUseDecision` is that table.
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
    const decision = cursorPreToolUseDecision(this.#context.accessMode, tool);
    if (decision === "allow") return undefined;
    const input = payload.tool_input;
    if (decision === "file-change") {
      const path =
        typeof input === "object" &&
        input !== null &&
        typeof (input as { path?: unknown }).path === "string"
          ? (input as { path: string }).path
          : undefined;
      return {
        callId: hookCallId(payload),
        presentation: {
          detail: (path ? `Change ${path}` : "Allow the proposed file change").slice(0, 20_000),
          kind: "choice",
          options: [...options],
          risk: "medium",
          title: "Approve file change",
        },
        subject: "file change",
      };
    }
    // A tool this build has never heard of. The CLI updates itself, so a
    // mutating tool Cursor adds after this driver was written reaches a person
    // rather than running because nothing recognised it.
    return {
      callId: hookCallId(payload),
      presentation: {
        detail: `${tool || "An unrecognised tool"}\n\n${describeToolInput(input)}`.slice(0, 20_000),
        kind: "choice",
        options: [...options],
        risk: "high",
        title: "Approve a tool Opensteer does not recognise",
      },
      subject: `${tool || "unrecognised"} tool call`,
    };
  }

  #pendingRequest(
    active: ActiveTurn,
    id: RequestId,
    callId: string,
    presentation: PendingRequest["presentation"],
  ): PendingRequest {
    return {
      callId,
      cancellationReason: null,
      createdAt: new Date().toISOString(),
      id,
      kind: "harness.approval",
      mode: "live",
      originatingOccurrenceId: null,
      originatingRunId: active.runId,
      originatingThreadId: this.#context.threadId,
      originatingWorkspaceId: this.#context.workspaceId,
      payload: { kind: "harness.approval" },
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

  /**
   * Every instruction travels on the turn, because a `--plugin-dir`'s `rules/`
   * never reached the model in print mode and because the machine-access
   * notice changes from Run to Run and must be in front of the model on a
   * resumed conversation too (`HarnessAdapter`, X9).
   */
  #turnPrompt(
    inputs: readonly HarnessInput[],
    turn: Pick<HarnessRunInput, "context" | "reports">,
    attachments?: ReadonlyMap<string, ResolvedAttachment>,
  ): string {
    if (inputs.length === 0) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Cursor turn inputs cannot be empty",
      });
    }
    const notices = [
      this.#context.platformGuide,
      this.#context.instructions,
      durableHistoryWindowNotice(this.#context),
      this.#skillCatalog,
      this.#context.machineAccessNotice,
      cursorToolsNotice(this.#context),
    ].filter((value): value is string => Boolean(value));
    const reportPrompt = harnessTurnPreamble(turn, (input) => cursorInputBody(input, attachments));
    const prompt = [
      ...notices,
      initialContinuationContextPrompt(this.#context),
      ...(reportPrompt ? [reportPrompt] : []),
      ...inputs.map((input) => projectCursorInput(input, attachments)),
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    const bytes = Buffer.byteLength(prompt, "utf8");
    if (bytes > this.#config.maxTurnInputBytes) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Cursor turn input is ${bytes} bytes, exceeding the configured ${this.#config.maxTurnInputBytes}-byte limit`,
      });
    }
    return prompt;
  }

  #ensureRunStarted(active: ActiveTurn): void {
    if (active.started) return;
    active.started = true;
    this.#publish(runStartedEvent());
  }

  #publishTerminal(active: ActiveTurn, status: "completed" | "interrupted"): void {
    if (!this.#publisher.claimTerminal(active)) return;
    this.#cancelPendingApprovals("run-ended");
    if (status === "completed") this.#ensureRunStarted(active);
    this.#publish(runEndedEvent(status));
  }

  #publishFailure(active: ActiveTurn, error: OpensteerError): void {
    this.#publishRunFailure(active, {
      code: error.code === "harness_error" ? cursorFailureCode : error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }

  #publishRunFailure(active: ActiveTurn, failure: CursorRunFailure): void {
    if (!this.#publisher.claimTerminal(active)) return;
    this.#cancelPendingApprovals("run-ended");
    this.#publish(runFailedEvent(failure));
  }

  #cancelPendingApprovals(reason: "run-ended" | "source-closed"): void {
    // A snapshot, because cancelling one removes it from the map.
    const requestIds = Array.from(this.#pendingApprovals.keys());
    for (const requestId of requestIds) this.#cancelPendingApproval(requestId, reason);
  }

  #cancelPendingApproval(requestId: RequestId, reason: "run-ended" | "source-closed"): void {
    const approval = this.#pendingApprovals.get(requestId);
    if (!approval) return;
    this.#pendingApprovals.delete(requestId);
    approval.settle({
      permission: "deny",
      userMessage:
        reason === "run-ended"
          ? "the Opensteer Run ended before this was approved"
          : "Cursor stopped waiting for this approval",
    });
    if (this.#publisher.streamClosed) return;
    try {
      this.#publisher.publish({ data: { reason, requestId }, type: "request.cancelled" });
    } catch {
      // A stream that can no longer take the cancellation is already unusable;
      // the hook has its denial either way.
    }
  }

  #publish(event: HarnessEvent): void {
    if (this.#publisher.streamClosed) return;
    try {
      this.#publisher.publish(event);
    } catch (error) {
      const failure = toHarnessError(error, "Cursor event buffer failed");
      this.#publisher.latchUnusable(failure);
      const active = this.#activeTurn;
      if (active) this.#publisher.claimTerminal(active);
      void this.#process?.terminate(0).catch(() => undefined);
      throw failure;
    }
  }

  async #stop(notifyOwner: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#context.signal.removeEventListener("abort", this.#abortListener);
    this.#cancelPendingApprovals("source-closed");
    const active = this.#activeTurn;
    if (active && !active.terminal) active.interruptRequested = true;
    try {
      this.#listingLifetime.abort(new Error("Cursor session stopped"));
      await this.#listing?.catch(() => undefined);
      // `terminate` signals the process group, unlike `interrupt`. That is
      // safe for the shared worker daemon precisely because Cursor spawns it
      // detached (cursor-facts §A.10): it is the leader of its own group and
      // was never in this Run's.
      await this.#process?.terminate(this.#config.shutdownGraceMs).catch(() => undefined);
      await this.#bridge?.close().catch(() => undefined);
      if (this.#socketDirectory) {
        await rm(this.#socketDirectory, { force: true, recursive: true }).catch(() => undefined);
      }
    } finally {
      // A Run whose session is torn down mid-turn still reaches exactly one
      // terminal event; the stream closes only once it has been published.
      if (active) this.#publishTerminal(active, "interrupted");
      this.#publisher.closeStream();
      if (notifyOwner) this.#onClose(this);
    }
  }

  #assertUsable(): void {
    if (this.#closed) {
      throw new OpensteerError({ code: "harness_error", message: "Cursor session is closed" });
    }
    if (this.#publisher.unusable) throw this.#publisher.unusable;
  }
}

/** Bounded stderr: a failing CLI is the only thing that ever explains itself there. */
class BoundedStderr {
  readonly #maximumBytes: number;
  #value = "";

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  append(chunk: string): void {
    this.#value += chunk;
    const bytes = Buffer.byteLength(this.#value, "utf8");
    if (bytes > this.#maximumBytes) this.#value = this.#value.slice(-this.#maximumBytes);
  }

  text(): string {
    return this.#value.trim();
  }
}

/**
 * Whether the process exited inside `graceMs`.
 *
 * The losing side is always cancelled: a grace timer left running would hold
 * the Runner's event loop open for its whole duration after an interrupt that
 * the exit had already won, and `interrupt` is on the path a person waits on.
 */
async function cursorExitedWithin(exited: Promise<unknown>, graceMs: number): Promise<boolean> {
  const grace = new AbortController();
  try {
    return await Promise.race([
      exited.then(
        () => true,
        () => true,
      ),
      delay(graceMs, grace.signal).then(
        () => false,
        () => false,
      ),
    ]);
  } finally {
    grace.abort(new Error("Cursor process exit no longer awaited"));
  }
}

/**
 * Signals one process, by pid. Answers whether the signal was delivered: a
 * process that has already gone is not a failure, it is the outcome.
 */
function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ESRCH") return false;
    throw error;
  }
}

/** Enough of an unrecognised tool's input for a person to judge it. */
function describeToolInput(input: unknown): string {
  if (input === undefined || input === null) return "It was called with no arguments.";
  if (typeof input === "string") return input.slice(0, 4_000);
  try {
    return JSON.stringify(input, undefined, 2).slice(0, 4_000);
  } catch {
    return "Its arguments could not be read.";
  }
}

function hookCallId(payload: CursorHookPayload): string {
  const candidates = [payload.tool_use_id, payload.generation_id, payload.session_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return createId("request");
}

/**
 * Cursor never puts an MCP tool in the model's tool list: the model has to
 * find it with `getMcpTools` first, and a model that searched once and missed
 * concluded the tool did not exist (cursor-facts §A.7). So the turn says which
 * servers exist and what they hold.
 */
function cursorToolsNotice(context: HarnessSessionContext): string {
  const agentTools = toolsForCapabilityProfile(context.agentTools.capabilityProfileId).map(
    ({ name }) => name,
  );
  return [
    "[Opensteer tools]",
    `To load Opensteer tools, call getMcpTools with the server name below, then use mcpToolCall.`,
    `Server ${cursorMcpServerIdentifier(cursorAgentToolsServerName)} holds: ${agentTools.join(", ")}.`,
    `Server ${cursorMcpServerIdentifier(cursorIntegrationToolsServerName)} holds: ${[...integrationGatewayToolNames].join(", ")}.`,
  ].join("\n");
}

function projectCursorInput(
  input: HarnessInput,
  attachments?: ReadonlyMap<string, ResolvedAttachment>,
): string {
  return harnessInputHeader(input, cursorInputBody(input, attachments));
}

function cursorInputBody(
  input: HarnessInput,
  attachments?: ReadonlyMap<string, ResolvedAttachment>,
): string {
  const projected = resolvedInputParts(input, attachments);
  if (projected.images.length > 0)
    throw new OpensteerError({
      code: "bad_request",
      message: "Cursor print mode cannot deliver native image input",
    });
  return projected.body;
}

/**
 * Cursor's transcripts are keyed by the working directory, and `--resume` with
 * an id that has none is accepted: it silently starts an empty conversation
 * under the same id (cursor-facts §A.1 note 5). A resume that cannot find the
 * transcript therefore fails the Run rather than forking the Thread.
 */
function invalidCursorRequestResponse(): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: "Response does not match the pending Cursor Request",
  });
}

async function assertCursorTranscriptExists(
  context: HarnessSessionContext,
  reference: string,
): Promise<void> {
  const directory = cursorTranscriptDirectory(
    context.environment,
    context.workspacePath,
    reference,
  );
  // The transcript, not the directory: Cursor creates the directory around a
  // conversation it is about to write, so a directory on its own would let a
  // half-created or emptied chat pass, and `--resume` would then mint an empty
  // conversation under the Thread's own id.
  const found = await stat(join(directory, `${reference}.jsonl`)).catch(() => undefined);
  if (found?.isFile() && found.size > 0) return;
  throw new OpensteerError({
    code: "not_found",
    message: `Cursor has no transcript for conversation ${reference} in this Workspace`,
  });
}

/**
 * Where the CLI keeps one chat, reproduced from the shipped bundle's own
 * `workspace-paths` helper and confirmed against the real directory:
 * `<CURSOR_DATA_DIR or ~/.cursor>/projects/<slug(cwd)>/agent-transcripts/<chatId>`.
 */
export function cursorTranscriptDirectory(
  environment: Readonly<Record<string, string>>,
  workspacePath: string,
  reference: string,
): string {
  const dataDirectory = environment.CURSOR_DATA_DIR?.trim()
    ? environment.CURSOR_DATA_DIR.trim()
    : join(homedir(), ".cursor");
  return join(
    dataDirectory,
    "projects",
    cursorWorkspaceSlug(workspacePath),
    "agent-transcripts",
    reference,
  );
}

export function cursorWorkspaceSlug(workspacePath: string): string {
  return workspacePath
    .replace(/[^a-zA-Z0-9]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * What a non-zero exit means. The authentication wording is verified; the
 * usage-limit wording is not — the account never hit its cap, so the pattern
 * follows the error family Cursor's own API documents (`usage_limit_exceeded`,
 * `rate_limit_exceeded`) and is marked untested here rather than in a
 * changelog nobody reads (cursor-facts §A.8, open risk 8).
 */
export function cursorExitFailure(code: number | null, stderr: string): CursorRunFailure {
  const detail = stderr.split("\n").filter(Boolean).slice(-6).join("\n").slice(0, 2_000);
  if (/usage[ _]limit|rate[ _]limit|quota exceeded/iu.test(stderr)) {
    return {
      code: harnessUsageLimitFailureCode,
      message: detail || "Cursor reported that this account has no capacity left",
      retryable: false,
    };
  }
  if (
    /authentication required|api key is invalid|not (?:signed|logged) in|unauthori[sz]ed|agent login/iu.test(
      stderr,
    )
  ) {
    return {
      code: cursorAuthenticationFailureCode,
      message: `${cursorSignInDetail} ${detail}`.trim(),
      retryable: false,
    };
  }
  return {
    code: cursorFailureCode,
    message: detail || `Cursor exited with status ${code ?? "unknown"}`,
    retryable: false,
  };
}

/**
 * The same refusal `inspect` gives. Cursor's sign-in is the person's own
 * keychain entry, and the plugin hands the model's commands a Runner-owned
 * tool credential, so a Runner that executes for a Deployment at large has no
 * honest way to run it: a session that opened anyway would spend whichever
 * person's plan the Runner's own account happens to be. It is asserted on both
 * ways in and again inside `open`, which is the one path neither can skip.
 */
function assertNativeUserBoundary(context: HarnessSessionContext): void {
  if (context.runtimeBoundary.kind === "native-user") return;
  throw new OpensteerError({ code: "forbidden", message: cursorIsolatedServiceDetail });
}

function validateProviderReference(reference: string): string {
  const value = reference.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Invalid Cursor provider session reference",
    });
  }
  return value;
}

/**
 * One short-lived `agent` subcommand. Every invocation carries
 * `--disable-auto-update`: the CLI replaced itself mid-session once already,
 * and a Run that starts on one version and ends on another is a Run whose
 * event shapes changed underneath it (cursor-facts open risk 1).
 */
async function runCursorCommand(
  executable: string,
  options: {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    /** A Run's own launch wrapper, for a command that runs during a Run. */
    readonly wrapProcessLaunch?: HarnessProcessLaunchWrapper;
  },
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(options.signal.reason);
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => lifetime.abort(new Error("Cursor command timed out")),
    options.timeoutMs,
  );
  timer.unref?.();
  const launch = {
    args: [...options.args, "--disable-auto-update"],
    cwd: options.cwd,
    environment: options.environment,
    executable,
  };
  const supervised = spawnSupervised({
    ...(options.wrapProcessLaunch ? options.wrapProcessLaunch(launch) : launch),
    maxOutputBytes: 4 * 1_024 * 1_024,
    signal: lifetime.signal,
  });
  supervised.child.stdin?.end();
  try {
    const [stdout, stderr, exit] = await Promise.all([
      collectStreamText(supervised.stdout),
      collectStreamText(supervised.stderr),
      supervised.exited,
    ]);
    if (exit.code !== 0) {
      throw new OpensteerError({
        code: "harness_error",
        message: `Cursor \`agent ${options.args[0] ?? ""}\` failed (exit ${exit.code ?? "unknown"}): ${stderr.trim().slice(0, 500)}`,
      });
    }
    return { stderr, stdout };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    lifetime.abort(new Error("Cursor command finished"));
  }
}

const cursorReasoningMaxLength = 250_000;

function truncateCursorReasoning(text: string): string {
  return text.length > cursorReasoningMaxLength
    ? `${text.slice(0, cursorReasoningMaxLength)}…`
    : text;
}
