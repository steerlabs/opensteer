import {
  AgentGrantSchema,
  AgentOperationTargetSchema,
  agentGrantAccess,
  type AgentGrantTarget,
  OpensteerError,
  createId,
  nextMarkColor,
  type AgentOperationDecision,
  type AgentOperationId,
  type AgentOperationOutcome,
  type AgentOperationState,
  type AgentOperationTarget,
  type AgentSessionEndReason,
  type AgentSessionId,
  type HarnessInstanceId,
  type ModelSelection,
  type RequestId,
  type RequestResponse,
  type ThreadAccessMode,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { RequestStore } from "./request-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { cancelPending } from "./request-cancellation.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import {
  assertRequestRevision,
  lockRequestThreads,
  refreshRequestState,
  requestFromRow,
} from "./request-persistence.js";
import { readRequestSettlementProvenance, requestSettlementActor } from "./request-settlement.js";
import { lineageEndedMessage } from "./resource-access.js";
import type { AgentOperationTable, AgentSessionTable, DatabaseSchema } from "./schema.js";
import { jsonValue, principalIdForUser } from "./store-primitives.js";
import { projectThreadState } from "./thread-status.js";

type Tx = Transaction<DatabaseSchema>;
export type AgentSessionRow = Selectable<AgentSessionTable>;
export type AgentOperationRow = Selectable<AgentOperationTable>;

/** The reserved, never-enabled engine a session task is placed on; no Run can start on it. */
export const externalAgentDriverKind = "external-agent";
const externalAgentModel: ModelSelection = {
  providerId: "external-agent",
  modelId: "external-agent",
  options: {},
} as ModelSelection;

export const sessionStoppedMessage =
  "The person stopped this work. Do not continue it; ask before starting again.";
export const directWorkUnavailableMessage =
  "This connected agent was approved before direct work. The person can reconnect it to allow it.";

function refused(message: string, reason?: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message, ...(reason ? { reason } : {}) });
}

/** A begin that lost the race for the connection's one active session; retried once. */
class SessionRace extends Error {}

/** The connection as a direct call needs it, held `FOR SHARE` against Disconnect and edits. */
async function lockLiveConnection(tx: Tx, userId: UserId, agentConnectionId: string) {
  const row = await tx
    .selectFrom("agentConnections")
    .select(["id", "label", "accessMode", "consentVersion", "grantRevision"])
    .where("id", "=", agentConnectionId)
    .where("userId", "=", userId)
    .where("revokedAt", "is", null)
    .where("tokenHash", "is not", null)
    .where("expiresAt", ">", new Date())
    .forShare()
    .executeTakeFirst();
  if (!row) throw refused(lineageEndedMessage);
  if (row.consentVersion < 2) throw refused(directWorkUnavailableMessage);
  return row;
}

/** The Home's own environment and its reserved external-agent engine, created on first use. */
async function sessionPlacement(tx: Tx) {
  const settings = await tx
    .selectFrom("personalSettings")
    .select("agentHomeComputerId")
    .executeTakeFirstOrThrow();
  const environment = await tx
    .selectFrom("executionEnvironments")
    .select("id")
    .where("runnerId", "=", settings.agentHomeComputerId)
    .forShare()
    .executeTakeFirst();
  if (!environment)
    throw new OpensteerError({
      code: "conflict",
      message: "This Home has no place to record work.",
    });
  await tx
    .insertInto("harnessInstances")
    .values({
      id: createId("harnessInstance"),
      environmentId: environment.id,
      driverKind: externalAgentDriverKind,
      name: "Connected agent",
      config: jsonValue({}),
      runtimeRevision: 1,
      stateKind: "isolated",
      enabled: false,
      isDefault: false,
      sourceId: externalAgentDriverKind,
      removedAt: new Date(),
    } as never)
    .onConflict((conflict) =>
      conflict
        .column("environmentId")
        .where("driverKind", "=", externalAgentDriverKind as never)
        .doNothing(),
    )
    .execute();
  const harness = await tx
    .selectFrom("harnessInstances")
    .select("id")
    .where("environmentId", "=", environment.id)
    .where("driverKind", "=", externalAgentDriverKind as never)
    .forShare()
    .executeTakeFirstOrThrow();
  return { environmentId: environment.id, harnessInstanceId: harness.id as HarnessInstanceId };
}

