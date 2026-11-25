import { toolOutputWithImages } from "@opensteer/harness";
import {
  engineDiagnosticSecrets,
  hasShortNamedSecret,
  networkCredentialSecrets,
  redactNetworkCredentials,
} from "@opensteer/shared/safeMessage";
import {
  OpensteerError,
  createId,
  harnessSessionBrokenFailureCode,
  type HarnessInstanceId,
  type MessageId,
  type PendingRequest,
  type RequestId,
  type RequestResponse,
} from "@opensteer/core";
import {
  Deferred,
  GuidanceDelivery,
  HarnessSessionRegistry,
  HarnessSteerDeliveryUnknownError,
  SubagentNodes,
  TurnPublisher,
  assertFreshProviderSessionContext,
  durableHistoryWindowNotice,
  harnessTurnPreamble,
  initialContinuationContextPrompt,
  readVerifiedAttachmentBytes,
  renderHarnessSkillCatalog,
  resolvedInputSequence,
  runEndedEvent,
  runFailedEvent,
  runStartedEvent,
  spawnSupervised,
  toHarnessError,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessRunInput,
  type HarnessSession,
  type HarnessSessionContext,
  type HarnessSteerInput,
  type GuidanceTicket,
  type SupervisedProcess,
} from "@opensteer/harness";
import { isRecord } from "@opensteer/shared/isRecord";
import type {
  AcpElicitationRequest,
  AcpMcpServer,
  AcpPromptBlock,
  AcpPromptResult,
  AcpProtocolClient,
} from "./protocol.js";
import {
  acpProtocolOutputBytes,
  acpReadTextFileHandler,
  closeAcpSessionBestEffort,
  createAcpProtocolClient,
} from "./protocol.js";
import type {
  AcpErrorContext,
  AcpHeldAssistantDecision,
  AcpHarnessOptions,
  AcpNormalizedUpdate,
  AcpPermissionChoice,
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpPromptOutcomeCheck,
  AcpSessionSnapshot,
  AcpToolCall,
} from "./types.js";
import { acpToolIdentity, isTerminalAcpToolCall, parseAcpToolCall } from "./tool-calls.js";

interface AcpHarnessDependencies {
  readonly createClient?: typeof createAcpProtocolClient;
  readonly spawn?: typeof spawnSupervised;
}

type OpenMode =
  { readonly type: "start" } | { readonly type: "resume"; readonly reference: string };

interface ActivePrompt {
  readonly checkOutcome?: AcpPromptOutcomeCheck;
  readonly sequence: number;
  readonly stderrStart: number;
  readonly steerMessageId?: MessageId;
  acknowledged: boolean;
  settled?:
    | { readonly ok: true; readonly result: AcpPromptResult }
    | { readonly ok: false; readonly error: unknown }
    | undefined;
}

interface ActiveTurn {
  readonly nodeResults: Map<string, string>;
  readonly settledNodes: Set<string>;
  readonly childSessions: Map<string, string>;
  readonly childText: Map<
    string,
    { nodeKey: string; kind: "assistant" | "thought"; blockId: string; text: string }
  >;
  readonly assistant: Map<string, string>;
  readonly completion: Deferred<void>;
  readonly heldAssistant: {
    readonly messageId?: string;
    readonly text: string;
  }[];
  readonly nodes: SubagentNodes;
  readonly reasoning: Map<string, string>;
  readonly requestedBy: HarnessRunInput["requestedBy"];
  readonly runId: HarnessRunInput["runId"];
  readonly runSignal: AbortSignal;
  /** Calls this turn announced and has not finished, keyed by node scope and call id. */
  readonly tools: Map<string, AcpToolCall>;
  /** Calls this turn finished. A finished call absorbs every later frame for it. */
  readonly finishedTools: Set<string>;
  /** Prompt sequences whose `session/prompt` RPC has not settled yet. */
  readonly livePrompts: Set<number>;
  /** Prompts tracked for this turn (live or preserved while a follow-up steer is unconfirmed). */
  readonly prompts: Map<number, ActivePrompt>;
  assistantHoldActive: boolean;
  guidanceTicket?: GuidanceTicket;
  heldAssistantCharacters: number;
  interruptRequested: boolean;
  nextPromptSequence: number;
  pendingSteers: number;
  promptSequence: number;
  terminal: boolean;
  stderrStart: number;
  usage?: NonNullable<Awaited<ReturnType<AcpProtocolClient["prompt"]>>["usage"]>;
}

interface PendingInteraction {
  readonly kind: "choice" | "form";
  readonly settlement: Deferred<unknown>;
  readonly offered?: ReadonlySet<string>;
}

/** Shared process and native-session owner for ACP engine drivers. */
export class AcpHarnessAdapter implements HarnessAdapter {
  readonly capabilities: AcpHarnessOptions["capabilities"];
  readonly instanceId: HarnessInstanceId;
  readonly #dependencies: Required<AcpHarnessDependencies>;
  readonly #options: AcpHarnessOptions;
  readonly #sessions: HarnessSessionRegistry<AcpHarnessSession>;

  constructor(
    instanceId: HarnessInstanceId,
    options: AcpHarnessOptions,
    dependencies: AcpHarnessDependencies = {},
  ) {
    this.capabilities = options.capabilities;
    this.instanceId = instanceId;
    this.#options = options;
    this.#dependencies = {
      createClient: dependencies.createClient ?? createAcpProtocolClient,
      spawn: dependencies.spawn ?? spawnSupervised,
    };
    this.#sessions = new HarnessSessionRegistry(options.engineLabel);
  }

  async startSession(context: HarnessSessionContext): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    assertFreshProviderSessionContext(context);
    return this.#sessions.openUnreferenced(() => this.#open(context, { type: "start" }));
  }

  async resumeSession(
    providerSessionReference: string,
    context: HarnessSessionContext,
  ): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    const reference = providerSessionReference.trim();
    if (!reference || reference.includes("\0")) {
      throw new OpensteerError({ code: "bad_request", message: "Invalid ACP session reference" });
    }
    return this.#sessions.open(reference, () => this.#open(context, { reference, type: "resume" }));
  }

  close(): Promise<void> {
    return this.#sessions.close();
  }

  #open(context: HarnessSessionContext, mode: OpenMode): Promise<AcpHarnessSession> {
    return AcpHarnessSession.open(this.#options, this.#dependencies, context, mode, (session) =>
      this.#sessions.release(session),
    );
  }
}

class AcpHarnessSession implements HarnessSession {
  readonly events: AsyncIterable<HarnessEvent>;
  readonly steer?: (input: HarnessSteerInput) => Promise<void>;
  #context: HarnessSessionContext;
  readonly #client: AcpProtocolClient;
  readonly #onClose: (session: AcpHarnessSession) => void;
  readonly #options: AcpHarnessOptions;
  readonly #process: SupervisedProcess;
  readonly #publisher: TurnPublisher;
  readonly #pending = new Map<RequestId, PendingInteraction>();
  /** Calls earlier turns announced, so a frame an engine sends late cannot reopen them. */
  readonly #endedTools = new Set<string>();
  readonly #sanitizer: AcpDiagnosticSanitizer;
  #stderr = "";
  #stderrDropped = 0;
  readonly #lifetime = new AbortController();
  readonly #abortListener: () => void;
  #active: ActiveTurn | undefined;
  #closed = false;
  #opening = true;
  #processEnded = false;
  #expectedProcessExit = false;
  #providerSessionReference: string | undefined;
  #replaying = false;
  readonly #stderrWaiters = new Set<() => void>();
  #stopPromise: Promise<void> | undefined;
  readonly #guidance = new GuidanceDelivery();
  #persistentApprovalGranted = false;
  #backgroundWorkRemains = false;

