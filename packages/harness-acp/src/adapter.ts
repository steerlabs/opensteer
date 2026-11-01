import {
  OpensteerError,
  createId,
  normalizeToolOutput,
  type HarnessInstanceId,
  type PendingRequest,
  type RequestId,
  type RequestResponse,
} from "@opensteer/core";
import {
  Deferred,
  HarnessSessionRegistry,
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
  type SupervisedProcess,
} from "@opensteer/harness";
import { isRecord } from "@opensteer/shared/isRecord";
import type {
  AcpElicitationRequest,
  AcpMcpServer,
  AcpPromptBlock,
  AcpProtocolClient,
} from "./protocol.js";
import { acpReadTextFileHandler, createAcpProtocolClient } from "./protocol.js";
import type {
  AcpErrorContext,
  AcpHeldAssistantDecision,
  AcpHarnessOptions,
  AcpNormalizedUpdate,
  AcpPermissionChoice,
  AcpPermissionRequest,
  AcpSessionSnapshot,
  AcpToolCall,
} from "./types.js";

interface AcpHarnessDependencies {
  readonly createClient?: typeof createAcpProtocolClient;
  readonly spawn?: typeof spawnSupervised;
}

type OpenMode =
  { readonly type: "start" } | { readonly type: "resume"; readonly reference: string };

interface ActiveTurn {
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
  readonly tools: Map<string, AcpToolCall>;
  assistantHoldActive: boolean;
  heldAssistantCharacters: number;
  interruptRequested: boolean;
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
  readonly #context: HarnessSessionContext;
  readonly #client: AcpProtocolClient;
  readonly #onClose: (session: AcpHarnessSession) => void;
  readonly #options: AcpHarnessOptions;
  readonly #process: SupervisedProcess;
  readonly #publisher: TurnPublisher;
  readonly #pending = new Map<RequestId, PendingInteraction>();
  readonly #stderrSecrets: readonly string[];
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