async function touch(tx: Tx, session: AgentSessionRow): Promise<AgentSessionRow> {
  return tx
    .updateTable("agentSessions")
    .set({ lastActiveAt: new Date() })
    .where("id", "=", session.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface BeginAgentSessionInput {
  readonly userId: UserId;
  readonly agentConnectionId: string;
  /** A session task the caller names; it must be this connection's active session. */
  readonly taskId?: ThreadId | undefined;
  /** A short purpose the agent gave, for a new task's title. */
  readonly purpose?: string | undefined;
}

/**
 * Continue the connection's active session, or start one with its task, atomically. A session
 * the person stopped is never continued: calls naming it are refused, and the next unnamed call
 * is refused once with that notice before a new session may start.
 */
export async function beginAgentSession(
  database: Kysely<DatabaseSchema>,
  input: BeginAgentSessionInput,
): Promise<{ readonly session: AgentSessionRow; readonly created: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await commitPersonalMutation(database, (tx) => beginInTransaction(tx, input));
      if ("notice" in result) throw refused(sessionStoppedMessage, "agent-session-stopped");
      return result;
    } catch (error) {
      if (!(error instanceof SessionRace) || attempt > 0) throw error;
    }
  }
}

async function beginInTransaction(
  tx: Tx,
  input: BeginAgentSessionInput,
): Promise<{ session: AgentSessionRow; created: boolean } | { notice: true }> {
  await requirePersonalOwner(tx, input.userId);
  const connection = await lockLiveConnection(tx, input.userId, input.agentConnectionId);
  if (input.taskId) {
    const named = await tx
      .selectFrom("agentSessions")
      .selectAll()
      .where("threadId", "=", input.taskId)
      .where("connectionId", "=", connection.id)
      .forShare()
      .executeTakeFirst();
    if (!named) throw refused("Task is unavailable");
    if (named.status === "ended")
      throw named.endReason === "stopped"
        ? refused(sessionStoppedMessage, "agent-session-stopped")
        : refused("This task's session ended. Leave out taskId to start a new one.");
    return { session: await touch(tx, named), created: false };
  }
  const active = await tx
    .selectFrom("agentSessions")
    .selectAll()
    .where("connectionId", "=", connection.id)
    .where("status", "=", "active")
    .forShare()
    .executeTakeFirst();
  if (active) return { session: await touch(tx, active), created: false };
  const stopped = await tx
    .updateTable("agentSessions")
    .set({ stopNoticeDeliveredAt: new Date() })
    .where("connectionId", "=", connection.id)
    .where("endReason", "=", "stopped")
    .where("stopNoticeDeliveredAt", "is", null)
    .returning("id")
    .execute();
  if (stopped.length) return { notice: true };
  const placement = await sessionPlacement(tx);
  const recent = await tx
    .selectFrom("threads")
    .select("color")
    .where("createdBy", "=", input.userId)
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(6)
    .execute();
  const threadId = createId("thread");
  const now = new Date();
  const purpose = input.purpose?.trim();
  const title = (purpose ? `${connection.label}: ${purpose}` : connection.label).slice(0, 200);
  await tx
    .insertInto("threads")
    .values({
      id: threadId,
      ...placement,
      createdBy: input.userId,
      createdByPrincipalId: await principalIdForUser(tx, input.userId),
      accessMode: connection.accessMode,
      originConnectionId: connection.id,
      worker: "external",
      lineageRootThreadId: threadId,
      listed: true,
      modelSelection: jsonValue(externalAgentModel),
      parentThreadId: null,
      purpose: "task",
      teamId: null,
      channelId: null,
      threadRootId: null,
      status: "idle",
      title,
      titleSource: "chosen",
      icon: null,
      iconSource: "provisional",
      color: nextMarkColor(recent.map((row) => row.color)),
      createdAt: now,
      askedAt: now,
      updatedAt: now,
    } as never)
    .execute();
  const session = await tx
    .insertInto("agentSessions")
    .values({
      id: createId("agentSession"),
      connectionId: connection.id,
      userId: input.userId,
      threadId,
      status: "active",
      endedAt: null,
      endReason: null,
      stopNoticeDeliveredAt: null,
    })
    .onConflict((conflict) =>
      conflict.column("connectionId").where("status", "=", "active").doNothing(),
    )
    .returningAll()
    .executeTakeFirst();
  if (!session) throw new SessionRace();
  await projectThreadState(tx, threadId, now, true);
  return { session, created: true };
}

/**
 * Ends sessions with one reason, and settles what they still hold at the Home: their open
 * operations that never left are refused, their pending Requests cancelled by the caller.
 * Returns the sessions it ended, so the runtime can abort their in-flight work.
 */