  private constructor(
    options: AcpHarnessOptions,
    dependencies: Required<AcpHarnessDependencies>,
    context: HarnessSessionContext,
    process: SupervisedProcess,
    sanitizer: AcpDiagnosticSanitizer,
    onClose: (session: AcpHarnessSession) => void,
  ) {
    this.#options = options;
    this.#context = context;
    this.#process = process;
    this.#sanitizer = sanitizer;
    this.#onClose = onClose;
    this.#publisher = new TurnPublisher({
      maxBytes: options.maxEventBytes,
      maxItems: options.maxEventItems,
    });
    this.events = this.#publisher.events;
    if (options.policy.steering === "prompt" && options.policy.protocolVersion === 1) {
      this.steer = (input) => this.#steerWithPrompt(input);
    }
    this.#client = dependencies.createClient({
      handlers: {
        elicitation: (request, signal) => this.#elicitation(request, signal),
        permission: (request, signal) => this.#permission(request, signal),
        readTextFile: (path, line, limit) =>
          acpReadTextFileHandler([
            this.#context.workspacePath,
            ...this.#context.writableRoots,
            ...(this.#context.attachmentDirectory ? [this.#context.attachmentDirectory] : []),
          ])(path, line, limit),
        update: (sessionId, update) => this.#handleUpdate(sessionId, update),
      },
      process,
      ...(options.hooks.transformStdout
        ? { stdout: options.hooks.transformStdout(process.stdout) }
        : {}),
      version: options.policy.protocolVersion,
    });
    this.#abortListener = () => void this.stop();
    context.signal.addEventListener("abort", this.#abortListener, { once: true });
    process.child.stderr.on("data", (chunk: Buffer | string) => this.#appendStderr(chunk));
    // Nothing awaits this chain: a spawn error surfaces through initialize,
    // and a publish overflow has already latched the session unusable and
    // closed its stream with that error.
    void process.exited.then((exit) => this.#processExited(exit)).catch(() => undefined);
  }

  static async open(
    options: AcpHarnessOptions,
    dependencies: Required<AcpHarnessDependencies>,
    context: HarnessSessionContext,
    mode: OpenMode,
    onClose: (session: AcpHarnessSession) => void,
  ): Promise<AcpHarnessSession> {
    context.signal.throwIfAborted();
    const sanitizer = new AcpDiagnosticSanitizer(context.environment, context.agentTools.token);
    let process: SupervisedProcess;
    try {
      const rawLaunch = await options.launch({ accessMode: context.accessMode, context });
      sanitizer.addEnvironment(rawLaunch.environment);
      const launch = context.wrapProcessLaunch(rawLaunch);
      sanitizer.addEnvironment(launch.environment);
      process = dependencies.spawn({
        ...launch,
        maxOutputBytes: acpProtocolOutputBytes,
        signal: context.signal,
      });
    } catch (error) {
      const classified =
        error instanceof OpensteerError
          ? error
          : options.hooks.classifyError(error, {
              operation: mode.type === "resume" ? "resume" : "new",
              stderrTail: "",
            });
      throw sanitizer.sanitizeError(classified);
    }
    const session = new AcpHarnessSession(
      options,
      dependencies,
      context,
      process,
      sanitizer,
      onClose,
    );
    try {
      await session.#initialize(mode);
      session.#opening = false;
      return session;
    } catch (error) {
      await session.#stop(false);
      throw session.#classifyError(error, {
        operation: mode.type === "resume" ? "resume" : "new",
        stderrTail: session.#stderrTail(),
      });
    }
  }

  get providerSessionReference(): string {
    if (!this.#providerSessionReference) {
      throw new OpensteerError({ code: "internal", message: "ACP session is still opening" });
    }
    return this.#providerSessionReference;
  }

  async execute(run: HarnessRunInput): Promise<void> {
    this.#assertUsable();
    if (this.#active) {
      throw new OpensteerError({
        code: "conflict",
        message: "ACP session already has an active turn",
      });
    }
    assertSameEnvironment(this.#context.environment, run.environment);
    const active: ActiveTurn = {
      nodeResults: new Map(),
      settledNodes: new Set(),
      childSessions: new Map(),
      childText: new Map(),
      assistant: new Map(),
      assistantHoldActive: this.#options.hooks.holdAssistant !== undefined,
      completion: new Deferred<void>(),
      heldAssistant: [],
      heldAssistantCharacters: 0,
      interruptRequested: run.signal.aborted,
      nodes: new SubagentNodes((event) => this.#publish(event)),
      reasoning: new Map(),
      requestedBy: run.requestedBy,
      runId: run.runId,
      runSignal: run.signal,
      livePrompts: new Set(),
      prompts: new Map(),
      nextPromptSequence: 0,
      pendingSteers: 0,
      promptSequence: 0,
      terminal: false,
      stderrStart: this.#stderrPosition(),
      tools: new Map(),
      finishedTools: new Set(),
    };
    this.#active = active;
    const abort = () => {
      active.interruptRequested = true;
      void this.#interruptActive(active);
    };
    if (!run.signal.aborted) run.signal.addEventListener("abort", abort, { once: true });
    try {
      if (run.signal.aborted) {
        this.#finish(active, "interrupted");
        return;
      }
      const prepared = await this.#promptBlocks(run);
      if (active.terminal || this.#closed) return;
      if (run.signal.aborted) {
        this.#finish(active, "interrupted");
        return;
      }
      active.guidanceTicket = prepared.ticket;
      const checkOutcome = await this.#options.hooks.watchPromptOutcome?.({
        context: this.#context,
        providerSessionReference: this.providerSessionReference,
      });
      if (active.terminal || this.#closed) return;
      if (run.signal.aborted) {
        this.#finish(active, "interrupted");
        return;
      }
      this.#publish(runStartedEvent());
      const sequence = ++active.nextPromptSequence;
      const stderrStart = this.#stderrPosition();
      const entry: ActivePrompt = {
        acknowledged: true,
        ...(checkOutcome ? { checkOutcome } : {}),
        sequence,
        stderrStart,
      };
      active.promptSequence = sequence;
      active.stderrStart = stderrStart;
      active.prompts.set(sequence, entry);
      active.livePrompts.add(sequence);
      // A Run abort is translated through the engine's cancel policy. In
      // particular, resume-based ACP engines keep this RPC alive until their
      // post-cancel prompt outcome arrives.
      const promptPromise = this.#client.prompt(
        this.providerSessionReference,
        prepared.blocks,
        this.#lifetime.signal,
      );
      void this.#followPrompt(active, entry, promptPromise);
      await active.completion.promise;
    } catch (error) {
      if (!active.terminal) {
        const heldDecision = await this.#settleHeldAssistant(active);
        if (active.terminal) return;
        if (active.interruptRequested || run.signal.aborted || this.#closed) {
          this.#flushHeldAssistant(active);
          this.#finish(active, "interrupted");
        } else if (heldDecision.status === "failed") {
          if (heldDecision.discardAssistant) active.heldAssistant.length = 0;
          else this.#flushHeldAssistant(active);
          const failure = this.#sanitizeError(heldDecision.error);
          if (failure.code === harnessSessionBrokenFailureCode) {
            this.#publisher.latchUnusable(failure);
          }
          this.#fail(active, failure);
        } else {
          this.#flushHeldAssistant(active);
          const interpretation = this.#classifyError(error, {
            operation: "prompt",
            providerSessionReference: this.providerSessionReference,
            stderrBeforePrompt: this.#stderrBefore(active.stderrStart),
            stderrTail: this.#stderrSince(active.stderrStart),
          });
          if (interpretation.code === harnessSessionBrokenFailureCode) {
            this.#publisher.latchUnusable(interpretation);
          }
          this.#fail(active, interpretation);
        }
      }
    } finally {
      run.signal.removeEventListener("abort", abort);
      if (this.#active === active) this.#active = undefined;
      // A call belongs to the Run that announced it; the Host settles any it left open.
      for (const key of [...active.tools.keys(), ...active.finishedTools])
        this.#endedTools.add(key);
    }
  }

  async #followPrompt(
    active: ActiveTurn,
    entry: ActivePrompt,
    promptPromise: Promise<AcpPromptResult>,
  ): Promise<void> {
    try {
      const result = await promptPromise;
      active.livePrompts.delete(entry.sequence);
      if (result.usage && !active.terminal) active.usage = result.usage;
      if (active.terminal) return;
      if (active.promptSequence !== entry.sequence) {
        entry.settled = { ok: true, result };
        return;
      }
      if (active.pendingSteers > 0) {
        // Keep this prompt's outcome in reserve while a follow-up steer is awaiting
        // admission or explicit refusal, so a busy refusal does not discard it.
        entry.settled = { ok: true, result };
        return;
      }
      await this.#completePromptResolution(active, entry, result);
    } catch (error) {
      active.livePrompts.delete(entry.sequence);
      if (active.terminal) return;
      if (active.promptSequence !== entry.sequence) {
        entry.settled = { ok: false, error };
        return;
      }
      if (active.pendingSteers > 0) {
        entry.settled = { ok: false, error };
        return;
      }
      await this.#completePromptRejection(active, entry, error);
    }
  }

  async #completePromptResolution(
    active: ActiveTurn,
    entry: ActivePrompt,
    result: AcpPromptResult,
  ): Promise<void> {
    const superseded = () => active.promptSequence !== entry.sequence;
    const interrupted = () => active.interruptRequested || active.runSignal.aborted || this.#closed;
    if (active.terminal || superseded()) return;
    if (
      entry.steerMessageId &&
      !entry.acknowledged &&
      !interrupted() &&
      result.stopReason !== "cancelled"
    ) {
      entry.acknowledged = true;
      this.#publish({
        data: { messageId: entry.steerMessageId },
        type: "message.injected",
      });
    }
    const heldDecision = await this.#settleHeldAssistant(active);
    if (active.terminal || superseded()) return;
    if (interrupted()) {
      this.#flushHeldAssistant(active);
      this.#finish(active, "interrupted");
      return;
    }
    if (heldDecision.status === "failed") {
      if (heldDecision.discardAssistant) active.heldAssistant.length = 0;
      else this.#flushHeldAssistant(active);
      const failure = this.#sanitizeError(heldDecision.error);
      if (failure.code === harnessSessionBrokenFailureCode) {
        this.#publisher.latchUnusable(failure);
      }
      this.#fail(active, failure);
      return;
    }
    const outcomeFailure =
      entry.checkOutcome && !interrupted() && !this.#processEnded
        ? await entry.checkOutcome(result, {
            assistantText: this.#heldAssistantText(active),
          })
        : undefined;
    if (active.terminal || superseded()) return;
    if (interrupted()) {
      this.#flushHeldAssistant(active);
      this.#finish(active, "interrupted");
      return;
    }
    if (outcomeFailure) {
      if (outcomeFailure.discardAssistant) active.heldAssistant.length = 0;
      else this.#flushHeldAssistant(active);
      const failure = this.#sanitizeError(outcomeFailure.error);
      this.#publisher.latchUnusable(failure);
      this.#fail(active, failure);
      return;
    }
    if (active.pendingSteers > 0) {
      entry.settled = { ok: true, result };
      return;
    }
    this.#flushHeldAssistant(active);
    await this.#stopBackgroundChildren(active);
    if (active.terminal || superseded()) return;
    if (
      active.guidanceTicket &&
      !interrupted() &&
      !this.#processEnded &&
      !["cancelled", "refusal", "error"].includes(result.stopReason)
    ) {
      this.#guidance.acknowledge(active.guidanceTicket);
    }
    this.#finish(active, interrupted() ? "interrupted" : "completed");
  }

  async #completePromptRejection(
    active: ActiveTurn,
    entry: ActivePrompt,
    error: unknown,
  ): Promise<void> {
    const superseded = () => active.promptSequence !== entry.sequence;
    const interrupted = () => active.interruptRequested || active.runSignal.aborted || this.#closed;
    if (active.terminal || superseded()) return;
    // A late explicit JSON-RPC refusal on a follow-up steer rolls back to the
    // previous prompt (live or preserved) instead of failing a healthy Run.
    if (entry.steerMessageId && isExplicitAcpSteerRefusal(error) && !interrupted()) {
      active.prompts.delete(entry.sequence);
      const fallback = this.#latestEarlierPrompt(active, entry.sequence);
      if (fallback) {
        active.promptSequence = fallback.sequence;
        active.stderrStart = fallback.stderrStart;
        if (fallback.settled && active.pendingSteers === 0) {
          await this.#resumeSettledPrompt(active, fallback);
        }
        return;
      }
    }
    const heldDecision = await this.#settleHeldAssistant(active);
    if (active.terminal || superseded()) return;
    if (interrupted()) {
      this.#flushHeldAssistant(active);
      this.#finish(active, "interrupted");
      return;
    }
    if (heldDecision.status === "failed") {
      if (heldDecision.discardAssistant) active.heldAssistant.length = 0;
      else this.#flushHeldAssistant(active);
      const failure = this.#sanitizeError(heldDecision.error);
      if (failure.code === harnessSessionBrokenFailureCode) {
        this.#publisher.latchUnusable(failure);
      }
      this.#fail(active, failure);
      return;
    }
    this.#flushHeldAssistant(active);
    const interpretation = this.#classifyError(error, {
      operation: "prompt",
      providerSessionReference: this.providerSessionReference,
      stderrBeforePrompt: this.#stderrBefore(entry.stderrStart),
      stderrTail: this.#stderrSince(entry.stderrStart),
    });
    if (interpretation.code === harnessSessionBrokenFailureCode) {
      this.#publisher.latchUnusable(interpretation);
    }
    this.#fail(active, interpretation);
  }

  async #resumeSettledPrompt(active: ActiveTurn, entry: ActivePrompt): Promise<void> {
    const settled = entry.settled;
    if (!settled || active.terminal || active.promptSequence !== entry.sequence) return;
    entry.settled = undefined;
    if (settled.ok) {
      await this.#completePromptResolution(active, entry, settled.result);
    } else {
      await this.#completePromptRejection(active, entry, settled.error);
    }
  }

  #latestEarlierPrompt(active: ActiveTurn, beforeSequence: number): ActivePrompt | undefined {
    let latest: ActivePrompt | undefined;
    for (const candidate of active.prompts.values()) {
      if (candidate.sequence >= beforeSequence) continue;
      if (!latest || candidate.sequence > latest.sequence) latest = candidate;
    }
    return latest;
  }

  async #steerWithPrompt(input: HarnessSteerInput): Promise<void> {
    this.#assertUsable();
    const active = this.#active;
    if (
      !active ||
      active.terminal ||
      active.interruptRequested ||
      active.promptSequence === 0 ||
      active.livePrompts.size === 0
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "ACP session has no active turn to steer",
      });
    }
    if (input.signal?.aborted) {
      throw new OpensteerError({
        code: "conflict",
        message: "ACP steer was cancelled before delivery",
      });
    }
    const blocks = await this.#steerBlocks(input);
    const checkOutcome = await this.#options.hooks.watchPromptOutcome?.({
      context: this.#context,
      providerSessionReference: this.providerSessionReference,
    });
    this.#assertUsable();
    if (
      this.#active !== active ||
      active.terminal ||
      active.interruptRequested ||
      active.livePrompts.size === 0 ||
      input.signal?.aborted
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "ACP turn ended before the steer could be delivered",
      });
    }
    if (active.heldAssistant.length > 0) {
      const heldDecision = this.#heldAssistantDecision(active);
      if (heldDecision.status === "failed") {
        if (heldDecision.discardAssistant) active.heldAssistant.length = 0;
        else this.#flushHeldAssistant(active);
        const failure = this.#sanitizeError(heldDecision.error);
        if (failure.code === harnessSessionBrokenFailureCode) {
          this.#publisher.latchUnusable(failure);
        }
        this.#fail(active, failure);
        throw new OpensteerError({
          code: "conflict",
          message: "ACP turn failed before the steer could be delivered",
        });
      }
      this.#flushHeldAssistant(active);
    }
    active.assistantHoldActive =
      this.#options.hooks.holdAssistant !== undefined &&
      active.assistant.size === 0 &&
      active.reasoning.size === 0 &&
      active.tools.size === 0 &&
      active.finishedTools.size === 0;
    const sequence = ++active.nextPromptSequence;
    const stderrStart = this.#stderrPosition();
    const entry: ActivePrompt = {
      acknowledged: false,
      ...(checkOutcome ? { checkOutcome } : {}),
      sequence,
      stderrStart,
      steerMessageId: input.input.messageId,
    };
    active.prompts.set(sequence, entry);
    active.livePrompts.add(sequence);
    active.pendingSteers += 1;
    const promptPromise = this.#client.prompt(
      this.providerSessionReference,
      blocks,
      this.#lifetime.signal,
    );
    // ACP v1 `session/prompt` carries no intermediate delivery receipt tied to this
    // request: neither silence nor unrelated `session/update` notifications nor an
    // earlier prompt settling proves delivery. Only this RPC's own JSON-RPC result
    // proves delivery, and only an explicit JSON-RPC non-admission error proves refusal.
    type SteerWindowOutcome =
      | { readonly kind: "resolved"; readonly result: AcpPromptResult }
      | { readonly kind: "rejected"; readonly error: unknown }
      | { readonly kind: "aborted" }
      | { readonly kind: "timeout" };
    const outcome = await new Promise<SteerWindowOutcome>((resolve) => {
      let done = false;
      const finish = (value: SteerWindowOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish({ kind: "aborted" });
      if (input.signal) {
        if (input.signal.aborted) {
          finish({ kind: "aborted" });
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => finish({ kind: "timeout" }), steerAdmissionWindowMs);
      void promptPromise.then(
        (result) => finish({ kind: "resolved", result }),
        (error: unknown) => finish({ kind: "rejected", error }),
      );
    });
    active.pendingSteers -= 1;

    if (outcome.kind === "resolved") {
      active.livePrompts.delete(sequence);
      if (outcome.result.usage && !active.terminal) active.usage = outcome.result.usage;
      active.promptSequence = sequence;
      active.stderrStart = stderrStart;
      const interrupted =
        active.interruptRequested ||
        active.runSignal.aborted ||
        this.#closed ||
        Boolean(input.signal?.aborted) ||
        outcome.result.stopReason === "cancelled";
      if (interrupted) {
        void this.#completePromptResolution(active, entry, outcome.result);
        throw new HarnessSteerDeliveryUnknownError(
          "ACP follow-up steer was interrupted after delivery began",
        );
      }
      entry.acknowledged = true;
      void this.#completePromptResolution(active, entry, outcome.result);
      return;
    }

    if (outcome.kind === "rejected") {
      active.livePrompts.delete(sequence);
      active.prompts.delete(sequence);
      const interrupted =
        active.interruptRequested ||
        active.runSignal.aborted ||
        this.#closed ||
        Boolean(input.signal?.aborted);
      if (isExplicitAcpSteerRefusal(outcome.error) && !interrupted) {
        const current = active.prompts.get(active.promptSequence);
        if (current?.settled && active.pendingSteers === 0 && !active.terminal) {
          void this.#resumeSettledPrompt(active, current);
        }
        const detail =
          outcome.error instanceof Error && outcome.error.message
            ? `ACP rejected the follow-up steer: ${outcome.error.message}`
            : "ACP rejected the follow-up steer";
        throw new OpensteerError({
          cause: outcome.error,
          code: "conflict",
          message: this.#sanitizePublicMessage(detail),
        });
      }
      if (!active.terminal && active.livePrompts.size === 0) {
        if (interrupted) {
          this.#finish(active, "interrupted");
        } else {
          const interpretation = this.#classifyError(outcome.error, {
            operation: "prompt",
            providerSessionReference: this.providerSessionReference,
            stderrBeforePrompt: this.#stderrBefore(stderrStart),
            stderrTail: this.#stderrSince(stderrStart),
          });
          if (interpretation.code === harnessSessionBrokenFailureCode) {
            this.#publisher.latchUnusable(interpretation);
          }
          this.#fail(active, interpretation);
        }
      }
      const detail =
        outcome.error instanceof Error && outcome.error.message
          ? `ACP follow-up steer delivery could not be confirmed: ${outcome.error.message}`
          : "ACP follow-up steer delivery could not be confirmed";
      throw new HarnessSteerDeliveryUnknownError(this.#sanitizePublicMessage(detail), {
        cause: outcome.error,
      });
    }

    // Silence past the short window or post-send abort: bytes already left the wire,
    // so delivery is unknown until this prompt's own JSON-RPC result arrives.
    active.promptSequence = sequence;
    active.stderrStart = stderrStart;
    void this.#followPrompt(active, entry, promptPromise);
    throw new HarnessSteerDeliveryUnknownError(
      outcome.kind === "aborted"
        ? "ACP follow-up steer was cancelled after delivery began"
        : "ACP follow-up steer delivery could not be confirmed before the prompt settled",
    );
  }

  async #steerBlocks(input: HarnessSteerInput): Promise<readonly AcpPromptBlock[]> {
    const parts = resolvedInputSequence(input.input, input.attachments);
    const blocks: AcpPromptBlock[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text });
      } else {
        const bytes = await readVerifiedAttachmentBytes(part.attachment);
        blocks.push({
          data: bytes.toString("base64"),
          mimeType: part.attachment.attachment.mediaType,
          type: "image",
        });
      }
    }
    const rewrite = this.#options.hooks.rewritePromptText;
    if (!rewrite) return blocks;
    return Promise.all(
      blocks.map(async (block) =>
        block.type === "text"
          ? { ...block, text: await rewrite(block.text, this.#context) }
          : block,
      ),
    );
  }

  async interrupt(): Promise<void> {
    const active = this.#active;
    if (!active || active.terminal) return;
    active.interruptRequested = true;
    await this.#interruptActive(active);
  }

  rebind(context: HarnessSessionContext): void {
    this.#assertUsable();
    context.signal.throwIfAborted();
    if (this.#active || this.#pending.size)
      throw new Error("An ACP session cannot be rebound during a Run");
    if (this.#context.voiceCall || context.voiceCall)
      throw new Error("A voice call cannot reuse a session");
    assertSameEnvironment(this.#context.environment, context.environment);
    this.#context.signal.removeEventListener("abort", this.#abortListener);
    this.#context = context;
    context.signal.addEventListener("abort", this.#abortListener, { once: true });
  }

  async releaseForReuse(): Promise<boolean> {
    return (
      !this.#closed &&
      !this.#publisher.unusable &&
      !this.#processEnded &&
      !this.#active &&
      this.#pending.size === 0 &&
      !this.#persistentApprovalGranted &&
      !this.#backgroundWorkRemains
    );
  }

  async resolveRequest(requestId: RequestId, response: RequestResponse): Promise<void> {
    const interaction = this.#pending.get(requestId);
    if (!interaction) {
      throw new OpensteerError({ code: "not_found", message: "ACP Request is no longer pending" });
    }
    if (interaction.kind === "choice") {
      if (response.kind !== "choice" || !interaction.offered?.has(response.optionId)) {
        throw invalidRequestResponse();
      }
      interaction.settlement.resolve(response.optionId);
    } else {
      if (response.kind !== "form") throw invalidRequestResponse();
      interaction.settlement.resolve(response.answers);
    }
    this.#pending.delete(requestId);
  }

  stop(): Promise<void> {
    return (this.#stopPromise ??= this.#stop(true));
  }

  async #initialize(mode: OpenMode): Promise<void> {
    const inspection = await this.#client.initialize({
      capabilities: this.#options.policy.clientCapabilities,
      deadlineMs: this.#options.policy.initializeDeadlineMs,
      info: this.#options.policy.clientInfo,
      ...(this.#options.policy.initializeMetadata
        ? { metadata: this.#options.policy.initializeMetadata }
        : {}),
      signal: this.#lifetime.signal,
    });
    if (inspection.protocolVersion !== this.#options.policy.protocolVersion) {
      throw new OpensteerError({
        code: "harness_error",
        message: `ACP engine negotiated protocol ${inspection.protocolVersion}, expected ${this.#options.policy.protocolVersion}`,
      });
    }
    if (this.#options.policy.eagerAuthentication) {
      const method = this.#options.hooks.authenticationMethod?.(this.#context, inspection);
      if (method) await this.#client.authenticate(method, this.#lifetime.signal);
    }
    const environment = {
      additionalDirectories: this.#context.writableRoots.filter(
        (root) => root !== this.#context.workspacePath,
      ),
      cwd: this.#context.workspacePath,
      mcpServers: mcpServers(this.#context),
    };
    let snapshot: AcpSessionSnapshot;
    if (mode.type === "start") {
      snapshot = await this.#client.newSession(environment, this.#lifetime.signal);
    } else {
      this.#replaying = this.#options.policy.resume.suppressReplay;
      try {
        snapshot = await this.#client.resumeSession(
          mode.reference,
          environment,
          this.#options.policy.resume,
          this.#lifetime.signal,
        );
      } finally {
        this.#replaying = false;
      }
      if (snapshot.sessionId !== mode.reference) {
        throw new OpensteerError({
          code: "harness_error",
          message: `ACP resumed ${snapshot.sessionId} instead of ${mode.reference}`,
        });
      }
    }
    if (!snapshot.sessionId.trim()) {
      throw new OpensteerError({ code: "harness_error", message: "ACP returned no session id" });
    }
    this.#providerSessionReference = snapshot.sessionId;
    await this.#configureSession(snapshot);
  }

  async #configureSession(snapshot: AcpSessionSnapshot): Promise<void> {
    const signal = this.#lifetime.signal;
    const sessionId = snapshot.sessionId;
    const modeId = this.#options.policy.accessModeIds[this.#context.accessMode];
    if (snapshot.modes?.availableModes.some((mode) => mode.id === modeId)) {
      await this.#client.setMode(sessionId, modeId, signal);
    }
    const selection = this.#context.modelSelection;
    const modelId = selection.nativeModelId ?? selection.modelId;
    const policy = this.#options.policy.model;
    if (policy.type === "set-model") {
      const effort = policy.effortOptionId ? selection.options[policy.effortOptionId] : undefined;
      await this.#client.setModel(
        sessionId,
        modelId,
        typeof effort === "string" && policy.effortMetadataKey
          ? { [policy.effortMetadataKey]: effort }
          : undefined,
        signal,
      );
      return;
    }
    const modelOption = snapshot.configOptions.find(
      (option) => option.category === policy.modelCategory,
    );
    const offeredModels = modelOption?.type === "select" ? (modelOption.options ?? []) : [];
    const offered = offeredModels.some((option) => option.value === modelId);
    const legacy = policy.legacyModelSuffixes?.some((suffix) =>
      offeredModels.some((option) => modelId === `${option.value}-${suffix}`),
    );
    if (!modelOption || (!offered && !legacy)) {
      throw new OpensteerError({
        code: "bad_request",
        message: `${this.#options.engineLabel} does not offer model ${modelId} in this session`,
      });
    }
    const configured = await this.#client.setConfigOption(
      sessionId,
      { id: modelOption.id, type: "select", value: modelId },
      signal,
    );
    const effort = selection.options[policy.effortOptionId];
    const effortOption = configured.find((option) => option.category === policy.effortCategory);
    if (
      effortOption &&
      typeof effort === "string" &&
      effortOption.options?.some((option) => option.value === effort)
    ) {
      await this.#client.setConfigOption(
        sessionId,
        { id: effortOption.id, type: "select", value: effort },
        signal,
      );
    } else if (typeof effort === "string") {
      throw new OpensteerError({
        code: "bad_request",
        message: `${this.#options.engineLabel} does not offer effort ${effort} for this model`,
      });
    }
  }

  async #promptBlocks(run: HarnessRunInput): Promise<{
    blocks: readonly AcpPromptBlock[];
    ticket: GuidanceTicket;
  }> {
    const parts = run.inputs.flatMap((input) => resolvedInputSequence(input, run.attachments));
    const blocks: AcpPromptBlock[] = [];
    for (const part of parts) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text });
      else {
        const bytes = await readVerifiedAttachmentBytes(part.attachment);
        blocks.push({
          data: bytes.toString("base64"),
          mimeType: part.attachment.attachment.mediaType,
          type: "image",
        });
      }
    }
    const guidance = [
      this.#context.platformGuide,
      this.#context.instructions,
      durableHistoryWindowNotice(this.#context),
      await renderHarnessSkillCatalog(this.#context.skills),
    ]
      .filter(Boolean)
      .join("\n\n");
    const facts = [
      initialContinuationContextPrompt(this.#context),
      `## This Run's computers\n${this.#context.machineAccessNotice}`,
      harnessTurnPreamble(run, (input) =>
        resolvedInputSequence(input, run.attachments)
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
    const rewrite = this.#options.hooks.rewritePromptText;
    const rewritten = await Promise.all(
      [
        { type: "text" as const, text: guidance },
        { type: "text" as const, text: facts },
        ...blocks,
      ].map(async (block) =>
        block.type === "text" && rewrite
          ? { ...block, text: await rewrite(block.text, this.#context) }
          : block,
      ),
    );
    const stable = rewritten[0]!;
    const ticket = this.#guidance.prepare(stable.type === "text" ? stable.text : "");
    return { blocks: ticket.send === undefined ? rewritten.slice(1) : rewritten, ticket };
  }

  #handleUpdate(sessionId: string, update: unknown): void {
    if (this.#replaying) return;
    const normalized = this.#options.hooks.normalizeUpdate?.(update) ?? normalizeAcpUpdate(update);
    for (const entry of normalized) {
      if (
        entry.kind !== "compaction" ||
        entry.nodeKey ||
        sessionId !== this.#providerSessionReference
      )
        continue;
      this.#guidance.compacted(entry.compactionId);
    }
    const active = this.#active;
    if (!active || active.terminal) return;
    const foreign = sessionId !== this.#providerSessionReference;
    const sessionKey = active.childSessions.get(sessionId);
    if (foreign && !sessionKey) return;
    for (const entry of normalized) {
      const nodeKey = foreign ? sessionKey : entry.nodeKey;
      if (nodeKey && !active.nodes.nodeId(nodeKey)) continue;
      this.#applyUpdate(active, { ...entry, ...(nodeKey ? { nodeKey } : {}) });
    }
  }

  #applyUpdate(active: ActiveTurn, update: AcpNormalizedUpdate): void {
    if ((update.kind === "assistant" || update.kind === "thought") && update.nodeKey) {
      const blockId = update.messageId ?? update.kind;
      const key = JSON.stringify([update.nodeKey, update.kind, blockId]);
      const previous = active.childText.get(key);
      active.childText.set(key, {
        nodeKey: update.nodeKey,
        kind: update.kind,
        blockId,
        text: (previous?.text ?? "") + update.text,
      });
      if (update.kind === "assistant") active.nodes.progress(update.nodeKey, update.text);
      return;
    }
    if (active.assistantHoldActive && update.kind !== "assistant") {
      this.#flushHeldAssistant(active);
      active.assistantHoldActive = false;
    }
    switch (update.kind) {
      case "assistant": {
        if (active.assistantHoldActive) {
          active.heldAssistant.push({
            ...(update.messageId ? { messageId: update.messageId } : {}),
            text: update.text,
          });
          active.heldAssistantCharacters += update.text.length;
          if (
            active.heldAssistantCharacters > (this.#options.hooks.holdAssistant?.maxCharacters ?? 0)
          ) {
            this.#flushHeldAssistant(active);
            active.assistantHoldActive = false;
          }
          return;
        }
        const key = update.messageId ?? "assistant";
        active.assistant.set(key, `${active.assistant.get(key) ?? ""}${update.text}`);
        if (update.text) this.#publish({ data: { text: update.text }, type: "assistant.delta" });
        return;
      }
      case "thought": {
        const key = update.messageId ?? "reasoning";
        active.reasoning.set(key, `${active.reasoning.get(key) ?? ""}${update.text}`);
        if (update.text) {
          this.#publish({ data: { blockId: key, text: update.text }, type: "reasoning.delta" });
        }
        return;
      }
      case "tool":
        if (update.nodeKey) this.#flushChild(active, update.nodeKey);
        this.#applyTool(active, update.toolCall, update.nodeKey);
        return;
      case "subagent": {
        update = { ...update, key: active.childSessions.get(update.key) ?? update.key };
        if (active.settledNodes.has(update.key)) return;
        if (update.state === "started") {
          active.nodes.ensure(update.key, {
            parentKey: update.parentKey ?? null,
            originCallId: update.originCallId ?? null,
            nativeRef: update.key,
            ...(update.model ? { model: update.model } : {}),
            ...(update.prompt ? { prompt: update.prompt } : {}),
            ...(update.sessionReference ? { sessionRef: update.sessionReference } : {}),
            ...(update.title ? { title: update.title } : {}),
          });
          active.nodes.update(update.key, {
            ...update,
            originCallId: active.nodes.originCallId(update.key) ?? update.originCallId ?? null,
          });
          if (update.sessionReference)
            active.childSessions.set(update.sessionReference, update.key);
          if (update.result) {
            active.nodes.noteResult(update.key, update.result);
            active.nodeResults.set(update.key, update.result);
          }
        } else {
          this.#flushChild(active, update.key);
          active.settledNodes.add(update.key);
          const result = update.result ?? active.nodeResults.get(update.key);
          active.nodes.complete(update.key, update.state, result ? { result } : {});
        }
        return;
      }
      case "usage":
        active.usage = update;
        return;
      case "compaction":
      case "ignore":
        return;
    }
  }

  #flushChild(active: ActiveTurn, nodeKey: string): void {
    for (const [key, block] of active.childText) {
      if (block.nodeKey !== nodeKey) continue;
      if (block.kind === "assistant") active.nodes.message(nodeKey, block.text);
      else active.nodes.reasoning(nodeKey, block.blockId, block.text);
      active.childText.delete(key);
    }
  }

  /**
   * Turns an engine's tool frames into exactly one `tool.started` and at most
   * one `tool.completed` per call. Engines resend frames for calls they
   * already closed: Antigravity fails every open call on an unrelated step
   * error and then announces those calls again, and carries background
   * commands into later turns. So the first frame of a call starts it, a
   * terminal frame finishes it, and a finished call, or one an earlier Run
   * announced, takes nothing more.
   */
  #applyTool(active: ActiveTurn, call: AcpToolCall, nodeKey?: string): void {
    const nodeId = nodeKey ? active.nodes.nodeId(nodeKey) : undefined;
    if (nodeKey && !nodeId) return;
    const toolKey = JSON.stringify([nodeKey ?? null, call.id]);
    if (active.finishedTools.has(toolKey) || this.#endedTools.has(toolKey)) return;
    const earlier = active.tools.get(toolKey);
    const merged = { ...earlier, ...call };
    const terminal = isTerminalAcpToolCall(merged);
    if (terminal) {
      active.tools.delete(toolKey);
      active.finishedTools.add(toolKey);
    } else {
      active.tools.set(toolKey, merged);
    }
    if (!earlier) {
      if (nodeKey) active.nodes.progress(nodeKey, merged.title ?? "Running tool");
      this.#publish({
        data: {
          ...(nodeId ? { nodeId } : {}),
          arguments: merged.rawInput,
          callId: merged.id,
          tool:
            this.#options.hooks.toolIdentity?.(merged, this.#context) ?? acpToolIdentity(merged),
        },
        type: "tool.started",
      });
    }
    if (terminal) {
      this.#publish({
        data: {
          callId: merged.id,
          ...(nodeId ? { nodeId } : {}),
          isError: merged.status === "failed",
          output: toolOutputWithImages(
            merged.rawOutput ?? merged.content,
            this.#context.imageStore,
            merged.rawOutput !== undefined ? merged.content : undefined,
          ),
        },
        type: "tool.completed",
      });
    }
    for (const update of this.#options.hooks.toolUpdates?.(merged) ?? [])
      this.#applyUpdate(
        active,
        update.kind === "subagent" && nodeKey ? { ...update, parentKey: nodeKey } : update,
      );
  }

  /**
   * Saves what the turn streamed as durable events. Every terminal path runs
   * it: clients drop live text at the terminal event, so a failed or stopped
   * turn would otherwise lose the partial reply the person already saw.
   */
  #flushTurn(active: ActiveTurn): void {
    for (const key of active.nodes.liveKeys()) this.#flushChild(active, key);
    for (const text of active.assistant.values()) {
      if (!text) continue;
      this.#publish({
        data: { content: [{ text, type: "text" }], messageId: createId("message") },
        type: "assistant.message",
      });
    }
    for (const [blockId, text] of active.reasoning) {
      if (text) this.#publish({ data: { blockId, text }, type: "reasoning.completed" });
    }
    active.assistant.clear();
    active.reasoning.clear();
  }

  #flushHeldAssistant(active: ActiveTurn): void {
    active.assistantHoldActive = false;
    const held = active.heldAssistant.splice(0);
    active.heldAssistantCharacters = 0;
    for (const update of held) {
      this.#applyUpdate(active, { ...update, kind: "assistant" });
    }
  }

  async #settleHeldAssistant(active: ActiveTurn): Promise<AcpHeldAssistantDecision> {
    const hold = this.#options.hooks.holdAssistant;
    if (!hold) return { status: "succeeded" };
    const deadline = Date.now() + hold.deadlineMs;
    let decision = this.#heldAssistantDecision(active);
    while (
      decision.status !== "failed" &&
      (active.heldAssistant.length > 0 || decision.status === "pending") &&
      !this.#processEnded &&
      !active.terminal
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.#waitForStderrOrProcessExit(remaining);
      decision = this.#heldAssistantDecision(active);
    }
    return decision;
  }

  #heldAssistantText(active: ActiveTurn): string {
    return this.#redactSecrets(active.heldAssistant.map((update) => update.text).join("")).trim();
  }

  #heldAssistantDecision(active: ActiveTurn): AcpHeldAssistantDecision {
    const hold = this.#options.hooks.holdAssistant;
    if (!hold) return { status: "succeeded" };
    return hold.settle({
      assistantText: this.#heldAssistantText(active),
      providerSessionReference: this.providerSessionReference,
      stderrBeforePrompt: this.#stderrBefore(active.stderrStart),
      stderrTail: this.#stderrSince(active.stderrStart),
    });
  }

  #waitForStderrOrProcessExit(deadlineMs: number): Promise<void> {
    if (this.#processEnded) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.#stderrWaiters.delete(done);
        resolve();
      };
      this.#stderrWaiters.add(done);
      timer = setTimeout(done, deadlineMs);
    });
  }

  async #interruptActive(active: ActiveTurn): Promise<void> {
    if (active.terminal) return;
    try {
      await this.#client.cancel(
        this.providerSessionReference,
        this.#options.policy.cancel.metadata,
      );
    } catch (error) {
      if (!this.#closed) {
        const failure = this.#classifyError(error, {
          operation: "cancel",
          stderrTail: this.#stderrTail(),
        });
        this.#publisher.latchUnusable(failure);
      }
    }
    if (this.#options.policy.cancel.behavior === "cancel-and-kill") {
      this.#expectedProcessExit = true;
      await this.#process.terminate(0);
      const heldDecision = await this.#settleHeldAssistant(active);
      if (active.terminal) return;
      if (heldDecision.status === "failed") {
        if (heldDecision.discardAssistant) active.heldAssistant.length = 0;
        else this.#flushHeldAssistant(active);
        this.#fail(active, heldDecision.error);
      } else {
        this.#flushHeldAssistant(active);
        this.#finish(active, "interrupted");
      }
    }
  }

  async #stopBackgroundChildren(active: ActiveTurn): Promise<void> {
    this.#backgroundWorkRemains = active.nodes.liveKeys().length > 0;
    if (
      active.nodes.liveKeys().length === 0 ||
      this.#options.policy.cancel.behavior !== "cancel-and-kill"
    ) {
      return;
    }
    await this.#client
      .cancel(this.providerSessionReference, this.#options.policy.cancel.metadata)
      .catch(() => undefined);
    this.#expectedProcessExit = true;
    await this.#process.terminate().catch(() => undefined);
    await this.#process.exited.catch(() => undefined);
    for (const key of active.nodes.liveKeys()) this.#flushChild(active, key);
    active.nodes.endAll("interrupted");
  }

  async #permission(request: AcpPermissionRequest, signal: AbortSignal): Promise<string | null> {
    const active = this.#active;
    if (!active || active.terminal || active.interruptRequested) return null;
    const nodeKey =
      request.nodeKey ??
      (request.sessionId ? active.childSessions.get(request.sessionId) : undefined);
    if (request.sessionId && request.sessionId !== this.#providerSessionReference && !nodeKey)
      return null;
    const nodeId = nodeKey ? active.nodes.nodeId(nodeKey) : undefined;
    if (nodeKey && !nodeId) return null;
    const disposition =
      this.#options.hooks.permissionDisposition?.(request, this.#context) ?? "ask";
    if (disposition === "allow" || disposition === "deny") {
      const selected = selectAutoPermissionOption(request.options, disposition);
      if (selected) return selected.id;
      if (disposition === "deny") return null;
    }
    const offered = new Set(request.options.map((option) => option.id));
    const choices = this.#options.hooks
      .permissionChoices(request)
      .filter((choice) => offered.has(choice.optionId));
    if (choices.length === 0) return null;
    const settlement = new Deferred<unknown>();
    const requestId = createId("request");
    this.#pending.set(requestId, { kind: "choice", offered, settlement });
    this.#publish({
      data: {
        request: {
          ...pendingRequest(requestId, active, this.#context, request.toolCall.id, {
            detail: permissionDetail(request.toolCall),
            kind: "choice",
            options: choices.map(requestChoice),
            risk: "medium",
            title: request.toolCall.title ?? request.toolCall.name ?? "Allow this action?",
          }),
          ...(nodeId ? { originatingNodeId: nodeId } : {}),
        },
      },
      type: "request.opened",
    });
    const answer = await this.#awaitInteraction(requestId, settlement, signal, (value) =>
      typeof value === "string" ? value : null,
    );
    const choice = choices.find((choice) => choice.optionId === answer);
    const native = request.options.find((option) => option.id === answer);
    // ACP names an approval that outlives the call `allow_always`; the session keeps it.
    if (choice?.hint === "allow-for-run" || native?.kind === "allow_always")
      this.#persistentApprovalGranted = true;
    return answer;
  }

  async #elicitation(request: AcpElicitationRequest, signal: AbortSignal): Promise<unknown> {
    const active = this.#active;
    if (!active || active.terminal || active.interruptRequested || request.mode !== "form") {
      return null;
    }
    const fields = elicitationFields(request.requestedSchema);
    if (fields.length === 0) return null;
    const settlement = new Deferred<unknown>();
    const requestId = createId("request");
    this.#pending.set(requestId, { kind: "form", settlement });
    this.#publish({
      data: {
        request: pendingRequest(
          requestId,
          active,
          this.#context,
          request.toolCallId ?? `elicitation:${requestId}`,
          { fields, kind: "form", title: request.message.slice(0, 240) || "Input needed" },
        ),
      },
      type: "request.opened",
    });
    return this.#awaitInteraction(requestId, settlement, signal, formAnswerValues);
  }

  async #awaitInteraction<T>(
    requestId: RequestId,
    settlement: Deferred<unknown>,
    signal: AbortSignal,
    map: (value: unknown) => T,
  ): Promise<T | null> {
    const abort = () => settlement.resolve(null);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const value = await settlement.promise;
      return value === null ? null : map(value);
    } finally {
      signal.removeEventListener("abort", abort);
      this.#pending.delete(requestId);
    }
  }

  #finish(active: ActiveTurn, status: "completed" | "interrupted"): void {
    if (!this.#publisher.claimTerminal(active)) return;
    this.#flushTurn(active);
    active.nodes.endAll(status === "completed" ? "completed" : "interrupted");
    this.#cancelPending("run-ended");
    this.#publishUsage(active);
    this.#publish(runEndedEvent(status));
    active.completion.resolve();
  }

  #fail(active: ActiveTurn, error: OpensteerError): void {
    if (!this.#publisher.claimTerminal(active)) return;
    this.#flushTurn(active);
    active.nodes.endAll("failed");
    this.#cancelPending("run-ended");
    this.#publishUsage(active);
    const failure = acpFailure(error);
    this.#publish(
      runFailedEvent({
        ...failure,
        message: this.#sanitizePublicMessage(failure.message),
      }),
    );
    active.completion.resolve();
  }

  #publishUsage(active: ActiveTurn): void {
    if (active.usage) this.#publish({ data: active.usage, type: "run.usage" });
  }

  #cancelPending(reason: "run-ended" | "source-closed" | "process-lost"): void {
    for (const [requestId, interaction] of this.#pending) {
      interaction.settlement.resolve(null);
      this.#publish({ data: { reason, requestId }, type: "request.cancelled" });
    }
    this.#pending.clear();
  }

  #processExited(exit: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }): void {
    this.#processEnded = true;
    this.#wakeStderrWaiters();
    if (this.#expectedProcessExit) return;
    if (this.#closed || this.#opening) return;
    const error = new OpensteerError({
      code: "harness_error",
      message: `${this.#options.engineLabel} ACP process exited (${exit.code ?? exit.signal ?? "unknown"})`,
    });
    this.#publisher.latchUnusable(error);
    const active = this.#active;
    if (active && !active.terminal) {
      const heldDecision = this.#heldAssistantDecision(active);
      if (heldDecision.status === "failed" && heldDecision.discardAssistant) {
        active.heldAssistant.length = 0;
      } else {
        this.#flushHeldAssistant(active);
      }
      this.#fail(active, heldDecision.status === "failed" ? heldDecision.error : error);
    }
    this.#cancelPending("process-lost");
    this.#publisher.closeStream(error);
  }

  #appendStderr(chunk: Buffer | string): void {
    // Redact the continuous stderr buffer BEFORE ring-buffer or prompt-offset
    // slicing so a secret split across adjacent chunks or a slice boundary
    // cannot survive half-matched.
    this.#stderr = this.#sanitizer.redactText(this.#stderr + chunk.toString());
    this.#wakeStderrWaiters();
    if (this.#stderr.length <= 16_000) return;
    const removed = this.#stderr.length - 16_000;
    this.#stderr = this.#stderr.slice(removed);
    this.#stderrDropped += removed;
  }

  #wakeStderrWaiters(): void {
    for (const wake of this.#stderrWaiters) wake();
  }

  #stderrTail(): string {
    return this.#stderr;
  }

  #stderrPosition(): number {
    return this.#stderrDropped + this.#stderr.length;
  }

  #stderrSince(position: number): string {
    return this.#stderr.slice(Math.max(0, position - this.#stderrDropped));
  }

  #stderrBefore(position: number): string {
    return this.#stderr.slice(0, Math.max(0, position - this.#stderrDropped));
  }

  #redactSecrets(value: string): string {
    return this.#sanitizer.redactText(value);
  }

  #sanitizePublicMessage(value: string): string {
    return this.#sanitizer.sanitizePublicMessage(value);
  }

  #sanitizeError(error: OpensteerError): OpensteerError {
    return this.#sanitizer.sanitizeError(error);
  }

  #classifyError(error: unknown, context: AcpErrorContext): OpensteerError {
    return this.#sanitizer.sanitizeError(this.#options.hooks.classifyError(error, context));
  }

  #publish(event: HarnessEvent): void {
    if (this.#publisher.streamClosed) return;
    try {
      this.#publisher.publish(event);
    } catch (error) {
      const failure = toHarnessError(error, "ACP event buffer failed");
      this.#publisher.latchUnusable(failure);
      void this.#process.terminate();
      throw failure;
    }
  }

  async #stop(notifyOwner: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#context.signal.removeEventListener("abort", this.#abortListener);
    const active = this.#active;
    if (active && !active.terminal) {
      active.interruptRequested = true;
      await this.#client
        .cancel(this.providerSessionReference, this.#options.policy.cancel.metadata)
        .catch(() => undefined);
      const heldDecision = await this.#settleHeldAssistant(active);
      if (heldDecision.status === "failed") {
        if (heldDecision.discardAssistant) active.heldAssistant.length = 0;
        else this.#flushHeldAssistant(active);
        this.#fail(active, heldDecision.error);
      } else {
        this.#flushHeldAssistant(active);
        this.#finish(active, "interrupted");
      }
    }
    this.#cancelPending("source-closed");
    this.#lifetime.abort(new Error("ACP session stopped"));
    if (this.#providerSessionReference) {
      await closeAcpSessionBestEffort(this.#client, this.#providerSessionReference);
    }
    this.#client.close();
    await this.#process.terminate().catch(() => undefined);
    await this.#process.exited.catch(() => undefined);

    this.#publisher.closeStream();
    if (notifyOwner && this.#providerSessionReference) this.#onClose(this);
  }

  #assertUsable(): void {
    if (this.#closed) {
      throw new OpensteerError({ code: "harness_error", message: "ACP session is closed" });
    }
    if (this.#publisher.unusable) throw this.#publisher.unusable;
    if (this.#processEnded) {
      throw new OpensteerError({ code: "harness_error", message: "ACP process has ended" });
    }
  }
}

function acpFailure(error: OpensteerError): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  const nativeCode = error.details?.acpFailureCode;
  return {
    code: typeof nativeCode === "string" ? nativeCode : error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

const steerAdmissionWindowMs = 50;
const maxPublicDiagnosticLength = 2_000;
const suppressedDiagnosticMessage =
  "Engine diagnostic detail was suppressed because a short credential value is configured.";

class AcpDiagnosticSanitizer {
  readonly #networkSecrets = new Set<string>();
  readonly #diagnosticSecrets = new Set<string>();
  #hasShortSecret = false;

  constructor(environment: Readonly<Record<string, string | undefined>>, agentToolsToken: string) {
    if (agentToolsToken.length >= 4) {
      this.#diagnosticSecrets.add(agentToolsToken);
    } else if (agentToolsToken.length > 0) {
      this.#hasShortSecret = true;
    }
    this.addEnvironment(environment);
  }

  addEnvironment(environment: Readonly<Record<string, string | undefined>> | undefined): void {
    if (!environment) return;
    for (const secret of networkCredentialSecrets(environment)) {
      this.#networkSecrets.add(secret);
    }
    for (const secret of engineDiagnosticSecrets(environment, 4)) {
      this.#diagnosticSecrets.add(secret);
    }
    if (hasShortNamedSecret(environment, 4)) {
      this.#hasShortSecret = true;
    }
  }

  redactText(value: string): string {
    const networkList = [...this.#networkSecrets].sort((left, right) => right.length - left.length);
    const diagnosticList = [...this.#diagnosticSecrets].sort(
      (left, right) => right.length - left.length,
    );
    let sanitized = redactNetworkCredentials(value, networkList);
    for (const secret of diagnosticList) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
    return sanitized
      .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, "[REDACTED]")
      .replace(
        /\b(api[ _-]?key|authorization|credential|password|secret|token)\s*[:=]\s*[^,\s]+/giu,
        "$1=[REDACTED]",
      );
  }

  sanitizePublicMessage(value: string): string {
    if (this.#hasShortSecret) return suppressedDiagnosticMessage;
    const cleaned = stripControlCharacters(this.redactText(value)).trim();
    return cleaned.length > maxPublicDiagnosticLength
      ? `${cleaned.slice(0, maxPublicDiagnosticLength - 1)}…`
      : cleaned;
  }

  sanitizeError(error: OpensteerError): OpensteerError {
    const message = this.sanitizePublicMessage(error.message);
    if (message === error.message) return error;
    return new OpensteerError({
      cause: error.cause,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      message,
      ...(error.next === undefined ? {} : { next: error.next }),
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      retryable: error.retryable,
    });
  }
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isDisallowedControl =
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127;
    result += isDisallowedControl ? " " : value[index]!;
  }
  return result;
}

function isExplicitAcpSteerRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { readonly code?: unknown }).code;
  if (typeof code !== "number" || !Number.isInteger(code)) return false;
  // Only standard JSON-RPC protocol non-admission codes and ACP's documented
  // session-not-found code (-32002) prove the prompt was never applied.
  // Undocumented implementation-defined server errors (e.g. -32042, -32000),
  // -32800 (requestCancelled), -32603 (internalError), and plain transport
  // errors do not prove non-admission and stay unknown.
  return (
    code === -32700 || code === -32600 || code === -32601 || code === -32602 || code === -32002
  );
}

