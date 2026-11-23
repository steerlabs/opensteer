import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  OpensteerError,
  ToolBlockedError,
  agentOperationHoldMs,
  refused,
  requestOperationCallsMaxLength,
  threadAccessModeAtMost,
  type AgentGrant,
  type AgentOperationDecision,
  type AgentOperationId,
  type AgentOperationTarget,
  type AgentSessionEndReason,
  type AgentSessionId,
  type RequestId,
  type RequestResponse,
  type RequestPresentation,
  type ThreadAccessMode,
  type ThreadId,
  type ToolFailureReceipt,
  type UserId,
} from "@opensteer/core";
import {
  admitAgentOperation,
  admitExecution,
  askForAgentOperation,
  beginAgentSession,
  decideAgentOperation,
  endAgentSessions,
  expireAgentOperationRequests,
  findAgentOperation,
  handOffAgentOperation,
  idleAgentSessions,
  readAgentOperation,
  refuseUnsentAgentOperation,
  refuseUnsentHandedOffAgentOperation,
  BrowserPoolAdmissionClosed,
  reopenAgentOperation,
  respondToAgentOperation,
  settleAgentOperation,
  settleOrphanedAgentOperations,
  type AgentOperationRow,
  type BrowserPoolTargetIdentity,
  type ExecutionAuthority,
  type OpensteerStore,
} from "@opensteer/database";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { DeadlineDrain } from "../runtime/deadline-drain.js";
import { ReplFailureSchema, type ReplFailure } from "../computer-use/computer-repl/messages.js";
import type { BrowserPoolReservation } from "../browser/browser-pool-gate.js";

/**
 * Decides an effect in `auto`: allow it, or ask the person. It sees the grant, the mode, the
 * trusted target, the exact script or calls, and the agent's reason marked as untrusted. It never
 * refuses on its own; doubt, an error, a timeout or a malformed answer means ask.
 */
export interface AgentReviewerPort {
  review(
    input: {
      readonly ownerUserId: UserId;
      readonly grant: AgentGrant;
      readonly mode: ThreadAccessMode;
      readonly tool: string;
      readonly target: AgentOperationTarget;
      readonly calls: string;
      readonly agentReason: { readonly untrusted: true; readonly text: string } | null;
    },
    signal: AbortSignal,
  ): Promise<"allow" | "ask">;
}
/** The reviewer this Home ships with until a model-backed one is configured. */
export const alwaysAskReviewer: AgentReviewerPort = { review: async () => "ask" };
export const reviewerTimeoutMs = 15_000;
/** How long one executor call may take before its signal aborts. */
const defaultExecutionMs = 120_000;

function directOperationAction(tool: string, target: string): string {
  switch (tool) {
    case "tab_open":
      return `open a tab in ${target}`;
    case "tab_close":
      return `close a tab in ${target}`;
    case "tab_list":
      return `list tabs in ${target}`;
    case "browser_use":
      return `run a script in ${target}`;
    case "browser_connect":
      return `take direct control of ${target}`;
    case "computer_use":
      return `use ${target}`;
    case "plugin_call":
      return `change ${target}`;
    case "plugin_execute":
      return `run a script using ${target}`;
    case "plugin_resume":
      return `continue work using ${target}`;
    case "ask_person":
      return "ask you a question";
    case "saved_login_request":
      return `use a saved login in ${target}`;
    case "card_request":
      return `use a saved card in ${target}`;
    default:
      return `act on ${target}`;
  }
}

function quoteIsolatedOutsideName(value: string): string {
  const safe = value
    .replace(/[\u201C\u201F\u301D\u301E]/gu, "\u2018")
    .replace(/[\u201D\u201E\u301F]/gu, "\u2019")
    .replace(/[\u0022\uFF02]/gu, "\u0027");
  return `“\u2068${safe}\u2069”`;
}

export function directOperationCopy(tool: string, target: AgentOperationTarget, agent: string) {
  const phone = target.grant.kind === "computer-app" && target.grant.app.kind === "phone-screen";
  const device = target.device?.name;
  const action =
    directOperationAction(tool, target.name) +
    (tool === "computer_use" && device && !phone ? ` on ${device}` : "");
  const quotedAgent = quoteIsolatedOutsideName(agent);
  const title =
    tool === "browser_connect" || tool === "computer_use" || tool === "plugin_call"
      ? `Let ${quotedAgent} ${action}?`
      : `${action[0]!.toUpperCase()}${action.slice(1)}?`;
  const context = device ? (phone ? device : `${target.name} · ${device}`) : null;
  const scope =
    tool === "browser_connect" && target.grant.kind === "browser-profile"
      ? " It can control its own pages and access every cookie and signed-in site in this profile."
      : "";
  const sentence = `${quotedAgent} wants to ${action}.${scope}`;
  return { title, summary: context ? `${context}\n${sentence}` : sentence };
}