  private constructor(
    options: AcpHarnessOptions,
    dependencies: Required<AcpHarnessDependencies>,
    context: HarnessSessionContext,
    process: SupervisedProcess,
    onClose: (session: AcpHarnessSession) => void,
  ) {
    this.#options = options;
    this.#context = context;
    this.#process = process;
    this.#onClose = onClose;
    this.#publisher = new TurnPublisher({
      maxBytes: options.maxEventBytes,
      maxItems: options.maxEventItems,
    });
    this.#stderrSecrets = [
      context.agentTools.token,
      context.integrationTools.token,
      ...Object.entries(context.environment)
        .filter(([name]) => credentialNamePattern.test(name))
        .map(([, value]) => value),
    ].filter((value) => value.length >= 4);
    this.events = this.#publisher.events;
    this.#client = dependencies.createClient({
      handlers: {
        elicitation: (request, signal) => this.#elicitation(request, signal),
        permission: (request, signal) => this.#permission(request, signal),
        readTextFile: acpReadTextFileHandler([
          context.workspacePath,
          ...context.writableRoots,
          ...(context.attachmentDirectory ? [context.attachmentDirectory] : []),
        ]),
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
    void process.exited.then((exit) => this.#processExited(exit));
  }

  static async open(
    options: AcpHarnessOptions,
    dependencies: Required<AcpHarnessDependencies>,
    context: HarnessSessionContext,
    mode: OpenMode,
    onClose: (session: AcpHarnessSession) => void,
  ): Promise<AcpHarnessSession> {
    context.signal.throwIfAborted();
    const rawLaunch = await options.launch({ accessMode: context.accessMode, context });
    const launch = context.wrapProcessLaunch(rawLaunch);
    const process = dependencies.spawn({
      ...launch,
      maxOutputBytes: 512 * 1_024,
      signal: context.signal,
    });
    const session = new AcpHarnessSession(options, dependencies, context, process, onClose);
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
      terminal: false,
      stderrStart: this.#stderrPosition(),
      tools: new Map(),
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
      const blocks = await this.#promptBlocks(run);
      this.#publish(runStartedEvent());
      active.stderrStart = this.#stderrPosition();
      // A Run abort is translated through the engine's cancel policy. In
      // particular, resume-based ACP engines keep this RPC alive until their
      // post-cancel prompt outcome arrives.
      const result = await this.#client.prompt(
        this.providerSessionReference,
        blocks,
        this.#lifetime.signal,
      );
      if (result.usage) active.usage = result.usage;
      const heldDecision = await this.#settleHeldAssistant(active);
      if (active.terminal) return;
      if (heldDecision.status === "failed") {
        if (heldDecision.discardAssistant) active.heldAssistant.length = 0;
        else this.#flushHeldAssistant(active);
        this.#fail(active, heldDecision.error);
        await active.completion.promise;
        return;
      }
      this.#flushHeldAssistant(active);
      await this.#stopBackgroundChildren(active);
      this.#flushTurn(active);
      this.#finish(active, active.interruptRequested ? "interrupted" : "completed");
      await active.completion.promise;
    } catch (error) {
      if (!active.terminal) {
        const heldDecision = await this.#settleHeldAssistant(active);
        if (active.terminal) return;
        if (heldDecision.status === "failed") {
          if (heldDecision.discardAssistant) active.heldAssistant.length = 0;
          else this.#flushHeldAssistant(active);
          this.#fail(active, heldDecision.error);
        } else {
          this.#flushHeldAssistant(active);
          if (active.interruptRequested || run.signal.aborted || this.#closed) {
            this.#finish(active, "interrupted");
          } else {
            const interpretation = this.#options.hooks.classifyError(error, {
              operation: "prompt",
              providerSessionReference: this.providerSessionReference,
              stderrTail: this.#stderrSince(active.stderrStart),
            });
            this.#fail(active, interpretation);
          }
        }
      }
    } finally {
      run.signal.removeEventListener("abort", abort);
      if (this.#active === active) this.#active = undefined;
    }
  }

  async interrupt(): Promise<void> {
    const active = this.#active;
    if (!active || active.terminal) return;
    active.interruptRequested = true;
    await this.#interruptActive(active);
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

  async #promptBlocks(run: HarnessRunInput): Promise<readonly AcpPromptBlock[]> {
    const stableContext = [
      this.#context.platformGuide,
      this.#context.instructions,
      durableHistoryWindowNotice(this.#context),
      await renderHarnessSkillCatalog(this.#context.skills),
      initialContinuationContextPrompt(this.#context),
      `## This Run's computers\n${this.#context.machineAccessNotice}`,
      harnessTurnPreamble(run, (input) =>
        resolvedInputSequence(input, run.attachments)
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ),
    ].filter((value): value is string => Boolean(value));
    const blocks: AcpPromptBlock[] = [{ type: "text", text: stableContext.join("\n\n") }];
    for (const input of run.inputs) {
      for (const part of resolvedInputSequence(input, run.attachments)) {
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

  #handleUpdate(sessionId: string, update: unknown): void {
    if (this.#replaying) return;
    if (this.#providerSessionReference && sessionId !== this.#providerSessionReference) return;
    const active = this.#active;
    if (!active || active.terminal) return;
    const normalized = this.#options.hooks.normalizeUpdate?.(update) ?? normalizeAcpUpdate(update);
    for (const entry of normalized) this.#applyUpdate(active, entry);
  }

  #applyUpdate(active: ActiveTurn, update: AcpNormalizedUpdate): void {
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
        this.#applyTool(active, update.toolCall);
        return;
      case "subagent": {
        if (update.state === "started") {
          active.nodes.open(update.key, {
            nativeRef: update.key,
            ...(update.model ? { model: update.model } : {}),
            ...(update.prompt ? { prompt: update.prompt } : {}),
            ...(update.sessionReference ? { sessionRef: update.sessionReference } : {}),
            ...(update.title ? { title: update.title } : {}),
          });
        } else {
          active.nodes.complete(
            update.key,
            update.state === "failed" ? "failed" : "completed",
            update.result ? { result: update.result } : {},
          );
        }
        return;
      }
      case "usage":
        active.usage = update;
        return;
      case "ignore":
        return;
    }
  }

  #applyTool(active: ActiveTurn, call: AcpToolCall): void {
    const earlier = active.tools.get(call.id);
    const merged = { ...earlier, ...call };
    active.tools.set(call.id, merged);
    const terminal = ["completed", "failed", "cancelled"].includes(merged.status ?? "");
    if (!earlier) {
      this.#publish({
        data: {
          arguments: merged.rawInput,
          callId: merged.id,
          tool: { name: merged.name ?? merged.title ?? "tool", namespace: "acp" },
        },
        type: "tool.started",
      });
    }
    if (terminal) {
      this.#publish({
        data: {
          callId: merged.id,
          isError: merged.status === "failed",
          output: normalizeToolOutput(merged.rawOutput ?? merged.content),
        },
        type: "tool.completed",
      });
      active.tools.delete(call.id);
    }
  }

  #flushTurn(active: ActiveTurn): void {
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

  #heldAssistantDecision(active: ActiveTurn): AcpHeldAssistantDecision {
    const hold = this.#options.hooks.holdAssistant;
    if (!hold) return { status: "succeeded" };
    return hold.settle({
      assistantText: this.#sanitizeStderr(
        active.heldAssistant.map((update) => update.text).join(""),
      ).trim(),
      providerSessionReference: this.providerSessionReference,
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
  }

  async #permission(request: AcpPermissionRequest, signal: AbortSignal): Promise<string | null> {
    const active = this.#active;
    if (!active || active.terminal || active.interruptRequested) return null;
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
        request: pendingRequest(requestId, active, this.#context, request.toolCall.id, {
          detail: permissionDetail(request.toolCall),
          kind: "choice",
          options: choices.map(requestChoice),
          risk: "medium",
          title: request.toolCall.title ?? request.toolCall.name ?? "Approve action",
        }),
      },
      type: "request.opened",
    });
    return this.#awaitInteraction(requestId, settlement, signal, (value) =>
      typeof value === "string" ? value : null,
    );
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
    active.nodes.endAll(status === "completed" ? "completed" : "interrupted");
    this.#cancelPending("run-ended");
    this.#publishUsage(active);
    this.#publish(runEndedEvent(status));
    active.completion.resolve();
  }

  #fail(active: ActiveTurn, error: OpensteerError): void {
    if (!this.#publisher.claimTerminal(active)) return;
    active.nodes.endAll("failed");
    this.#cancelPending("run-ended");
    this.#publishUsage(active);
    this.#publish(runFailedEvent(acpFailure(error)));
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
    if (active && !active.terminal) this.#fail(active, error);
    this.#cancelPending("process-lost");
    this.#publisher.closeStream(error);
  }

  #appendStderr(chunk: Buffer | string): void {
    this.#stderr += chunk.toString();
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
    return this.#sanitizeStderr(this.#stderr);
  }

  #stderrPosition(): number {
    return this.#stderrDropped + this.#stderr.length;
  }

  #stderrSince(position: number): string {
    return this.#sanitizeStderr(this.#stderr.slice(Math.max(0, position - this.#stderrDropped)));
  }

  #sanitizeStderr(value: string): string {
    let sanitized = value;
    for (const secret of this.#stderrSecrets)
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    return sanitized
      .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, "[REDACTED]")
      .replace(
        /\b(api[ _-]?key|authorization|credential|password|secret|token)\s*[:=]\s*[^,\s]+/giu,
        "$1=[REDACTED]",
      );
  }

  #classifyError(error: unknown, context: AcpErrorContext): OpensteerError {
    return this.#options.hooks.classifyError(error, context);
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
      await this.#client.closeSession(this.#providerSessionReference).catch(() => undefined);
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