export function normalizeAcpUpdate(update: unknown): readonly AcpNormalizedUpdate[] {
  if (!isRecord(update) || typeof update.sessionUpdate !== "string") return [];
  const content = isRecord(update.content) ? update.content : undefined;
  switch (update.sessionUpdate) {
    case "compaction_update":
      return update.status === "completed"
        ? [
            {
              kind: "compaction",
              ...(typeof update.compactionId === "string"
                ? { compactionId: update.compactionId }
                : {}),
            },
          ]
        : [];
    case "agent_message_chunk":
      return content?.type === "text" && typeof content.text === "string"
        ? [{ kind: "assistant", text: content.text }]
        : [];
    case "agent_thought_chunk":
      return content?.type === "text" && typeof content.text === "string"
        ? [{ kind: "thought", text: content.text }]
        : [];
    case "tool_call":
    case "tool_call_update": {
      const toolCall = parseAcpToolCall(update);
      return toolCall ? [{ kind: "tool", toolCall }] : [];
    }
    case "usage_update": {
      const usage = isRecord(update.usage) ? update.usage : update;
      const inputTokens = numberValue(usage.inputTokens);
      const outputTokens = numberValue(usage.outputTokens);
      if (inputTokens === undefined || outputTokens === undefined) return [];
      return [
        {
          kind: "usage",
          inputTokens,
          outputTokens,
          ...(numberValue(usage.cachedReadTokens) === undefined
            ? {}
            : { cachedInputTokens: numberValue(usage.cachedReadTokens)! }),
          ...(numberValue(usage.cachedWriteTokens) === undefined
            ? {}
            : { cacheWriteTokens: numberValue(usage.cachedWriteTokens)! }),
          ...(numberValue(usage.thoughtTokens) === undefined
            ? {}
            : { reasoningTokens: numberValue(usage.thoughtTokens)! }),
        },
      ];
    }
    default:
      return [];
  }
}