export async function endAgentSessions(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly userId: UserId;
    readonly reason: AgentSessionEndReason;
    readonly connectionId?: string;
    readonly sessionIds?: readonly AgentSessionId[];
    /** Stop binds to the session the person saw, so a late tap cannot end a successor. */
    readonly threadId?: ThreadId;
  },
): Promise<readonly AgentSessionRow[]> {
  return commitPersonalMutation(database, async (tx) => {
    let query = tx
      .selectFrom("agentSessions")
      .select("id")
      .where("userId", "=", input.userId)
      .where("status", "=", "active");
    if (input.connectionId) query = query.where("connectionId", "=", input.connectionId);
    if (input.sessionIds) {
      if (!input.sessionIds.length) return [];
      query = query.where("id", "in", [...input.sessionIds]);
    }
    if (input.threadId) query = query.where("threadId", "=", input.threadId);
    const ids = (await query.orderBy("id").execute()).map(({ id }) => id);
    if (!ids.length) return [];
    const ended = await tx
      .updateTable("agentSessions")
      .set({ status: "ended", endedAt: new Date(), endReason: input.reason })
      .where("id", "in", ids)
      .where("status", "=", "active")
      .returningAll()
      .execute();
    const reason =
      input.reason === "stopped"
        ? "The person stopped this work."
        : input.reason === "idle"
          ? "The session ended after it went quiet."
          : "The connected agent's access changed or ended.";
    await tx
      .updateTable("agentOperations")
      .set({
        state: "refused",
        outcome: "refused",
        completedAt: new Date(),
        updatedAt: new Date(),
        decision: jsonValue({
          by: "refused",
          reason: input.reason === "stopped" ? "stopped" : "authority",
          message: reason,
        } satisfies AgentOperationDecision),
      })
      .where("sessionId", "in", ids)
      .where("state", "in", ["admitted", "pending", "approved"])
      .execute();
    // Nothing an ended session asked for can be answered any more.
    const open = await tx
      .selectFrom("requests")
      .select("id")
      .where("originatingAgentSessionId", "in", ids)
      .where("status", "=", "pending")
      .orderBy("id")
      .execute();
    if (open.length)
      await cancelPending(tx, {
        reason: input.reason === "stopped" ? "run-ended" : "authority-revoked",
        resolvedAt: new Date(),
        requestIds: open.map(({ id }) => id),
      });
    for (const session of [...ended].sort((a, b) => a.threadId.localeCompare(b.threadId)))
      await projectThreadState(tx, session.threadId, new Date(), true);
    return ended;
  });
}

/** How long a person's open answer keeps a quiet session alive. */
export const agentOperationRequestLifetimeMs = 24 * 60 * 60_000;

/** Active sessions quiet past `before` with no open Request of their own still in its lifetime. */
export async function idleAgentSessions(
  database: Kysely<DatabaseSchema>,
  before: Date,
): Promise<readonly { readonly id: AgentSessionId; readonly userId: UserId }[]> {
  return database
    .selectFrom("agentSessions")
    .select(["id", "userId"])
    .where("status", "=", "active")
    .where("lastActiveAt", "<", before)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("requests")
            .select("requests.id")
            .whereRef("requests.originatingAgentSessionId", "=", "agentSessions.id")
            .where("requests.status", "=", "pending")
            .where(
              "requests.createdAt",
              ">",
              new Date(Date.now() - agentOperationRequestLifetimeMs),
            ),
        ),
      ),
    )
    .orderBy("id")
    .execute();
}

export interface AdmitOperationInput {
  readonly userId: UserId;
  readonly agentConnectionId: string;
  readonly sessionId: AgentSessionId;
  readonly operationKey: string;
  readonly tool: string;
  readonly argumentDigest: string;
  readonly target: AgentOperationTarget;
  readonly targetGeneration: string | null;
  readonly grantRevision: number;
  readonly mode: ThreadAccessMode;
  readonly effect: "read" | "write";
  readonly calls: string;
  readonly agentReason: string | null;
}

/**
 * Persists the operation before any review or effect, unique on (session, operation key). A
 * repeat with the same digest returns the recorded operation; a different digest is refused.
 */