/** What an executor gets: a signal tied to Stop, Disconnect, narrowing and its deadline. */
export interface DirectOperationContext {
  readonly sessionId: AgentSessionId;
  readonly taskId: ThreadId;
  readonly operationId: AgentOperationId;
  readonly requestId: RequestId | null;
  readonly grantRevision: number;
  readonly mode: ThreadAccessMode;
  /** The binding every downstream check resolves (`session:<id>`). */
  readonly bindingId: `session:${string}`;
  readonly ownerUserId: UserId;
  readonly signal: AbortSignal;
  readonly deadline: number;
  /**
   * Re-admits the session and the exact target under the authority this operation was handed
   * off with. Call it before every command, including on a cached binding; it throws a refusal
   * once the session ended, the grant changed or the target is no longer reached.
   */
  recheck(): Promise<void>;
  /** The pooled command queue calls this at the wire boundary. */
  readonly browserSend?: PooledBrowserSend;
}

export interface PooledBrowserSend {
  readonly target: BrowserPoolTargetIdentity;
  recheck(): Promise<void>;
  submitted(): void;
  acknowledged(): void;
}

export interface PooledDirectBrowser {
  reserve(signal: AbortSignal): Promise<BrowserPoolReservation>;
  identity(): BrowserPoolTargetIdentity;
  recheckTarget(): Promise<void>;
}

/** An executor's way to say it cannot tell whether its effect happened. */
export class OperationOutcomeUnknown extends Error {}

export class AgentOperationFailure extends Error {
  readonly receipt: ToolFailureReceipt;
  override readonly cause: unknown;

  constructor(cause: unknown, receipt: ToolFailureReceipt) {
    super(cause instanceof Error ? cause.message : "The operation failed.");
    this.cause = cause;
    this.receipt = receipt;
  }
}

export interface DirectOperation<Result> {
  readonly ownerUserId: UserId;
  readonly agentConnectionId: string;
  /** Omitted: continue the connection's session or start one. */
  readonly taskId?: ThreadId | undefined;
  /** A short purpose for a new session's task title. */
  readonly purpose?: string | undefined;
  readonly operationKey: string;
  readonly tool: string;
  /** The call's canonical arguments; their digest makes a repeat idempotent. */
  readonly input: unknown;
  /** The concrete target, or null for a read the tool itself filters by the grant. */
  readonly target: AgentOperationTarget | null;
  /** Shown for a null target, such as "Your tabs". */
  readonly targetName?: string;
  readonly targetGeneration?: string | null;
  readonly pooledBrowser?: PooledDirectBrowser;
  readonly effect: "read" | "write";
  /** The exact script or calls, shown in full to the person who reviews it. */
  readonly calls: string;
  /** The agent's own reason, kept apart and marked as its words. */
  readonly reason?: string | undefined;
  readonly timeoutMs?: number;
  readonly question?: (taskId: ThreadId) => Promise<Extract<RequestPresentation, { kind: "form" }>>;
  /** Passwords owns the sole approval Request and never fills during this operation. */
  readonly passwordsApproval?: true;
  readonly reportReplay?: true;
  readonly replay?: (
    row: AgentOperationRow,
    execution: ExecutionAuthority,
  ) => Promise<Result | undefined>;
  readonly execute: (context: DirectOperationContext) => Promise<Result>;
  /** A bounded, redacted record of the result, for the activity list. */
  readonly summarize?: (result: Result) => Readonly<Record<string, unknown>> | null;
  readonly scriptFailure?: (result: Result) => ReplFailure | undefined;
}

export type DirectOperationResult<Result> = { readonly replayed?: true } & (
  | {
      readonly status: "completed";
      readonly taskId: ThreadId;
      readonly operationId: AgentOperationId;
      /** Absent on a repeat of a finished call: the summary is all the Home keeps. */
      readonly result?: Result;
      readonly summary?: Readonly<Record<string, unknown>> | null;
    }
  | {
      readonly status: "pending";
      readonly taskId: ThreadId;
      readonly operationId: AgentOperationId;
      readonly requestId: RequestId | null;
      readonly next: string;
    }
  | {
      readonly status: "failed";
      readonly taskId: ThreadId;
      readonly operationId: AgentOperationId;
      readonly next: string;
      readonly scriptError?: ReplFailure;
      readonly result?: Result;
    }
  | {
      readonly status: "unknown";
      readonly taskId: ThreadId;
      readonly operationId: AgentOperationId;
      readonly next: string;
    }
);

export const pendingNext = `Call the same tool again with the same arguments and this operationId to wait up to ${agentOperationHoldMs / 1_000} seconds for the person. If it is still pending, call again, but not in a tight loop.`;
export const unknownNext =
  "The Home lost track of whether this took effect. Check the current state before doing anything else; never repeat it blindly.";
export const scriptFailedNext =
  "Earlier steps may have taken effect. Check the current state before trying again.";

export function storedScriptError(summary: AgentOperationRow["resultSummary"]) {
  return ReplFailureSchema.safeParse(summary?.scriptError).data;
}
const interruptedNext =
  "Part of it may have happened. Check the current state before doing anything else.";

export function operationArgumentDigest(tool: string, input: unknown): string {
  const args =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? Object.fromEntries(
          Object.entries(input).filter(
            ([key]) => !["taskId", "operationId", "operationKey"].includes(key),
          ),
        )
      : input;
  return createHash("sha256")
    .update(canonicalJson({ tool, input: args }))
    .digest("hex");
}

