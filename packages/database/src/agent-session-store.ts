import { outsideName } from "@opensteer/shared/outsideName";
import {
  AgentOperationTargetSchema,
  agentSessionIdleMs,
  agentOperationEndingWords,
  minThreadAccessMode,
  threadAccessModeAtMost,
  ThreadAccessModeSchema,
  OpensteerError,
  createId,
  nextMarkColor,
  formatRequestOperationDetail,
  type AgentGrantTarget,
  type AgentOperationDecision,
  type AgentOperationEnding,
  type AgentOperationId,
  type AgentOperationOutcome,
  type AgentOperationState,
  type AgentOperationTarget,
  type AgentOperationView,
  type AgentSessionEndReason,
  type AgentSessionId,
  type HarnessInstanceId,
  type ModelSelection,
  type RequestId,
  type RequestResponse,
  type ThreadAccessMode,
  type ThreadId,
  type UserId,
  consentAllowsDirectWork,
} from "@opensteer/core";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { RequestStore } from "./request-store.js";
import {
  requireBrowserPoolAdmission,
  type BrowserPoolTargetIdentity,
} from "./browser-pool-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { cancelPending } from "./request-cancellation.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import {
  assertRequestRevision,
  refreshRequestState,
  requestFromRow,
} from "./request-persistence.js";
import { readRequestSettlementProvenance, requestSettlementActor } from "./request-settlement.js";
import {
  assertRequestOriginMayContinue,
  lineageEndedMessage,
  readLiveAgentConnectionRow,
} from "./resource-access.js";
import type { AgentOperationTable, AgentSessionTable, DatabaseSchema } from "./schema.js";
import { jsonValue, principalIdForUser } from "./store-primitives.js";
import { projectThreadState, publishThreadSummary } from "./thread-status.js";

type Tx = Transaction<DatabaseSchema>;
export type AgentSessionRow = Selectable<AgentSessionTable>;
export type AgentOperationRow = Selectable<AgentOperationTable>;

/** Reserve the exact device hold before its first frame, under the Disconnect and Stop fences. */
export function reserveAgentSessionDeviceHold(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly id: string;
    readonly sessionId: AgentSessionId;
    readonly deviceName: string;
    readonly homeProcessId: string;
  },
): Promise<void> {
  return commitPersonalMutation(database, async (tx) => {
    const session = await tx
      .selectFrom("agentSessions")
      .select(["connectionId", "userId"])
      .where("id", "=", input.sessionId)
      .executeTakeFirstOrThrow();
    await lockLiveConnection(tx, session.userId, session.connectionId);
    const active = await tx
      .selectFrom("agentSessions")
      .select("id")
      .where("id", "=", input.sessionId)
      .where("status", "=", "active")
      .forShare()
      .executeTakeFirst();
    if (!active) throw refused(sessionStoppedMessage);
    await tx
      .insertInto("agentSessionDeviceHolds")
      .values({ ...input, unconfirmedAt: null })
      .execute();
  });
}

export async function settleAgentSessionDeviceHold(
  database: Kysely<DatabaseSchema>,
  id: string,
  outcome: "ended" | "unknown",
): Promise<void> {
  if (outcome === "ended") {
    await database
      .deleteFrom("agentSessionDeviceHolds")
      .where("id", "=", id)
      .where("unconfirmedAt", "is", null)
      .execute();
  } else {
    await database
      .updateTable("agentSessionDeviceHolds")
      .set({ unconfirmedAt: new Date() })
      .where("id", "=", id)
      .where("unconfirmedAt", "is", null)
      .execute();
  }
}