function mcpServers(context: HarnessSessionContext): readonly AcpMcpServer[] {
  return [
    {
      headers: [{ name: "Authorization", value: `Bearer ${context.agentTools.token}` }],
      name: "opensteer",
      type: "http",
      url: context.agentTools.url,
    },
  ];
}

function pendingRequest(
  id: RequestId,
  active: ActiveTurn,
  context: HarnessSessionContext,
  callId: string,
  presentation: PendingRequest["presentation"],
): PendingRequest {
  return {
    callId,
    cancellationReason: null,
    createdAt: new Date().toISOString(),
    id,
    kind: presentation.kind === "form" ? "harness.input" : "harness.approval",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: active.runId,
    originatingThreadId: context.threadId,
    payload: { kind: presentation.kind === "form" ? "harness.input" : "harness.approval" },
    presentation,
    requestedBy: active.requestedBy,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  };
}

function requestChoice(choice: AcpPermissionChoice) {
  return {
    ...(choice.description ? { description: choice.description.slice(0, 2_000) } : {}),
    hint: choice.hint,
    id: choice.optionId,
    label: choice.label.slice(0, 160),
  };
}

function permissionDetail(call: AcpToolCall): string | undefined {
  const value = call.rawInput ?? call.content;
  if (value === undefined) return undefined;
  return toolOutput(value).slice(0, 20_000);
}