const credentialNamePattern =
  /(?:API_KEY|ACCESS_KEY|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)/iu;

export function normalizeAcpUpdate(update: unknown): readonly AcpNormalizedUpdate[] {
  if (!isRecord(update) || typeof update.sessionUpdate !== "string") return [];
  const content = isRecord(update.content) ? update.content : undefined;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return content?.type === "text" && typeof content.text === "string"
        ? [{ kind: "assistant", text: content.text }]
        : [];
    case "agent_thought_chunk":
      return content?.type === "text" && typeof content.text === "string"
        ? [{ kind: "thought", text: content.text }]
        : [];
    case "tool_call":
    case "tool_call_update":
      return [{ kind: "tool", toolCall: acpToolCall(update) }];
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

function acpToolCall(update: Record<string, unknown>): AcpToolCall {
  return {
    id: typeof update.toolCallId === "string" ? update.toolCallId : "unknown-tool-call",
    ...(Array.isArray(update.content) ? { content: update.content } : {}),
    ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
    ...(typeof update.name === "string" ? { name: update.name } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
    ...(typeof update.status === "string" ? { status: update.status } : {}),
    ...(typeof update.title === "string" ? { title: update.title } : {}),
  };
}

function mcpServers(context: HarnessSessionContext): readonly AcpMcpServer[] {
  return [
    {
      headers: [{ name: "Authorization", value: `Bearer ${context.agentTools.token}` }],
      name: "opensteer",
      type: "http",
      url: context.agentTools.url,
    },
    {
      headers: [{ name: "Authorization", value: `Bearer ${context.integrationTools.token}` }],
      name: "opensteer_integrations",
      type: "http",
      url: context.integrationTools.url,
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
    originatingWorkspaceId: context.workspaceId,
    payload: { kind: presentation.kind === "form" ? "harness.input" : "harness.approval" },
    presentation,
    requestedBy: active.requestedBy,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: context.workspaceId,
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

function invalidRequestResponse(): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: "Response does not match the pending ACP Request",
  });
}