/** Only the Home process that opened a hold can still reach its exact route. */
export async function settleOrphanedAgentSessionDeviceHolds(
  database: Kysely<DatabaseSchema>,
  sessionId: AgentSessionId,
  homeProcessId: string,
): Promise<void> {
  await database
    .updateTable("agentSessionDeviceHolds")
    .set({ unconfirmedAt: new Date() })
    .where("sessionId", "=", sessionId)
    .where("homeProcessId", "!=", homeProcessId)
    .where("unconfirmedAt", "is", null)
    .execute();
}

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
async function lockLiveConnection(
  tx: Tx,
  userId: UserId,
  agentConnectionId: string,
  grantTarget?: AgentGrantTarget,
) {
  const row = await readLiveAgentConnectionRow(tx, userId, agentConnectionId, true, {
    grantTarget,
  });
  if (!row) throw refused(lineageEndedMessage);
  if (!consentAllowsDirectWork(row.consentVersion)) throw refused(directWorkUnavailableMessage);
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
  readonly grantTarget?: AgentGrantTarget | undefined;
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
  const connection = await lockLiveConnection(
    tx,
    input.userId,
    input.agentConnectionId,
    input.grantTarget,
  );
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
  const purpose = input.purpose ? outsideName(input.purpose, 200) : "";
  const title =
    outsideName(purpose ? `${connection.label}: ${purpose}` : connection.label, 200) || "Agent";
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
    readonly idleAt?: Date;
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
    if (input.reason === "idle") {
      const eligible = idleSessionQuery(tx, input.idleAt ?? new Date()).select("id");
      query = query.where("id", "in", eligible);
    }
    const ids = (await query.orderBy("id").execute()).map(({ id }) => id);
    const ended = await endAgentSessionRows(tx, ids, input.reason);
    if (!ended.length) return [];
    // Nothing an ended session asked for can be answered any more, but a command it proposed:
    // that ask belongs to its connection, which still stands, so it waits for the person after
    // a session that ended on its own (went quiet, expired, closed by the agent). The person's
    // Stop of the session ends it; Disconnect and a narrowed grant close it where they happen.
    const open = await tx
      .selectFrom("requests")
      .select("id")
      .where("originatingAgentSessionId", "in", ids)
      .where("status", "=", "pending")
      .$if(input.reason !== "stopped", (query) => query.where("command", "is", null))
      .orderBy("id")
      .execute();
    if (open.length)
      await cancelPending(tx, {
        reason: input.reason === "stopped" ? "run-ended" : "authority-revoked",
        resolvedAt: new Date(),
        requestIds: open.map(({ id }) => id),
        expireAgentOperation: input.reason === "idle",
      });
    for (const session of [...ended].sort((a, b) => a.threadId.localeCompare(b.threadId)))
      await projectThreadState(tx, session.threadId, new Date(), true);
    return ended;
  });
}

/** End authority and unsent work before locking Runs, threads and Requests. */
export async function endAgentSessionRows(
  tx: Tx,
  ids: readonly AgentSessionId[],
  reason: AgentSessionEndReason,
): Promise<readonly AgentSessionRow[]> {
  if (!ids.length) return [];
  const ended = await tx
    .updateTable("agentSessions")
    .set({ status: "ended", endedAt: new Date(), endReason: reason })
    .where("id", "in", ids)
    .where("status", "=", "active")
    .returningAll()
    .execute();
  const message =
    reason === "stopped"
      ? "The person stopped this work."
      : reason === "done"
        ? agentOperationEndingWords["task-done"].message
        : reason === "idle"
          ? "The session ended after it went quiet."
          : "The connected agent's access changed or ended.";
  await tx
    .updateTable("agentOperations")
    .set({
      state: "refused",
      outcome: "refused",
      completedAt: new Date(),
      terminalEvidenceAt: new Date(),
      updatedAt: new Date(),
      ...(reason === "done" ? { ending: "task-done" as const } : {}),
      decision: jsonValue({
        by: "refused",
        reason: reason === "stopped" ? "stopped" : reason === "done" ? "changed" : "authority",
        message,
      } satisfies AgentOperationDecision),
    })
    .where("sessionId", "in", ids)
    .where("state", "in", ["admitted", "pending", "approved"])
    .execute();
  return ended;
}

/** How long a person's open answer keeps a quiet session alive. */
export const agentOperationRequestLifetimeMs = 24 * 60 * 60_000;

function pendingDirectRequests(database: Kysely<DatabaseSchema>) {
  return database
    .selectFrom("agentOperations")
    .innerJoin("requests", "requests.id", "agentOperations.requestId")
    .select([
      "agentOperations.id as id",
      "requests.id as requestId",
      "requests.originatingThreadId",
    ])
    .where("agentOperations.state", "=", "pending")
    .where("requests.status", "=", "pending");
}

type PendingDirectRequest = Awaited<
  ReturnType<ReturnType<typeof pendingDirectRequests>["execute"]>
>[number];

