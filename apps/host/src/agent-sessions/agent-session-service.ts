import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  OpensteerError,
  agentOperationHoldMs,
  agentSessionIdleMs,
  refused,
  type AgentGrant,
  type AgentOperationDecision,
  type AgentOperationId,
  type AgentOperationTarget,
  type AgentSessionEndReason,
  type AgentSessionId,
  type RequestId,
  type RequestResponse,
  type ThreadAccessMode,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  admitAgentOperation,
  admitExecution,
  askForAgentOperation,
  authorizeTarget,
  beginAgentSession,
  decideAgentOperation,
  endAgentSessions,
  handOffAgentOperation,
  idleAgentSessions,
  readAgentOperation,
  reopenAgentOperation,
  respondToAgentOperation,
  settleAgentOperation,
  settleOrphanedAgentOperations,
  type AgentOperationRow,
  type ExecutionAuthority,
  type OpensteerStore,
} from "@opensteer/database";
import { canonicalJson } from "@opensteer/shared/canonicalJson";

/**
 * Decides an effect in `auto`: allow it, or ask the person. It sees the grant, the mode, the
 * trusted target, the exact script or calls, and the agent's reason marked as untrusted. It never
 * refuses on its own; doubt, an error, a timeout or a malformed answer means ask.
 */
export interface AgentReviewerPort {
  review(
    input: {
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
const reviewerTimeoutMs = 15_000;
/** How long one executor call may take before its signal aborts. */
const defaultExecutionMs = 120_000;

/** What an executor gets: a signal tied to Stop, Disconnect, narrowing and its deadline. */
export interface DirectOperationContext {
  readonly sessionId: AgentSessionId;
  readonly taskId: ThreadId;
  readonly operationId: AgentOperationId;
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
}

/** An executor's way to say it cannot tell whether its effect happened. */
export class OperationOutcomeUnknown extends Error {}

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
  readonly effect: "read" | "write";
  /** The exact script or calls, shown in full to the person who reviews it. */
  readonly calls: string;
  /** The agent's own reason, kept apart and marked as its words. */
  readonly reason?: string | undefined;
  readonly timeoutMs?: number;
  readonly execute: (context: DirectOperationContext) => Promise<Result>;
  /** A bounded, redacted record of the result, for the activity list. */
  readonly summarize?: (result: Result) => Readonly<Record<string, unknown>> | null;
}

export type DirectOperationResult<Result> =
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
      readonly status: "failed" | "unknown";
      readonly taskId: ThreadId;
      readonly operationId: AgentOperationId;
      readonly next: string;
    };

const pendingNext =
  "Waiting on the person in Needs you. Do not poll. Call again with the same operationKey and arguments after they answer.";
const unknownNext =
  "The Home lost track of whether this took effect. Check the current state before doing anything else; never repeat it blindly.";

function digest(tool: string, input: unknown): string {
  return createHash("sha256").update(canonicalJson({ tool, input })).digest("hex");
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
  /** Operations handed off in this process, joined by a concurrent resume of the same call. */
  readonly #running = new Map<AgentOperationId, Promise<DirectOperationResult<unknown>>>();
  readonly #decisions = new EventEmitter();
  readonly #holdMs: number;
  #sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    readonly store: OpensteerStore;
    readonly reviewer?: AgentReviewerPort;
    /** Closes what holds a binding open elsewhere, such as a standard CDP attachment. */
    readonly closeBinding?: (bindingId: string, reason: string) => void;
    readonly onError?: (error: unknown) => void;
    /** How long a call waits for the person's decision before it returns pending. */
    readonly holdMs?: number;
  }) {
    this.#store = options.store;
    this.#holdMs = options.holdMs ?? agentOperationHoldMs;
    this.#reviewer = options.reviewer ?? alwaysAskReviewer;
    this.#closeBinding = options.closeBinding ?? (() => {});
    this.#onError = options.onError ?? (() => {});
    this.#decisions.setMaxListeners(0);
  }

  /**
   * At Host startup: nothing handed off before this process can still report, so those
   * operations are `unknown`. Then sessions that went quiet are ended on a timer.
   */
  async start(): Promise<void> {
    await settleOrphanedAgentOperations(this.#store.database, new Set(this.#running.keys()));
    this.#sweeper = setInterval(() => {
      void this.endIdle().catch(this.#onError);
    }, 60_000);
    this.#sweeper.unref();
  }
  /** Settles once every operation handed off in this process has recorded its outcome. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#running.values()]);
  }
  stop(): void {
    clearInterval(this.#sweeper);
    for (const [id, entry] of this.#sessions) {
      entry.controller.abort(
        new OpensteerError({ code: "conflict", message: "The Home stopped." }),
      );
      this.#sessions.delete(id);
    }
  }

  /** The one entry point every direct tool calls. */
  async run<Result>(operation: DirectOperation<Result>): Promise<DirectOperationResult<Result>> {
    if (!operation.target && operation.effect !== "read")
      throw new Error("An effect needs a concrete target");
    const { session } = await beginAgentSession(this.#store.database, {
      userId: operation.ownerUserId,
      agentConnectionId: operation.agentConnectionId,
      taskId: operation.taskId,
      purpose: operation.purpose,
    });
    const bindingId = `session:${session.id}` as const;
    const execution = await this.#admit(operation, bindingId);
    const target: AgentOperationTarget = operation.target ?? {
      grant: { kind: "device" },
      name: operation.targetName ?? operation.tool,
      device: null,
    };
    const { operation: row } = await admitAgentOperation(this.#store.database, {
      userId: operation.ownerUserId,
      agentConnectionId: operation.agentConnectionId,
      sessionId: session.id,
      operationKey: operation.operationKey,
      tool: operation.tool,
      argumentDigest: digest(operation.tool, operation.input),
      target,
      targetGeneration: operation.targetGeneration ?? null,
      grantRevision: execution.agentConnection!.grantRevision,
      mode: execution.mode,
      effect: operation.effect,
      calls: operation.calls,
      agentReason: operation.reason?.slice(0, 2_000) ?? null,
    });
    return this.#advance(operation, row, session.threadId, execution);
  }

  /** The person answered an operation's Request; waiters wake after the commit. */
  async respond(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<void> {
    const operation = await respondToAgentOperation(this.#store.database, input);
    this.#decisions.emit(operation.id);
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

  /** After a connection change committed: abort work of sessions that ended, or all of them. */
  async closeConnection(connectionId: string, all: boolean): Promise<void> {
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
    for (const session of await idleAgentSessions(
      this.#store.database,
      new Date(now - agentSessionIdleMs),
    )) {
      const ended = await endAgentSessions(this.#store.database, {
        userId: session.userId,
        sessionIds: [session.id],
        reason: "idle",
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
    this.#closeBinding(`session:${sessionId}`, message);
    const entry = this.#sessions.get(sessionId);
    if (!entry) return;
    this.#sessions.delete(sessionId);
    entry.controller.abort(new OpensteerError({ code: "forbidden", message }));
  }

  async #admit(
    operation: Pick<DirectOperation<unknown>, "ownerUserId" | "target" | "effect">,
    bindingId: string,
  ): Promise<ExecutionAuthority> {
    const execution = await admitExecution(this.#store.database, {
      ownerUserId: operation.ownerUserId,
      subject: { kind: "binding", bindingId },
    });
    if (operation.target) {
      const access = authorizeTarget(execution, operation.target.grant);
      if (!access)
        throw refused(
          "forbidden",
          `${operation.target.name} is not shared with this connected agent.`,
          "Ask the person to share it from Connected agents.",
        );
      if (operation.effect === "write" && access !== "read-write")
        throw refused("forbidden", `${operation.target.name} is shared for reading only.`);
    }
    return execution;
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
        case "completed":
          return { status: "completed", ...base, summary: row.resultSummary };
        case "failed":
          return { status: "failed", ...base, next: "It failed. Check the current state." };
        case "unknown":
          return { status: "unknown", ...base, next: unknownNext };
        case "refused":
          throw this.#refusal(row.decision);
        case "handed-off": {
          const running = this.#running.get(row.id);
          if (running) return (await running) as DirectOperationResult<Result>;
          return { status: "unknown", ...base, next: unknownNext };
        }
        case "admitted":
          row = await this.#decide(operation, row, taskId, execution);
          break;
        case "pending": {
          const decided = await this.#wait(row.id);
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
      decideAgentOperation(this.#store.database, row.id, decision);
    if (row.effect === "read") return decide({ by: "structural-read" });
    if (row.mode === "full-access") return decide({ by: "full-access" });
    if (row.mode === "auto" && (await this.#review(operation, row, execution)) === "allow")
      return decide({ by: "reviewer" });
    return askForAgentOperation(this.#store.database, this.#store.requests, {
      operation: row,
      threadId: taskId,
      title: `Allow ${operation.tool} on ${row.target.name}?`,
      summary: `A connected agent wants to run ${operation.tool} on ${row.target.name}${
        row.target.device ? ` on ${row.target.device.name}` : ""
      }.`,
    });
  }

  async #review<Result>(
    operation: DirectOperation<Result>,
    row: AgentOperationRow,
    execution: ExecutionAuthority,
  ): Promise<"allow" | "ask"> {
    const signal = AbortSignal.timeout(reviewerTimeoutMs);
    try {
      const answer = await this.#reviewer.review(
        {
          grant: execution.agentConnection!.grant,
          mode: row.mode,
          tool: row.tool,
          target: row.target,
          calls: row.calls,
          agentReason: operation.reason ? { untrusted: true, text: operation.reason } : null,
        },
        signal,
      );
      return answer === "allow" && !signal.aborted ? "allow" : "ask";
    } catch {
      return "ask";
    }
  }

  /** Waits up to the hold for the person's decision, woken by `respond` after its commit. */
  async #wait(id: AgentOperationId): Promise<AgentOperationRow> {
    let done!: () => void;
    const decided = new Promise<void>((resolve) => {
      done = () => {
        clearTimeout(timer);
        this.#decisions.removeListener(id, done);
        resolve();
      };
      const timer = setTimeout(done, this.#holdMs);
      timer.unref?.();
      // Listening before the read below, so an answer that commits in between still wakes it.
      this.#decisions.once(id, done);
    });
    const current = await readAgentOperation(this.#store.database, id);
    if (current.state !== "pending") done();
    await decided;
    return readAgentOperation(this.#store.database, id);
  }

  async #handOff<Result>(
    operation: DirectOperation<Result>,
    row: AgentOperationRow,
    taskId: ThreadId,
  ): Promise<DirectOperationResult<Result>> {
    const bindingId = `session:${row.sessionId}` as const;
    // A changed revision, mode or target is new authority: it needs a fresh decision.
    const execution = await this.#admit(operation, bindingId);
    if (
      execution.agentConnection!.grantRevision !== row.grantRevision ||
      execution.mode !== row.mode ||
      (operation.targetGeneration ?? null) !== row.targetGeneration
    ) {
      const reopened = await reopenAgentOperation(this.#store.database, row.id, {
        grantRevision: execution.agentConnection!.grantRevision,
        mode: execution.mode,
      });
      return this.#advance(
        operation,
        reopened ?? (await readAgentOperation(this.#store.database, row.id)),
        taskId,
        execution,
      );
    }
    const handed = await handOffAgentOperation(this.#store.database, {
      userId: operation.ownerUserId,
      agentConnectionId: operation.agentConnectionId,
      id: row.id,
    });
    if (!handed)
      return this.#advance(
        operation,
        await readAgentOperation(this.#store.database, row.id),
        taskId,
        execution,
      );
    const running = this.#execute(operation, handed, taskId, bindingId);
    this.#running.set(handed.id, running as Promise<DirectOperationResult<unknown>>);
    try {
      return await running;
    } finally {
      this.#running.delete(handed.id);
    }
  }

  async #execute<Result>(
    operation: DirectOperation<Result>,
    row: AgentOperationRow,
    taskId: ThreadId,
    bindingId: `session:${string}`,
  ): Promise<DirectOperationResult<Result>> {
    const entry = this.#sessions.get(row.sessionId) ?? {
      controller: new AbortController(),
      connectionId: row.connectionId,
      work: 0,
    };
    this.#sessions.set(row.sessionId, entry);
    entry.work++;
    const deadline = Date.now() + (operation.timeoutMs ?? defaultExecutionMs);
    const signal = AbortSignal.any([
      entry.controller.signal,
      AbortSignal.timeout(deadline - Date.now()),
    ]);
    const base = { taskId, operationId: row.id };
    try {
      const result = await operation.execute({
        sessionId: row.sessionId,
        taskId,
        operationId: row.id,
        bindingId,
        ownerUserId: operation.ownerUserId,
        signal,
        deadline,
        recheck: async () => {
          signal.throwIfAborted();
          const execution = await this.#admit(operation, bindingId);
          if (execution.agentConnection!.grantRevision !== row.grantRevision)
            throw refused("forbidden", "The connected agent's access changed during this work.");
        },
      });
      const summary = operation.summarize?.(result) ?? null;
      await settleAgentOperation(this.#store.database, row.id, "completed", summary);
      return { status: "completed", ...base, result, summary };
    } catch (error) {
      // A refusal before any effect, or a failure the executor confirmed, is `failed`; an
      // interruption it could not confirm is `unknown`, never retried.
      const outcome =
        error instanceof OperationOutcomeUnknown ||
        (signal.aborted && !(error instanceof OpensteerError))
          ? "unknown"
          : "failed";
      await settleAgentOperation(this.#store.database, row.id, outcome, null).catch(this.#onError);
      throw error;
    } finally {
      if (--entry.work === 0 && this.#sessions.get(row.sessionId) === entry)
        this.#sessions.delete(row.sessionId);
    }
  }

  #refusal(decision: AgentOperationDecision | null): OpensteerError {
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
}