export class AgentSessionService {
  readonly #store: OpensteerStore;
  readonly #reviewer: AgentReviewerPort;
  readonly #closeBinding: (bindingId: string, reason: string) => void;
  readonly #onError: (error: unknown) => void;
  /** One controller per session with work in this process; aborted when the session ends. */
  readonly #sessions = new Map<
    AgentSessionId,
    { readonly controller: AbortController; readonly connectionId: string; work: number }
  >();
  /** Operations executing or waiting on pooled admission, joined by concurrent resumes. */
  readonly #running = new Map<
    AgentOperationId,
    {
      readonly controller: AbortController;
      readonly result: Promise<DirectOperationResult<unknown>>;
      readonly taskId: ThreadId;
      readonly mode: ThreadAccessMode;
      readonly pooled?: { readonly sessionId: AgentSessionId; readonly connectionId: string };
    }
  >();
  readonly #decisions = new EventEmitter();
  readonly #holdMs: number;
  readonly #reviewTimeoutMs: number;
  readonly #sweeper: DeadlineDrain;
  #sweeping = false;

  constructor(options: {
    readonly store: OpensteerStore;
    readonly reviewer?: AgentReviewerPort;
    /** Closes what holds a binding open elsewhere, such as a standard CDP attachment. */
    readonly closeBinding?: (bindingId: string, reason: string) => void;
    readonly onError?: (error: unknown) => void;
    /** How long a call waits for the person's decision before it returns pending. */
    readonly holdMs?: number;
    readonly reviewTimeoutMs?: number;
  }) {
    this.#store = options.store;
    this.#holdMs = options.holdMs ?? agentOperationHoldMs;
    this.#reviewTimeoutMs = options.reviewTimeoutMs ?? reviewerTimeoutMs;
    this.#reviewer = options.reviewer ?? alwaysAskReviewer;
    this.#closeBinding = options.closeBinding ?? (() => {});
    this.#onError = options.onError ?? (() => {});
    this.#decisions.setMaxListeners(0);
    this.#sweeper = new DeadlineDrain({
      onError: this.#onError,
      drain: async () => {
        await this.endIdle();
        const active = await this.#store.database
          .selectFrom("agentSessions")
          .select("id")
          .where("status", "=", "active")
          .limit(1)
          .executeTakeFirst();
        return active ? new Date(Date.now() + 60_000) : null;
      },
    });
  }

  /**
   * At Host startup: nothing handed off before this process can still report, so those
   * operations are `unknown`. Then sessions that went quiet are ended on a timer.
   */
  async start(): Promise<void> {
    await settleOrphanedAgentOperations(this.#store.database, new Set(this.#running.keys()));
    this.#sweeping = true;
    this.#sweeper.start();
  }
  /** Settles once every operation handed off in this process has recorded its outcome. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#running.values()].map(({ result }) => result));
    await this.#sweeper.settled();
  }
  stop(): void {
    void this.#sweeper.close();
    for (const attempt of this.#running.values())
      if (attempt.pooled)
        attempt.controller.abort(
          new OpensteerError({ code: "conflict", message: "The Home stopped." }),
        );
    for (const [id, entry] of this.#sessions) {
      entry.controller.abort(
        new OpensteerError({ code: "conflict", message: "The Home stopped." }),
      );
      this.#sessions.delete(id);
    }
  }

  /** The one entry point every direct tool calls. */
  async run<Result>(operation: DirectOperation<Result>): Promise<DirectOperationResult<Result>> {
    if (!operation.question && operation.calls.length > requestOperationCallsMaxLength)
      throw refused(
        "bad_request",
        `Use at most ${requestOperationCallsMaxLength.toLocaleString("en-US")} characters per connected operation.`,
      );
    if (!operation.target && operation.effect !== "read")
      throw new Error("An effect needs a concrete target");
    const argumentDigest = operationArgumentDigest(operation.tool, operation.input);
    const existing = await findAgentOperation(this.#store.database, {
      userId: operation.ownerUserId,
      agentConnectionId: operation.agentConnectionId,
      identity: { key: operation.operationKey },
    });
    if (existing) {
      assertOperationArguments(existing, argumentDigest, operation.taskId);
      if (
        existing.state === "completed" &&
        (!operation.replay || existing.sessionStatus === "ended")
      )
        return {
          status: "completed",
          taskId: existing.taskId,
          operationId: existing.id,
          summary: existing.resultSummary,
          ...(operation.reportReplay ? { replayed: true } : {}),
        };
      return withAgentOperationReceipt(
        this.#store.database,
        existing,
        existing.taskId,
        async () => {
          const execution = await this.#admit(operation, `session:${existing.sessionId}`);
          const result = await this.#advance(operation, existing, existing.taskId, execution);
          return operation.reportReplay ? { ...result, replayed: true as const } : result;
        },
      );
    }
    const { session, created } = await beginAgentSession(this.#store.database, {
      userId: operation.ownerUserId,
      agentConnectionId: operation.agentConnectionId,
      taskId: operation.taskId,
      purpose: operation.purpose,
      grantTarget: operation.target?.grant,
    });
    if (created && this.#sweeping) this.#sweeper.wake();
    const bindingId = `session:${session.id}` as const;
    const execution = await this.#admit(operation, bindingId);
    const target: AgentOperationTarget = operation.target ?? {
      grant: { kind: "device" },
      name: operation.targetName ?? "this resource",
      device: null,
    };
    const { operation: row, replay } = await admitAgentOperation(this.#store.database, {
      userId: operation.ownerUserId,
      agentConnectionId: operation.agentConnectionId,
      sessionId: session.id,
      operationKey: operation.operationKey,
      tool: operation.tool,
      argumentDigest,
      target,
      grantTarget: operation.target?.grant,
      targetGeneration: operation.targetGeneration ?? null,
      grantRevision: execution.agentConnection!.grantRevision,
      mode: execution.mode,
      effect: operation.effect,
      calls: operation.calls,
      agentReason: operation.reason?.slice(0, 2_000) ?? null,
    });
    // Another call can admit the same read between the first lookup and the insert.
    if (operation.reportReplay && replay) return this.run(operation);
    return withAgentOperationReceipt(this.#store.database, row, session.threadId, () =>
      this.#advance(operation, row, session.threadId, execution),
    );
  }

  requestClosed(requestId: RequestId): void {
    this.#decisions.emit(requestId);
  }

  /** The person answered an operation's Request; waiters wake after the commit. */
  async respond(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<void> {
    const { operation, expired } = await respondToAgentOperation(this.#store.database, input);
    this.#decisions.emit(operation.id);
    if (expired) throw agentOperationRefusal(operation.decision);
  }

  /** The person's Stop on a session's task, bound to the session they saw. */
  async stopSession(input: {
    readonly ownerUserId: UserId;
    readonly threadId: ThreadId;
    readonly sessionId: AgentSessionId;
  }): Promise<{ readonly ended: boolean }> {
    const ended = await endAgentSessions(this.#store.database, {
      userId: input.ownerUserId,
      threadId: input.threadId,
      sessionIds: [input.sessionId],
      reason: "stopped",
    });
    this.#ended(ended, "stopped");
    return { ended: ended.length > 0 };
  }

  /**
   * The Disconnect worker's stop for one handed-off operation: abort the signal its executor
   * holds. Its row settles, with terminal evidence, when the executor returns.
   */
  async stopDirectOperation(operationId: AgentOperationId): Promise<void> {
    this.#running.get(operationId)?.controller.abort(
      new OpensteerError({
        code: "forbidden",
        reason: "authority-changed",
        message: "The connected agent's access to this work ended.",
      }),
    );
  }

  async lowerTaskMode(taskId: ThreadId, mode: ThreadAccessMode): Promise<void> {
    for (const [id, attempt] of this.#running)
      if (attempt.taskId === taskId && !threadAccessModeAtMost(attempt.mode, mode))
        await this.stopDirectOperation(id);
  }

  /** After a connection change committed: abort work of sessions that ended, or all of them. */
  async closeConnection(connectionId: string, all: boolean): Promise<void> {
    for (const [id, attempt] of this.#running)
      if (attempt.pooled?.connectionId === connectionId) await this.stopDirectOperation(id);
    const live = [...this.#sessions].filter(([, entry]) => entry.connectionId === connectionId);
    if (!live.length) return;
    const ended = all
      ? live.map(([id]) => id)
      : (
          await this.#store.database
            .selectFrom("agentSessions")
            .select("id")
            .where(
              "id",
              "in",
              live.map(([id]) => id),
            )
            .where("status", "=", "ended")
            .execute()
        ).map(({ id }) => id);
    for (const id of ended) this.#abort(id, "revoked");
  }

  async endIdle(now = Date.now()): Promise<void> {
    const idleAt = new Date(now);
    for (const operation of await expireAgentOperationRequests(this.#store.database, idleAt))
      this.#decisions.emit(operation.id);
    for (const session of await idleAgentSessions(this.#store.database, idleAt)) {
      const ended = await endAgentSessions(this.#store.database, {
        userId: session.userId,
        sessionIds: [session.id],
        reason: "idle",
        idleAt,
      });
      this.#ended(ended, "idle");
    }
  }

  #ended(sessions: readonly { readonly id: AgentSessionId }[], reason: AgentSessionEndReason) {
    for (const session of sessions) this.#abort(session.id, reason);
  }
  #abort(sessionId: AgentSessionId, reason: AgentSessionEndReason | "revoked") {
    const message =
      reason === "stopped"
        ? "The person stopped this work."
        : "The connected agent's access to this work ended.";
    const error = new OpensteerError({
      code: "forbidden",
      reason: reason === "stopped" ? "agent-session-stopped" : "authority-changed",
      message,
    });
    this.#closeBinding(`session:${sessionId}`, message);
    for (const attempt of this.#running.values())
      if (attempt.pooled?.sessionId === sessionId) attempt.controller.abort(error);
    const entry = this.#sessions.get(sessionId);
    if (!entry) return;
    this.#sessions.delete(sessionId);
    entry.controller.abort(error);
  }

  async #admit(
    operation: Pick<DirectOperation<unknown>, "ownerUserId" | "target" | "effect">,
    bindingId: string,
  ): Promise<ExecutionAuthority> {
    return admitExecution(this.#store.database, {
      ownerUserId: operation.ownerUserId,
      subject: { kind: "binding", bindingId },
      grantTarget: operation.target?.grant,
      writeTargetName: operation.effect === "write" ? operation.target?.name : undefined,
    });
  }

  async #advance<Result>(
    operation: DirectOperation<Result>,
    initial: AgentOperationRow,
    taskId: ThreadId,
    execution: ExecutionAuthority,
  ): Promise<DirectOperationResult<Result>> {
    let row = initial;
    const base = { taskId, operationId: row.id };
    for (;;) {
      switch (row.state) {
        case "completed": {
          const result = await operation.replay?.(row, execution);
          return {
            status: "completed",
            ...base,
            summary: row.resultSummary,
            ...(result === undefined ? {} : { result }),
          };
        }
        case "failed": {
          const scriptError = storedScriptError(row.resultSummary);
          return scriptError
            ? { status: "failed", ...base, scriptError, next: scriptFailedNext }
            : { status: "failed", ...base, next: "It failed. Check the current state." };
        }
        case "unknown":
          return { status: "unknown", ...base, next: unknownNext };
        case "refused":
          throw new AgentOperationFailure(agentOperationRefusal(row.decision), {
            ...base,
            status: "refused",
          });
        case "handed-off": {
          const running = this.#running.get(row.id);
          if (running)
            return this.#awaitExecution(
              operation,
              row,
              taskId,
              running.result as Promise<DirectOperationResult<Result>>,
            );
          return { status: "unknown", ...base, next: unknownNext };
        }
        case "admitted":
          row = await this.#decide(operation, row, taskId, execution);
          break;
        case "pending": {
          const decided = await this.#wait(row);
          if (decided.state === "pending")
            return { status: "pending", ...base, requestId: decided.requestId, next: pendingNext };
          row = decided;
          break;
        }
        case "approved":
          return this.#handOff(operation, row, taskId);
      }
    }
  }

  async #decide<Result>(
    operation: DirectOperation<Result>,
    row: AgentOperationRow,
    taskId: ThreadId,
    execution: ExecutionAuthority,
  ): Promise<AgentOperationRow> {
    const decide = (decision: AgentOperationDecision) =>
      decideAgentOperation(this.#store.database, row, decision);
    if (!operation.question) {
      if (row.effect === "read") return decide({ by: "structural-read" });
      if (row.mode === "full-access") return decide({ by: "full-access" });
      if (row.mode === "auto" && (await this.#review(row, execution)) === "allow")
        return decide({ by: "reviewer" });
    }
    return askForAgentOperation(this.#store.database, this.#store.requests, {
      operation: row,
      threadId: taskId,
      grantTarget: operation.target?.grant,
      ...(operation.question ? { presentation: await operation.question(taskId) } : {}),
      copy: (agent) => directOperationCopy(row.tool, row.target, agent),
    });
  }

  async #review(row: AgentOperationRow, execution: ExecutionAuthority): Promise<"allow" | "ask"> {
    const signal = AbortSignal.timeout(this.#reviewTimeoutMs);
    try {
      const answer = await withTimeout(
        this.#reviewer.review(
          {
            ownerUserId: execution.ownerUserId,
            grant: execution.agentConnection!.grant,
            mode: row.mode,
            tool: row.tool,
            target: row.target,
            calls: row.calls,
            agentReason: row.agentReason ? { untrusted: true, text: row.agentReason } : null,
          },
          signal,
        ),
        this.#reviewTimeoutMs,
        { signal, timeoutError: () => new Error("Agent review timed out") },
      );
      return answer === "allow" && !signal.aborted ? "allow" : "ask";
    } catch {
      return "ask";
    }
  }

  /** Waits up to the hold for the person's decision, woken by `respond` after its commit. */
  async #wait({ id, requestId }: AgentOperationRow): Promise<AgentOperationRow> {
    let done!: () => void;
    const decided = new Promise<void>((resolve) => {
      done = () => {
        clearTimeout(timer);
        this.#decisions.removeListener(id, done);
        if (requestId) this.#decisions.removeListener(requestId, done);
        resolve();
      };
      const timer = setTimeout(done, this.#holdMs);
      timer.unref?.();
      // Listening before the read below, so an answer that commits in between still wakes it.
      this.#decisions.once(id, done);
      if (requestId) this.#decisions.once(requestId, done);
    });
    const current = await readAgentOperation(this.#store.database, id);
    if (
      current.state !== "pending" ||
      (requestId && (await this.#store.requests.get(requestId))?.status !== "pending")
    )
      done();
    await decided;
    const latest = await readAgentOperation(this.#store.database, id);
    if (
      latest.state === "pending" &&
      requestId &&
      (await this.#store.requests.get(requestId))?.status !== "pending"
    )
      throw refused("forbidden", "The Request is no longer pending.");
    return latest;
  }

  async #handOff<Result>(
    operation: DirectOperation<Result>,
    row: AgentOperationRow,
    taskId: ThreadId,
  ): Promise<DirectOperationResult<Result>> {
    const bindingId = `session:${row.sessionId}` as const;
    // A changed revision, mode or target is new authority: it needs a fresh decision.
    const execution = await this.#admit(operation, bindingId);
    const target = operation.target ?? row.target;
    const targetGeneration = operation.targetGeneration ?? null;
    if (
      execution.agentConnection!.grantRevision !== row.grantRevision ||
      execution.mode !== row.mode ||
      targetGeneration !== row.targetGeneration ||
      canonicalJson(target.grant) !== canonicalJson(row.target.grant)
    ) {
      const reopened = await reopenAgentOperation(this.#store.database, row, {
        grantRevision: execution.agentConnection!.grantRevision,
        mode: execution.mode,
        target,
        targetGeneration,
      });
      return this.#advance(
        operation,
        reopened ?? (await readAgentOperation(this.#store.database, row.id)),
        taskId,
        execution,
      );
    }
    if (operation.pooledBrowser) {
      const pending = this.#running.get(row.id);
      if (pending) return pending.result as Promise<DirectOperationResult<Result>>;
      const controller = new AbortController();
      const result = withAgentOperationReceipt(this.#store.database, row, taskId, () =>
        this.#handOffPooled(operation, operation.pooledBrowser!, row, taskId, controller.signal),
      );
      this.#running.set(row.id, {
        controller,
        result,
        taskId,
        mode: row.mode,
        pooled: { sessionId: row.sessionId, connectionId: row.connectionId },
      });
      const forget = () => this.#running.delete(row.id);
      void result.then(forget, forget);
      return result;
    }
    const handed = await handOffAgentOperation(this.#store.database, {
      userId: operation.ownerUserId,
      agentConnectionId: operation.agentConnectionId,
      reviewed: row,
      grantTarget: operation.target?.grant,
    });
    if (!handed)
      return this.#advance(
        operation,
        await readAgentOperation(this.#store.database, row.id),
        taskId,
        execution,
      );
    const controller = new AbortController();
    const running = withAgentOperationReceipt(this.#store.database, handed, taskId, () =>
      this.#execute(operation, handed, taskId, bindingId, controller.signal),
    );
    this.#running.set(handed.id, { controller, result: running, taskId, mode: handed.mode });
    const forget = () => this.#running.delete(handed.id);
    void running.then(forget, forget);
    return this.#awaitExecution(operation, handed, taskId, running);
  }

  async #handOffPooled<Result>(
    operation: DirectOperation<Result>,
    pool: PooledDirectBrowser,
    row: AgentOperationRow,
    taskId: ThreadId,
    stop: AbortSignal,
  ): Promise<DirectOperationResult<Result>> {
    const bindingId = `session:${row.sessionId}` as const;
    const deadline = Date.now() + (operation.timeoutMs ?? defaultExecutionMs);
    const signal = AbortSignal.any([stop, AbortSignal.timeout(Math.max(0, deadline - Date.now()))]);
    let reservation: BrowserPoolReservation | undefined;
    let handed: AgentOperationRow | null = null;
    try {
      // A caller the target check would refuse never wakes a parked browser: the same check runs
      // first, before the reserve, and again after it, where it stays the authority.
      await pool.recheckTarget();
      signal.throwIfAborted();
      reservation = await pool.reserve(signal);
      // Between here and the execution's own settler (registered once its send counters exist),
      // a restart that can wait no longer records this holder too: refused while nothing is
      // handed off, and refused as unsent once it is, since no command can have left before the
      // execution began. Both writes apply only to the row in the state they name.
      // The hand-off may commit while this runs (its write waits on the row, then lands before
      // the refusal's): the row is read again after each write until it has an outcome.
      // Each write is the one the row's current state and revision name (the operation may have
      // been reviewed again meanwhile); after the third, the row is read once more.
      reservation.onForcedEnd?.(async () => {
        const unsettled = (state: string | undefined) =>
          state === "handed-off" ||
          state === "admitted" ||
          state === "pending" ||
          state === "approved";
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await readAgentOperation(this.#store.database, row.id);
          if (!current || !unsettled(current.state)) return;
          if (current.state === "handed-off") {
            // Written: the row has its outcome, with nothing more to read.
            if (
              await refuseUnsentHandedOffAgentOperation(
                this.#store.database,
                row.id,
                "This browser restarted before anything was sent.",
                "changed",
              )
            )
              return;
          } else
            await refuseUnsentAgentOperation(this.#store.database, row.id, current.grantRevision);
        }
        const last = await readAgentOperation(this.#store.database, row.id);
        if (!last || !unsettled(last.state)) return;
        // Still without an outcome: the restart does not go on to Stop. Its hold ends when the
        // holder's own work ends (its operation's deadline), when a later turn's settlement
        // writes, or at a removal.
        throw new Error("The pooled operation's outcome could not be recorded.");
      });
      // A restart or a removal asks every holder to stop: the work ends and records its outcome.
      const held = reservation.ended
        ? AbortSignal.any([
            signal,
            abortedWith(
              reservation.ended,
              () => new BrowserPoolAdmissionClosed("This browser is restarting or was removed."),
            ),
          ])
        : signal;
      const identity = pool.identity();
      await pool.recheckTarget();
      held.throwIfAborted();
      handed = await handOffAgentOperation(this.#store.database, {
        userId: operation.ownerUserId,
        agentConnectionId: operation.agentConnectionId,
        reviewed: row,
        grantTarget: operation.target?.grant,
        pool: { target: identity, signal: held },
      });
      if (!handed) throw refused("forbidden", "The connected agent's access changed or ended.");
      return await this.#execute(operation, handed, taskId, bindingId, held, {
        deadline,
        identity,
        pool,
        reservation,
      });
    } catch (error) {
      // Nothing was handed off, so nothing reached the browser: a definite refusal, under the
      // revision the row holds now (it may have been reviewed again while this waited).
      if (!handed) {
        const current = await readAgentOperation(this.#store.database, row.id).catch(
          () => undefined,
        );
        await refuseUnsentAgentOperation(
          this.#store.database,
          row.id,
          current?.grantRevision ?? row.grantRevision,
        );
      }
      throw error;
    } finally {
      reservation?.release();
    }
  }

  async #awaitExecution<Result>(
    operation: DirectOperation<Result>,
    row: AgentOperationRow,
    taskId: ThreadId,
    running: Promise<DirectOperationResult<Result>>,
  ): Promise<DirectOperationResult<Result>> {
    if (!operation.passwordsApproval) return running;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        running,
        new Promise<DirectOperationResult<Result>>((resolve, reject) => {
          timer = setTimeout(() => {
            void readAgentOperation(this.#store.database, row.id).then(
              (current) =>
                resolve({
                  status: "pending",
                  taskId,
                  operationId: row.id,
                  requestId: current.requestId,
                  next: pendingNext,
                }),
              reject,
            );
          }, this.#holdMs);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #execute<Result>(
    operation: DirectOperation<Result>,
    row: AgentOperationRow,
    taskId: ThreadId,
    bindingId: `session:${string}`,
    stop: AbortSignal,
    pooled?: {
      deadline: number;
      identity: BrowserPoolTargetIdentity;
      pool: PooledDirectBrowser;
      reservation?: BrowserPoolReservation;
    },
  ): Promise<DirectOperationResult<Result>> {
    const entry = this.#sessions.get(row.sessionId) ?? {
      controller: new AbortController(),
      connectionId: row.connectionId,
      work: 0,
    };
    this.#sessions.set(row.sessionId, entry);
    entry.work++;
    const deadline = pooled?.deadline ?? Date.now() + (operation.timeoutMs ?? defaultExecutionMs);
    const signal = AbortSignal.any([
      entry.controller.signal,
      stop,
      ...(!pooled ? [AbortSignal.timeout(deadline - Date.now())] : []),
    ]);
    const base = { taskId, operationId: row.id };
    let outstanding = 0;
    let submitted = 0;
    // A restart that can wait no longer records this operation's outcome itself, as a lost
    // channel does: unknown when a command left, refused when none did. Both writes apply only
    // to a row still handed off, so the work's own later outcome cannot overwrite it.
    pooled?.reservation?.onForcedEnd?.(async () => {
      if (submitted === 0)
        await refuseUnsentHandedOffAgentOperation(
          this.#store.database,
          row.id,
          "This browser restarted before anything was sent.",
          "changed",
        );
      else await settleAgentOperation(this.#store.database, row.id, "unknown", null);
    });
    const recheck = async () => {
      signal.throwIfAborted();
      const live = await this.#admit(operation, bindingId).catch((error: unknown) => {
        if (error instanceof OpensteerError) throw new OperationOutcomeUnknown(error.message);
        throw error;
      });
      if (live.agentConnection!.grantRevision !== row.grantRevision || live.mode !== row.mode)
        throw new OperationOutcomeUnknown("The connected agent's access changed during this work.");
      signal.throwIfAborted();
    };
    try {
      let result: Result;
      try {
        if (pooled) signal.throwIfAborted();
        result = await operation.execute({
          sessionId: row.sessionId,
          taskId,
          operationId: row.id,
          requestId: row.requestId,
          grantRevision: row.grantRevision,
          mode: row.mode,
          bindingId,
          ownerUserId: operation.ownerUserId,
          signal,
          deadline,
          recheck,
          ...(pooled
            ? {
                browserSend: {
                  target: pooled.identity,
                  recheck: async () => {
                    await recheck();
                    await pooled.pool.recheckTarget();
                    // Replaced before anything was sent, the runtime is a closed admission.
                    if (canonicalJson(pooled.pool.identity()) !== canonicalJson(pooled.identity))
                      throw submitted === 0
                        ? new BrowserPoolAdmissionClosed(
                            "The browser runtime changed before anything was sent.",
                          )
                        : new OperationOutcomeUnknown(
                            "The browser runtime changed during this work.",
                          );
                    signal.throwIfAborted();
                  },
                  submitted: () => {
                    outstanding++;
                    submitted++;
                  },
                  acknowledged: () => {
                    outstanding--;
                  },
                },
              }
            : {}),
        });
      } catch (error) {
        const ended =
          signal.aborted && signal.reason instanceof OpensteerError ? signal.reason : null;
        // A pooled send that admission or authority refused before any command reached the
        // wire (a cut, a recheck, a closed gate, a page or a runtime that changed): nothing left
        // the Home, so it is refused with its own reason. Any other error is the work's own.
        const refusal =
          pooled && submitted === 0 && (ended || !signal.aborted)
            ? unsentRefusal(error, ended)
            : undefined;
        if (
          refusal &&
          (await refuseUnsentHandedOffAgentOperation(
            this.#store.database,
            row.id,
            refusal.message,
            refusal.reason,
          ))
        )
          throw new ToolBlockedError(
            {
              code: refusal.code,
              message: refusal.message,
              next:
                refusal.code === "stopped_by_person"
                  ? "Nothing was sent. Stop this task and ask the person before starting again."
                  : "Nothing was sent. Check the current state before trying again.",
            },
            { ...base, status: "refused" },
          );
        const outcome =
          error instanceof OperationOutcomeUnknown || signal.aborted || outstanding > 0
            ? "unknown"
            : "failed";
        const settled = await settleAgentOperation(this.#store.database, row.id, outcome, null);
        // Work that the person, a Disconnect or a narrowed grant ended: the agent hears why. What
        // it had already done is uncertain; the record says so and the next step repeats it.
        if (ended)
          throw new ToolBlockedError(
            {
              code: unsentRefusal(null, ended)?.code ?? "access_denied",
              message: ended.message,
              next: interruptedNext,
            },
            { ...base, status: "unknown" },
          );
        if (!settled || outcome === "unknown")
          return { status: "unknown", ...base, next: unknownNext };
        throw new AgentOperationFailure(error, { ...base, status: "failed" });
      }
      let summary: Readonly<Record<string, unknown>> | null = null;
      try {
        summary = operation.summarize?.(result) ?? null;
      } catch (error) {
        this.#onError(error);
      }
      const scriptError = operation.scriptFailure?.(result);
      if (outstanding > 0) {
        // A command was submitted and never answered: its effect is unknown.
        await settleAgentOperation(this.#store.database, row.id, "unknown", null);
        return { status: "unknown", ...base, next: unknownNext };
      }
      const settled = await settleAgentOperation(
        this.#store.database,
        row.id,
        scriptError ? "failed" : "completed",
        scriptError ? { ...summary, scriptError } : summary,
      );
      if (!settled) return { status: "unknown", ...base, next: unknownNext };
      if (scriptError)
        return { status: "failed", ...base, result, scriptError, next: scriptFailedNext };
      return { status: "completed", ...base, result, summary };
    } finally {
      if (--entry.work === 0 && this.#sessions.get(row.sessionId) === entry)
        this.#sessions.delete(row.sessionId);
    }
  }
}

export async function withAgentOperationReceipt<Result>(
  database: OpensteerStore["database"],
  row: Pick<AgentOperationRow, "id">,
  taskId: ThreadId,
  perform: () => Promise<Result>,
): Promise<Result> {
  try {
    return await perform();
  } catch (error) {
    if (
      error instanceof AgentOperationFailure ||
      (error instanceof ToolBlockedError && error.receipt)
    )
      throw error;
    const current = await readAgentOperation(database, row.id).catch(() => null);
    const state = current?.state;
    throw new AgentOperationFailure(error, {
      taskId,
      operationId: row.id,
      ...(state === "refused" || state === "failed" || state === "unknown"
        ? { status: state }
        : {}),
    });
  }
}

export function agentOperationRefusal(decision: AgentOperationDecision | null): OpensteerError {
  if (decision?.by === "refused")
    return new OpensteerError({
      code: "forbidden",
      reason:
        decision.reason === "person"
          ? "person-declined"
          : decision.reason === "stopped"
            ? "agent-session-stopped"
            : "authority-changed",
      message: decision.message,
    });
  return new OpensteerError({ code: "forbidden", message: "This operation was refused." });
}

export function assertOperationArguments(
  row: Pick<AgentOperationRow, "argumentDigest"> & { readonly taskId: ThreadId },
  digest: string,
  taskId?: ThreadId,
) {
  if (row.argumentDigest !== digest || (taskId && taskId !== row.taskId))
    throw new OpensteerError({
      code: "conflict",
      reason: "operation-key-reused",
      message: "This operationKey already names a different call.",
    });
}

/**
 * An admission or authority refusal of a pooled send, with the code a connected agent acts on
 * (`docs/architecture.md`) and the decision's reason. Anything else is not a refusal.
 */
function unsentRefusal(
  error: unknown,
  ended: OpensteerError | null,
):
  | { readonly code: string; readonly reason: "authority" | "changed" | "stopped"; message: string }
  | undefined {
  // The authority recheck before a send: the grant, the mode or the connection changed.
  if (!ended && error instanceof OperationOutcomeUnknown)
    return {
      code: "access_changed",
      reason: "authority",
      message: error.message || "The connected agent's access changed during this work.",
    };
  const refusal = ended ?? (error instanceof OpensteerError ? error : null);
  if (!refusal) return undefined;
  const { message } = refusal;
  if (refusal.reason === "agent-session-stopped")
    return { code: "stopped_by_person", reason: "stopped", message };
  if (refusal.reason === "authority-changed")
    return { code: "access_changed", reason: "authority", message };
  if (refusal instanceof BrowserPoolAdmissionClosed)
    return { code: "computer_offline", reason: "changed", message };
  if (refusal.code === "not_found") return { code: "not_found", reason: "changed", message };
  if (refusal.code === "forbidden") return { code: "access_denied", reason: "authority", message };
  return undefined;
}

/** A signal that aborts with `reason()` when `source` does, for a refusal of our own words. */
function abortedWith(source: AbortSignal, reason: () => unknown): AbortSignal {
  const controller = new AbortController();
  if (source.aborted) controller.abort(reason());
  else source.addEventListener("abort", () => controller.abort(reason()), { once: true });
  return controller.signal;
}