async function closeDirectRequests(
  tx: Tx,
  pending: readonly PendingDirectRequest[],
  now: Date,
  expired: boolean,
) {
  if (!pending.length) return [];
  await tx
    .selectFrom("agentOperations")
    .select("id")
    .where(
      "id",
      "in",
      pending.map(({ id }) => id),
    )
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  const operations = await tx
    .updateTable("agentOperations")
    .set({
      state: "refused",
      outcome: "refused",
      terminalEvidenceAt: now,
      completedAt: now,
      updatedAt: now,
      decision: jsonValue({
        by: "refused",
        reason: "authority",
        message: expired
          ? "The Request expired before the person answered."
          : "The connected agent's access changed or ended.",
      } satisfies AgentOperationDecision),
    })
    .where(
      "id",
      "in",
      pending.map(({ id }) => id),
    )
    .where("state", "=", "pending")
    .returningAll()
    .execute();
  await publishOperationTasks(
    tx,
    operations.map(({ sessionId }) => sessionId),
  );
  await cancelPending(tx, {
    reason: "authority-revoked",
    resolvedAt: now,
    requestIds: pending.map(({ requestId }) => requestId),
    expireAgentOperation: expired,
  });
  for (const threadId of [
    ...new Set(pending.map(({ originatingThreadId }) => originatingThreadId)),
  ].sort())
    await projectThreadState(tx, threadId);
  return operations;
}

export async function closeObsoleteAgentOperationRequests(
  tx: Tx,
  connectionIds: readonly string[],
  now: Date,
) {
  if (!connectionIds.length) return;
  await closeDirectRequests(
    tx,
    await pendingDirectRequests(tx)
      .innerJoin("agentConnections", "agentConnections.id", "agentOperations.connectionId")
      .where("agentOperations.connectionId", "in", connectionIds)
      .whereRef("agentOperations.grantRevision", "<", "agentConnections.grantRevision")
      .execute(),
    now,
    false,
  );
}

export function expireAgentOperationRequests(database: Kysely<DatabaseSchema>, now: Date) {
  return commitPersonalMutation(database, async (tx) =>
    closeDirectRequests(
      tx,
      await pendingDirectRequests(tx)
        .where(
          "requests.createdAt",
          "<=",
          new Date(now.getTime() - agentOperationRequestLifetimeMs),
        )
        .execute(),
      now,
      true,
    ),
  );
}

export async function closeAgentOperationRequestsAboveMode(
  tx: Tx,
  threadId: ThreadId,
  mode: ThreadAccessMode,
  now: Date,
) {
  await closeDirectRequests(
    tx,
    await pendingDirectRequests(tx)
      .where("requests.originatingThreadId", "=", threadId)
      .where(
        "agentOperations.mode",
        "in",
        ThreadAccessModeSchema.options.filter(
          (admitted) => !threadAccessModeAtMost(admitted, mode),
        ),
      )
      .execute(),
    now,
    false,
  );
}

/** Active sessions quiet past `before` with no open Request of their own still in its lifetime. */
function idleSessionQuery(database: Kysely<DatabaseSchema>, now: Date) {
  return database
    .selectFrom("agentSessions")
    .where("status", "=", "active")
    .where("lastActiveAt", "<", new Date(now.getTime() - agentSessionIdleMs))
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("agentOperations")
            .select("id")
            .whereRef("agentOperations.sessionId", "=", "agentSessions.id")
            .where("agentOperations.state", "=", "handed-off"),
        ),
      ),
    )
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
              new Date(now.getTime() - agentOperationRequestLifetimeMs),
            ),
        ),
      ),
    )
    .orderBy("id");
}

export function idleAgentSessions(database: Kysely<DatabaseSchema>, now: Date) {
  return idleSessionQuery(database, now).select(["id", "userId"]).execute();
}

export interface AdmitOperationInput {
  readonly userId: UserId;
  readonly agentConnectionId: string;
  readonly sessionId: AgentSessionId;
  readonly operationKey: string;
  readonly tool: string;
  readonly argumentDigest: string;
  readonly target: AgentOperationTarget;
  readonly grantTarget?: AgentGrantTarget | undefined;
  readonly targetGeneration: string | null;
  readonly grantRevision: number;
  readonly mode: ThreadAccessMode;
  readonly effect: "read" | "write";
  readonly calls: string;
  readonly agentReason: string | null;
}