function elicitationFields(
  schema: unknown,
): Extract<PendingRequest["presentation"], { kind: "form" }>["fields"] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties).flatMap(([id, raw]) => {
    if (!isRecord(raw)) return [];
    const choices = Array.isArray(raw.enum)
      ? raw.enum.flatMap((value) => (typeof value === "string" ? [{ label: value, value }] : []))
      : undefined;
    return [
      {
        ...(choices && choices.length > 0 ? { choices } : {}),
        id,
        ...(typeof raw.title === "string" ? { label: raw.title.slice(0, 160) } : {}),
        // An elicitation's schema says which values it takes, and nothing else.
        custom: false,
        multiSelect: raw.type === "array",
        prompt:
          (typeof raw.description === "string" ? raw.description : id).slice(0, 20_000) +
          (required.has(id) ? "" : " (optional)"),
        secret: raw.format === "password",
      },
    ];
  });
}

function formAnswerValues(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value).map(([key, answers]) => [
      key,
      Array.isArray(answers) && answers.length === 1 ? answers[0] : answers,
    ]),
  );
}

function toolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value);
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function assertSameEnvironment(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new OpensteerError({
      code: "conflict",
      message: "ACP Run environment changed after the native session opened",
    });
  }
}

function selectAutoPermissionOption(
  options: readonly AcpPermissionOption[],
  disposition: "allow" | "deny",
): AcpPermissionOption | undefined {
  const target = disposition === "allow" ? "allow_once" : "reject_once";
  return options.find((option) => option.kind.toLowerCase() === target);
}

function invalidRequestResponse(): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: "Response does not match the pending ACP Request",
  });
}