export async function admitAgentOperation(
  database: Kysely<DatabaseSchema>,
  input: AdmitOperationInput,
): Promise<{ readonly operation: AgentOperationRow; readonly replay: boolean }> {
  return commitPersonalMutation(database, async (tx) => {
    await lockLiveConnection(tx, input.userId, input.agentConnectionId);
    const session = await tx
      .selectFrom("agentSessions")
      .select(["id", "status", "endReason"])
      .where("id", "=", input.sessionId)
      .where("connectionId", "=", input.agentConnectionId)
      .forShare()
      .executeTakeFirst();
    const existing = await tx
      .selectFrom("agentOperations")
      .selectAll()
      .where("sessionId", "=", input.sessionId)
      .where("operationKey", "=", input.operationKey)
      .executeTakeFirst();
    if (existing) {
      if (existing.argumentDigest !== input.argumentDigest)
        throw new OpensteerError({
          code: "conflict",
          reason: "operation-key-reused",
          message: "This operationKey already names a different call.",
        });
      return { operation: existing, replay: true };
    }
    if (!session || session.status !== "active")
      throw session?.endReason === "stopped"
        ? refused(sessionStoppedMessage, "agent-session-stopped")
        : refused("This task's session ended. Leave out taskId to start a new one.");
    const operation = await tx
      .insertInto("agentOperations")
      .values({
        id: createId("agentOperation"),
        sessionId: input.sessionId,
        connectionId: input.agentConnectionId,
        userId: input.userId,
        operationKey: input.operationKey,
        tool: input.tool,
        argumentDigest: input.argumentDigest,
        target: jsonValue(AgentOperationTargetSchema.parse(input.target)),
        targetGeneration: input.targetGeneration,
        grantRevision: input.grantRevision,
        mode: input.mode,
        effect: input.effect,
        state: "admitted",
        decision: null,
        requestId: null,
        calls: input.calls,
        agentReason: input.agentReason,
        handedOffAt: null,
        completedAt: null,
        outcome: null,
        resultSummary: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { operation, replay: false };
  });
}

/** Records who allowed an operation, or why it is refused; only from `admitted`. */
export async function decideAgentOperation(
  database: Kysely<DatabaseSchema>,
  id: AgentOperationId,
  decision: AgentOperationDecision,
): Promise<AgentOperationRow> {
  const refusedDecision = decision.by === "refused";
  const row = await database
    .updateTable("agentOperations")
    .set({
      decision: jsonValue(decision),
      state: refusedDecision ? "refused" : "approved",
      ...(refusedDecision ? { outcome: "refused", completedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where("id", "=", id)
    .where("state", "=", "admitted")
    .returningAll()
    .executeTakeFirst();
  return row ?? (await readAgentOperation(database, id));
}

export async function readAgentOperation(
  database: Kysely<DatabaseSchema>,
  id: AgentOperationId,
): Promise<AgentOperationRow> {
  return database
    .selectFrom("agentOperations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

export const operationDecisionFieldId = "decision";
export const operationAllow = "allow";
export const operationDeny = "deny";

/**
 * Opens the person's Request for one operation, in the transaction that marks it pending. The
 * summary is the Home's; the agent's own reason is kept apart and labelled as its words.
 */
export async function askForAgentOperation(
  database: Kysely<DatabaseSchema>,
  requests: Pick<RequestStore, "create">,
  input: {
    readonly operation: AgentOperationRow;
    readonly threadId: ThreadId;
    readonly title: string;
    readonly summary: string;
  },
): Promise<AgentOperationRow> {
  return commitPersonalMutation(database, async (tx) => {
    // The session, then its operation, then (inside the Request) its task: their ranked order.
    await tx
      .selectFrom("agentSessions")
      .select("id")
      .where("id", "=", input.operation.sessionId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const operation = await tx
      .selectFrom("agentOperations")
      .selectAll()
      .where("id", "=", input.operation.id)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (operation.state !== "admitted") return operation;
    const reason = operation.agentReason
      ? `\n\nThe agent's own reason (its words, not checked): ${operation.agentReason}`
      : "";
    const detail = `${input.summary}\n\nWhat it will run:\n${operation.calls}${reason}`.slice(
      0,
      20_000,
    );
    const created = await requests.create(
      {
        // One Request per review round: a fresh review after a grant change asks again.
        callId: `operation:${operation.id}:${randomUUID()}`,
        kind: "person.question",
        mode: "durable",
        originatingAgentSessionId: operation.sessionId,
        originatingThreadId: input.threadId,
        payload: { kind: "person.question" },
        presentation: {
          kind: "form",
          title: input.title.slice(0, 200),
          detail,
          fields: [
            {
              id: operationDecisionFieldId,
              prompt: "Allow this once?",
              choices: [
                { label: "Allow", value: operationAllow },
                { label: "Don't allow", value: operationDeny },
              ],
              custom: false,
              multiSelect: false,
              secret: false,
            },
          ],
        },
        requestedBy: operation.userId,
        requiredActor: "requester",
      } as never,
      tx,
    );
    const pending = await tx
      .updateTable("agentOperations")
      .set({ state: "pending", requestId: created.request.id, updatedAt: new Date() })
      .where("id", "=", operation.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await projectThreadState(tx, input.threadId);
    return pending;
  });
}

/**
 * The person's answer to an operation's Request: settles the Request and marks the operation
 * approved or refused in one transaction. No Runner continuation is involved.
 */
export async function respondToAgentOperation(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  },
): Promise<AgentOperationRow> {
  const choice =
    input.response.kind === "form"
      ? input.response.answers[operationDecisionFieldId]?.[0]
      : input.response.kind === "external" && input.response.value?.decision === "declined"
        ? operationDeny
        : undefined;
  if (choice !== operationAllow && choice !== operationDeny)
    throw new OpensteerError({ code: "bad_request", message: "Choose Allow or Don't allow." });
  return commitPersonalMutation(database, async (tx) => {
    const linked = await tx
      .selectFrom("agentOperations")
      .select(["id", "sessionId"])
      .where("requestId", "=", input.requestId)
      .executeTakeFirst();
    if (!linked) throw new OpensteerError({ code: "not_found", message: "Request not found" });
    await tx
      .selectFrom("agentSessions")
      .select("id")
      .where("id", "=", linked.sessionId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const operation = await tx
      .selectFrom("agentOperations")
      .selectAll()
      .where("id", "=", linked.id)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const origin = await tx
      .selectFrom("requests")
      .select("originatingThreadId")
      .where("id", "=", input.requestId)
      .executeTakeFirstOrThrow();
    await lockRequestThreads(tx, [origin.originatingThreadId]);
    const row = await tx
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", input.requestId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (row.status !== "pending")
      throw new OpensteerError({ code: "conflict", message: "Request is no longer pending" });
    if (row.requestedBy !== input.resolvedBy)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only the person it asked can answer this.",
      });
    assertRequestRevision(row, input.expectedRevision);
    const now = new Date();
    const allowed = choice === operationAllow && operation.state === "pending";
    await tx
      .updateTable("requests")
      .set({
        status: allowed ? "fulfilled" : "declined",
        resolvedAt: now,
        resolvedBy: input.resolvedBy,
        response: jsonValue(input.response),
        settlementProvenance: await readRequestSettlementProvenance(
          tx,
          input.resolvedBy,
          input.settlementSessionId,
        ),
      })
      .where("id", "=", row.id)
      .where("status", "=", "pending")
      .execute();
    await requestSettlementActor(tx, input.resolvedBy, input.settlementSessionId);
    await refreshRequestState(tx, requestFromRow(row).id);
    await projectThreadState(tx, origin.originatingThreadId);
    if (operation.state !== "pending") return operation;
    return tx
      .updateTable("agentOperations")
      .set(
        allowed
          ? {
              state: "approved",
              decision: jsonValue({ by: "person", requestId: input.requestId }),
              updatedAt: now,
            }
          : {
              state: "refused",
              outcome: "refused",
              completedAt: now,
              decision: jsonValue({
                by: "refused",
                reason: "person",
                message: "The person did not allow it.",
              } satisfies AgentOperationDecision),
              updatedAt: now,
            },
      )
      .where("id", "=", operation.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
 * Wins or loses the one approved → handed-off transition, under the live connection and an
 * active session. Returns null when another resume won, or the operation is no longer approved.
 */
export async function handOffAgentOperation(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly userId: UserId;
    readonly agentConnectionId: string;
    readonly id: AgentOperationId;
  },
): Promise<AgentOperationRow | null> {
  return commitPersonalMutation(database, async (tx) => {
    await lockLiveConnection(tx, input.userId, input.agentConnectionId);
    const operation = await tx
      .selectFrom("agentOperations")
      .innerJoin("agentSessions", "agentSessions.id", "agentOperations.sessionId")
      .select(["agentOperations.sessionId", "agentSessions.status"])
      .where("agentOperations.id", "=", input.id)
      .executeTakeFirstOrThrow();
    if (operation.status !== "active") return null;
    return (
      (await tx
        .updateTable("agentOperations")
        .set({ state: "handed-off", handedOffAt: new Date(), updatedAt: new Date() })
        .where("id", "=", input.id)
        .where("state", "=", "approved")
        .returningAll()
        .executeTakeFirst()) ?? null
    );
  });
}

/** An approved operation whose authority changed before hand-off needs a fresh review. */
export async function reopenAgentOperation(
  database: Kysely<DatabaseSchema>,
  id: AgentOperationId,
  facts: { readonly grantRevision: number; readonly mode: ThreadAccessMode },
): Promise<AgentOperationRow | null> {
  return (
    (await database
      .updateTable("agentOperations")
      .set({
        state: "admitted",
        decision: null,
        requestId: null,
        grantRevision: facts.grantRevision,
        mode: facts.mode,
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .where("state", "in", ["approved", "pending"])
      .returningAll()
      .executeTakeFirst()) ?? null
  );
}

/** The terminal outcome of a handed-off operation; `unknown` is never retried. */
export async function settleAgentOperation(
  database: Kysely<DatabaseSchema>,
  id: AgentOperationId,
  outcome: Exclude<AgentOperationOutcome, "refused">,
  summary: Readonly<Record<string, unknown>> | null,
): Promise<AgentOperationRow | null> {
  const state: AgentOperationState = outcome;
  return (
    (await database
      .updateTable("agentOperations")
      .set({
        state,
        outcome,
        completedAt: new Date(),
        updatedAt: new Date(),
        resultSummary: summary ? jsonValue(summary) : null,
      })
      .where("id", "=", id)
      .where("state", "=", "handed-off")
      .returningAll()
      .executeTakeFirst()) ?? null
  );
}

/** Handed-off operations no executor in this process can still finish: their outcome is unknown. */
export async function settleOrphanedAgentOperations(
  database: Kysely<DatabaseSchema>,
  live: ReadonlySet<string>,
): Promise<number> {
  const rows = await database
    .selectFrom("agentOperations")
    .select("id")
    .where("state", "=", "handed-off")
    .execute();
  const orphans = rows.map(({ id }) => id).filter((id) => !live.has(id));
  if (!orphans.length) return 0;
  const settled = await database
    .updateTable("agentOperations")
    .set({ state: "unknown", outcome: "unknown", completedAt: new Date(), updatedAt: new Date() })
    .where("id", "in", orphans)
    .where("state", "=", "handed-off")
    .execute();
  return settled.reduce((sum, result) => sum + Number(result.numUpdatedRows), 0);
}

/** A connection's operations, newest first, paged by (createdAt, id). */
export async function listAgentOperations(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly userId: UserId;
    readonly connectionId: string;
    readonly limit: number;
    readonly before?: { readonly createdAt: Date; readonly id: string };
  },
) {
  let query = database
    .selectFrom("agentOperations")
    .innerJoin("agentSessions", "agentSessions.id", "agentOperations.sessionId")
    .selectAll("agentOperations")
    .select("agentSessions.threadId")
    .where("agentOperations.userId", "=", input.userId)
    .where("agentOperations.connectionId", "=", input.connectionId);
  if (input.before) {
    const { createdAt, id } = input.before;
    query = query.where(
      sql<boolean>`(agent_operations.created_at, agent_operations.id) < (${createdAt}, ${id})`,
    );
  }
  return query
    .orderBy("agentOperations.createdAt", "desc")
    .orderBy("agentOperations.id", "desc")
    .limit(input.limit)
    .execute();
}

/**
 * Of these active sessions, those that used a target the connection's current grant no longer
 * reaches, or wrote to one it now reaches only for reading.
 */
export async function sessionsUsingWithdrawn(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  connectionId: string,
  sessionIds: readonly AgentSessionId[],
): Promise<readonly AgentSessionId[]> {
  if (!sessionIds.length) return [];
  const connection = await database
    .selectFrom("agentConnections")
    .select("grant")
    .where("id", "=", connectionId)
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (!connection) return [...sessionIds];
  const grant = AgentGrantSchema.parse(connection.grant);
  const used = await database
    .selectFrom("agentOperations")
    .select(["sessionId", "target", "effect"])
    .where("sessionId", "in", [...sessionIds])
    .where("state", "not in", ["refused"])
    .execute();
  const ending = new Set<AgentSessionId>();
  for (const { sessionId, target, effect } of used) {
    if (target.grant.kind === "device") continue;
    const access = agentGrantAccess(grant, target.grant as AgentGrantTarget);
    if (!access || (effect === "write" && access !== "read-write")) ending.add(sessionId);
  }
  return [...ending];
}