/**
 * Persists the operation before any review or effect, unique on (connection, operation key). A
 * repeat with the same digest returns the recorded operation; a different digest is refused.
 */
export async function admitAgentOperation(
  database: Kysely<DatabaseSchema>,
  input: AdmitOperationInput,
): Promise<{ readonly operation: AgentOperationRow; readonly replay: boolean }> {
  return commitPersonalMutation(database, async (tx) => {
    const connection = await lockLiveConnection(
      tx,
      input.userId,
      input.agentConnectionId,
      input.grantTarget,
    );
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
      .where("connectionId", "=", input.agentConnectionId)
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
    if (connection.grantRevision !== input.grantRevision) throw refused(lineageEndedMessage);
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

/**
 * A decision this Home can still record. A past `reviewer` decision, from a
 * Home that once had a review model configured, stays readable as recorded;
 * nothing writes one any more.
 */
export type AgentOperationWrittenDecision = Exclude<AgentOperationDecision, { by: "reviewer" }>;

/** Records who allowed an operation, or why it is refused; only from `admitted`. */
export async function decideAgentOperation(
  database: Kysely<DatabaseSchema>,
  reviewed: ReviewedOperation,
  decision: AgentOperationWrittenDecision,
): Promise<AgentOperationRow> {
  const refusedDecision = decision.by === "refused";
  const decide = (writer: Kysely<DatabaseSchema>) =>
    reviewedOperationUpdate(writer, reviewed, "admitted")
      .set({
        decision: jsonValue(decision),
        state: refusedDecision ? "refused" : "approved",
        ...(refusedDecision
          ? { outcome: "refused", completedAt: new Date(), terminalEvidenceAt: new Date() }
          : {}),
        updatedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirst();
  // A refusal is how the operation ends: its task is published with it. An approval is not an
  // ending, and stays one plain write on the way to running it.
  const row = refusedDecision
    ? await commitPersonalMutation(database, async (tx) => {
        const refused = await decide(tx);
        if (refused) await publishOperationTasks(tx, [refused.sessionId]);
        return refused;
      })
    : await decide(database);
  return row ?? (await readAgentOperation(database, reviewed.id));
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

export function findAgentOperation(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly userId: UserId;
    readonly agentConnectionId: string;
    readonly identity: { readonly id: AgentOperationId } | { readonly key: string };
  },
) {
  const query = database
    .selectFrom("agentOperations")
    .innerJoin("agentSessions", "agentSessions.id", "agentOperations.sessionId")
    .selectAll("agentOperations")
    .select(["agentSessions.threadId as taskId", "agentSessions.status as sessionStatus"])
    .where("agentOperations.userId", "=", input.userId)
    .where("agentOperations.connectionId", "=", input.agentConnectionId);
  return (
    "id" in input.identity
      ? query.where("agentOperations.id", "=", input.identity.id)
      : query.where("agentOperations.operationKey", "=", input.identity.key)
  ).executeTakeFirst();
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
    readonly grantTarget?: AgentGrantTarget | undefined;
    readonly copy: (agent: string) => { readonly title: string; readonly summary: string };
    readonly presentation?: Extract<
      import("@opensteer/core").RequestPresentation,
      { kind: "form" }
    >;
  },
): Promise<AgentOperationRow> {
  return commitPersonalMutation(database, async (tx) => {
    const connection = await lockLiveConnection(
      tx,
      input.operation.userId,
      input.operation.connectionId,
      input.grantTarget,
    );
    if (connection.grantRevision !== input.operation.grantRevision)
      throw refused(lineageEndedMessage);
    await tx
      .selectFrom("agentSessions")
      .select("id")
      .where("id", "=", input.operation.sessionId)
      .where("status", "=", "active")
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const operation = await tx
      .selectFrom("agentOperations")
      .selectAll()
      .where("id", "=", input.operation.id)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (operation.state !== "admitted" || !sameReview(operation, input.operation)) return operation;
    const thread = await tx
      .selectFrom("threads")
      .select("accessMode")
      .where("id", "=", input.threadId)
      .executeTakeFirstOrThrow();
    if (
      !threadAccessModeAtMost(
        operation.mode,
        minThreadAccessMode(thread.accessMode, connection.accessMode),
      )
    ) {
      await refuseUnsentAgentOperation(tx, operation.id, operation.grantRevision);
      return readAgentOperation(tx, operation.id);
    }
    const reason = operation.agentReason
      ? `\n\nThe agent's own reason (its words, not checked): ${operation.agentReason}`
      : "";
    const { title, summary } = input.copy(connection.label);
    const { untrustedTitle: suppliedTitle, ...target } = operation.target;
    const titleLabel =
      target.grant.kind === "computer-app"
        ? "The app calls itself"
        : target.grant.kind === "chrome-tabs"
          ? "The page's title"
          : null;
    const untrustedTitle = suppliedTitle
      ?.replace(/[\r\n\t\u0085\p{Zl}\p{Zp}]+/gu, " ")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .trim()
      .replace(/[!-/:-@\x5b-\x60{-~]/gu, (character) =>
        String.fromCharCode(character.charCodeAt(0) + 0xfee0),
      );
    const titleLine =
      titleLabel && untrustedTitle
        ? `\n\n${titleLabel}: "${Array.from(untrustedTitle).slice(0, 160).join("")}"`
        : "";
    const detail = formatRequestOperationDetail({
      summary,
      titleLine,
      calls: operation.calls,
      reason,
    });
    const created = await requests.create(
      {
        // One Request per review round: a fresh review after a grant change asks again.
        callId: `operation:${operation.id}:${randomUUID()}`,
        kind: "person.question",
        mode: "durable",
        originatingAgentSessionId: operation.sessionId,
        originatingThreadId: input.threadId,
        payload: { kind: "person.question" },
        presentation: input.presentation ?? {
          kind: "form",
          title: title.slice(0, 200),
          detail,
          detailFormat: "plain",
          fields: [
            {
              id: operationDecisionFieldId,
              prompt: "Allow this once?",
              choices: [
                { label: "Allow once", value: operationAllow },
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
    if (!input.presentation) {
      // The Request carries the operation in its parts, so clients never parse the detail text.
      await tx
        .updateTable("requests")
        .set({
          agentOperation: jsonValue({
            operationId: operation.id,
            connectionId: operation.connectionId,
            summary: summary.slice(0, 20_000),
            calls: operation.calls,
            agentReason: operation.agentReason,
            target,
            decisionFieldId: operationDecisionFieldId,
          }),
        })
        .where("id", "=", created.request.id)
        .execute();
      await refreshRequestState(tx, created.request.id);
    }
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
): Promise<{ operation: AgentOperationRow; expired: boolean }> {
  return commitPersonalMutation(database, async (tx) => {
    const linked = await tx
      .selectFrom("agentOperations")
      .select(["id", "sessionId", "connectionId", "grantRevision"])
      .where("requestId", "=", input.requestId)
      .executeTakeFirst();
    if (!linked) throw new OpensteerError({ code: "not_found", message: "Request not found" });
    const connection = await lockLiveConnection(tx, input.resolvedBy, linked.connectionId);
    if (connection.grantRevision !== linked.grantRevision) throw refused(lineageEndedMessage);
    const session = await tx
      .selectFrom("agentSessions")
      .select(["id", "threadId"])
      .where("id", "=", linked.sessionId)
      .where("status", "=", "active")
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const operation = await tx
      .selectFrom("agentOperations")
      .selectAll()
      .where("id", "=", linked.id)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (operation.state !== "pending" || operation.requestId !== input.requestId)
      throw new OpensteerError({ code: "conflict", message: "Request is no longer pending" });
    const now = new Date();
    const expired = await pendingDirectRequests(tx)
      .where("requests.id", "=", input.requestId)
      .where("requests.createdAt", "<=", new Date(now.getTime() - agentOperationRequestLifetimeMs))
      .executeTakeFirst();
    if (expired) {
      const [closed] = await closeDirectRequests(tx, [expired], now, true);
      return { operation: closed!, expired: true };
    }
    const thread = await tx
      .selectFrom("threads")
      .select(["accessMode", "originConnectionId"])
      .where("id", "=", session.threadId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await assertRequestOriginMayContinue(tx, input.resolvedBy, {
      connectionId: linked.connectionId,
      threadOriginConnectionId: thread.originConnectionId,
    });
    if (operation.mode !== minThreadAccessMode(thread.accessMode, connection.accessMode))
      throw refused(lineageEndedMessage);
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
    const question = operation.tool === "ask_person";
    const decline =
      input.response.kind === "external" && input.response.value?.decision === "declined";
    let allowedResponse: boolean;
    if (question && !decline) {
      const field = row.presentation?.kind === "form" ? row.presentation.fields[0] : undefined;
      const response = input.response;
      const answers = field && response.kind === "form" ? response.answers[field.id] : undefined;
      if (
        !field ||
        response.kind !== "form" ||
        Object.keys(response.answers).length !== 1 ||
        answers?.length !== 1 ||
        !field.choices?.some(({ value }) => value === answers[0])
      )
        throw new OpensteerError({
          code: "bad_request",
          message:
            "Choose an answer shown on the Request. Enter passwords or codes only in the page.",
        });
      allowedResponse = true;
    } else {
      const choice =
        input.response.kind === "form"
          ? input.response.answers[operationDecisionFieldId]?.[0]
          : decline
            ? operationDeny
            : undefined;
      if (choice !== operationAllow && choice !== operationDeny)
        throw new OpensteerError({
          code: "bad_request",
          message: "Choose Allow once or Don't allow.",
        });
      allowedResponse = choice === operationAllow;
    }
    assertRequestRevision(row, input.expectedRevision);
    const allowed = allowedResponse && operation.state === "pending";
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
    await projectThreadState(tx, session.threadId);
    const decided = await reviewedOperationUpdate(tx, operation, "pending")
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
              terminalEvidenceAt: now,
              decision: jsonValue({
                by: "refused",
                reason: "person",
                message: "The person did not allow it.",
              } satisfies AgentOperationDecision),
              updatedAt: now,
            },
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    if (!allowed) await publishOperationTasks(tx, [decided.sessionId]);
    return { operation: decided, expired: false };
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
    readonly reviewed: ReviewedOperation;
    readonly grantTarget?: AgentGrantTarget | undefined;
    readonly pool?:
      | {
          readonly target: BrowserPoolTargetIdentity;
          readonly signal: AbortSignal;
        }
      | undefined;
  },
): Promise<AgentOperationRow | null> {
  return commitPersonalMutation(database, async (tx) => {
    const pool = input.pool;
    if (pool) {
      pool.signal.throwIfAborted();
      await requireBrowserPoolAdmission(tx, pool.target.runnerId, pool.target);
    }
    const connection = await lockLiveConnection(
      tx,
      input.userId,
      input.agentConnectionId,
      input.grantTarget,
    );
    const operation = await tx
      .selectFrom("agentOperations")
      .innerJoin("agentSessions", "agentSessions.id", "agentOperations.sessionId")
      .innerJoin("threads", "threads.id", "agentSessions.threadId")
      .select([
        "agentOperations.grantRevision",
        "agentOperations.mode",
        "agentSessions.status",
        "threads.accessMode",
      ])
      .where("agentOperations.id", "=", input.reviewed.id)
      .where("agentOperations.connectionId", "=", connection.id)
      .executeTakeFirstOrThrow();
    if (
      operation.status !== "active" ||
      operation.grantRevision !== connection.grantRevision ||
      operation.mode !== minThreadAccessMode(operation.accessMode, connection.accessMode)
    )
      return null;
    pool?.signal.throwIfAborted();
    const handed =
      (await approvedOperationUpdate(tx, input.reviewed)
        .set({ state: "handed-off", handedOffAt: new Date(), updatedAt: new Date() })
        .returningAll()
        .executeTakeFirst()) ?? null;
    return handed;
  });
}

type ReviewedOperation = Pick<
  AgentOperationRow,
  "id" | "grantRevision" | "mode" | "requestId" | "target" | "targetGeneration"
>;

function approvedOperationUpdate(database: Kysely<DatabaseSchema>, reviewed: ReviewedOperation) {
  return reviewedOperationUpdate(database, reviewed, "approved");
}

function sameReview(current: ReviewedOperation, reviewed: ReviewedOperation) {
  return (
    current.grantRevision === reviewed.grantRevision &&
    current.mode === reviewed.mode &&
    current.targetGeneration === reviewed.targetGeneration &&
    current.requestId === reviewed.requestId
  );
}

function reviewedOperationUpdate(
  database: Kysely<DatabaseSchema>,
  reviewed: ReviewedOperation,
  state: AgentOperationState,
) {
  return database
    .updateTable("agentOperations")
    .where("id", "=", reviewed.id)
    .where("state", "=", state)
    .where("grantRevision", "=", reviewed.grantRevision)
    .where("mode", "=", reviewed.mode)
    .where("requestId", reviewed.requestId === null ? "is" : "=", reviewed.requestId)
    .where(
      "targetGeneration",
      reviewed.targetGeneration === null ? "is" : "=",
      reviewed.targetGeneration,
    )
    .where("target", "=", jsonValue(reviewed.target));
}

/** An approved operation whose authority changed before hand-off needs a fresh review. */
export async function reopenAgentOperation(
  database: Kysely<DatabaseSchema>,
  reviewed: ReviewedOperation,
  facts: Pick<ReviewedOperation, "grantRevision" | "mode" | "target" | "targetGeneration">,
): Promise<AgentOperationRow | null> {
  return (
    (await approvedOperationUpdate(database, reviewed)
      .set({
        state: "admitted",
        decision: null,
        requestId: null,
        grantRevision: facts.grantRevision,
        mode: facts.mode,
        target: jsonValue(facts.target),
        targetGeneration: facts.targetGeneration,
        updatedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirst()) ?? null
  );
}

export async function refuseUnsentAgentOperation(
  database: Kysely<DatabaseSchema>,
  id: AgentOperationId,
  grantRevision: number,
  /** Why nothing was sent, as the agent was told it; an authority change when not given. */
  refusal: {
    readonly message: string;
    readonly reason: "authority" | "changed" | "stopped";
    readonly ending?: AgentOperationEnding | null;
  } = { message: "The connected agent's access changed or ended.", reason: "authority" },
): Promise<void> {
  await commitPersonalMutation(database, async (tx) => {
    const now = new Date();
    const refused = await tx
      .updateTable("agentOperations")
      .set({
        state: "refused",
        outcome: "refused",
        ending: refusal.ending ?? null,
        terminalEvidenceAt: now,
        completedAt: now,
        updatedAt: now,
        decision: jsonValue({
          by: "refused",
          reason: refusal.reason,
          message: refusal.message,
        } satisfies AgentOperationDecision),
      })
      .where("id", "=", id)
      .where("grantRevision", "=", grantRevision)
      .where("state", "in", ["admitted", "pending", "approved"])
      .where("handedOffAt", "is", null)
      .returning("sessionId")
      .executeTakeFirst();
    if (refused) await publishOperationTasks(tx, [refused.sessionId]);
  });
}

/**
 * An operation that was handed off but whose every command was refused before it
 * reached the wire: nothing happened, so it is refused, not failed or unknown.
 */
export async function refuseUnsentHandedOffAgentOperation(
  database: Kysely<DatabaseSchema>,
  id: AgentOperationId,
  message: string,
  reason: "authority" | "changed" | "stopped",
  ending: AgentOperationEnding | null = null,
): Promise<boolean> {
  return commitPersonalMutation(database, async (tx) => {
    const now = new Date();
    const row = await tx
      .updateTable("agentOperations")
      .set({
        state: "refused",
        outcome: "refused",
        ending,
        terminalEvidenceAt: now,
        completedAt: now,
        updatedAt: now,
        decision: jsonValue({
          by: "refused",
          reason,
          message,
        } satisfies AgentOperationDecision),
      })
      .where("id", "=", id)
      .where("state", "=", "handed-off")
      .returning("sessionId")
      .executeTakeFirst();
    if (row) await publishOperationTasks(tx, [row.sessionId]);
    return row !== undefined;
  });
}

/**
 * The terminal outcome of a handed-off operation; `unknown` is never retried. An unknown one
 * carries why it ended where the Home knows it (`ending`); the evidence a Disconnect reads
 * (`terminalEvidenceAt`, `contactLostAt`) is the same whatever the cause.
 */
export async function settleAgentOperation(
  database: Kysely<DatabaseSchema>,
  id: AgentOperationId,
  outcome: Exclude<AgentOperationOutcome, "refused">,
  summary: Readonly<Record<string, unknown>> | null,
  ending: AgentOperationEnding | null = null,
): Promise<AgentOperationRow | null> {
  const state: AgentOperationState = outcome;
  return commitPersonalMutation(database, async (tx) => {
    const settled =
      (await tx
        .updateTable("agentOperations")
        .set({
          state,
          outcome,
          completedAt: new Date(),
          updatedAt: new Date(),
          // The executor ran in this process and has returned: that is the end of the attempt.
          terminalEvidenceAt: new Date(),
          ...(outcome === "unknown" ? { contactLostAt: new Date(), ending } : {}),
          resultSummary: summary ? jsonValue(summary) : null,
        })
        .where("id", "=", id)
        .where("state", "=", "handed-off")
        .returningAll()
        // Its task, in the same statement: the publish needs no read of its own.
        .returning((eb) =>
          eb
            .selectFrom("agentSessions")
            .select("agentSessions.threadId")
            .whereRef("agentSessions.id", "=", "agentOperations.sessionId")
            .as("taskId"),
        )
        .executeTakeFirst()) ?? null;
    if (!settled) return null;
    const { taskId, ...row } = settled;
    if (taskId) await publishThreadSummary(tx, taskId);
    return row;
  });
}

/**
 * Publishes again the tasks these sessions work: a page showing a task reads its operations again
 * when the Home publishes it, so every change to what an operation shows is published with it.
 */
export async function publishOperationTasks(
  tx: Transaction<DatabaseSchema>,
  sessionIds: readonly AgentSessionId[],
): Promise<void> {
  if (!sessionIds.length) return;
  const tasks = await tx
    .selectFrom("agentSessions")
    .select("threadId")
    .distinct()
    .where("id", "in", [...new Set(sessionIds)])
    .orderBy("threadId")
    .execute();
  for (const { threadId } of tasks) await publishThreadSummary(tx, threadId);
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
  return commitPersonalMutation(database, async (tx) => {
    const settled = await tx
      .updateTable("agentOperations")
      .set({
        state: "unknown",
        outcome: "unknown",
        completedAt: new Date(),
        updatedAt: new Date(),
        // The process that handed it off is gone, so it can do nothing more; its effect is unknown.
        terminalEvidenceAt: new Date(),
        contactLostAt: new Date(),
      })
      .where("id", "in", orphans)
      .where("state", "=", "handed-off")
      .returning("sessionId")
      .execute();
    await publishOperationTasks(
      tx,
      settled.map(({ sessionId }) => sessionId),
    );
    return settled.length;
  });
}

/** A connection's or a task's operations, newest first, paged by (createdAt, id). */
export async function listAgentOperations(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly userId: UserId;
    readonly connectionId?: string;
    readonly threadId?: ThreadId;
    readonly limit: number;
    readonly before?: { readonly createdAt: Date; readonly id: string };
  },
) {
  let query = database
    .selectFrom("agentOperations")
    .innerJoin("agentSessions", "agentSessions.id", "agentOperations.sessionId")
    .selectAll("agentOperations")
    .select("agentSessions.threadId")
    .where("agentOperations.userId", "=", input.userId);
  if (input.connectionId)
    query = query.where("agentOperations.connectionId", "=", input.connectionId);
  if (input.threadId) query = query.where("agentSessions.threadId", "=", input.threadId);
  if (input.before) {
    const { createdAt, id } = input.before;
    query = query.where(
      sql<boolean>`(agent_operations.created_at, agent_operations.id) < (${createdAt}, ${id})`,
    );
  }
  const rows = await query
    .orderBy("agentOperations.createdAt", "desc")
    .orderBy("agentOperations.id", "desc")
    .limit(input.limit + 1)
    .execute();
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    operations: page.map((row): AgentOperationView => ({
      id: row.id,
      sessionId: row.sessionId,
      taskId: row.threadId,
      tool: row.tool,
      target: row.target,
      mode: row.mode,
      effect: row.effect,
      state: row.state,
      decision: row.decision,
      outcome: row.outcome,
      ending: row.ending,
      requestId: row.requestId,
      createdAt: row.createdAt.toISOString(),
      handedOffAt: row.handedOffAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    })),
    nextBefore:
      rows.length > input.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
  };
}

/** A `nextBefore` cursor from a listing, or undefined for the first page. */
export function agentOperationCursor(
  before: string | undefined,
): { readonly createdAt: Date; readonly id: string } | undefined {
  if (!before) return undefined;
  const [at, id] = before.split("|");
  const createdAt = new Date(at ?? "");
  if (!id || Number.isNaN(createdAt.getTime()))
    throw new OpensteerError({
      code: "bad_request",
      message: "That cursor is not from this list.",
    });
  return { createdAt, id };
}
