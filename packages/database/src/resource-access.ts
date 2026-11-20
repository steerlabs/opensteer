import { applyConnectionPolicy } from "./work-policy.js";
import { isWorkHomeDatabase } from "./work-home-context.js";
import { integrationAccessCeilingForRun } from "@opensteer/integration-core/effective-grants";
import { assertPersonalOwner } from "./private-resource-owner.js";
import {
  AgentGrantSchema,
  AgentSessionIdSchema,
  RunIdSchema,
  threadAccessModeAtMost,
  ThreadIdSchema,
  TriggerOccurrenceIdSchema,
  TriggerWatchActivationIdSchema,
  agentGrantAccess,
  agentGrantAllowsTasks,
  intersectResourceAccess,
  minThreadAccessMode,
  OpensteerError,
  type AgentGrant,
  type AgentGrantTarget,
  type ResourceAccessLevel,
  type RunId,
  type ThreadAccessMode,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/**
 * Who an effect is for. A binding names an execution the Home issued (`run:`, `trigger:`,
 * `watch:`, `thread:`; agent sessions add `session:`). Its facts are read here, never taken from
 * the caller.
 */
export type AuthoritySubject =
  | { readonly kind: "person" }
  | { readonly kind: "connection"; readonly agentConnectionId: string }
  | { readonly kind: "binding"; readonly bindingId: string };

/** The external agent connection an execution works for, as it stands now. */
export interface AgentConnectionAuthority {
  readonly agentConnectionId: string;
  readonly grant: AgentGrant;
  readonly grantRevision: number;
  readonly consentVersion: number;
  readonly accessMode: ThreadAccessMode;
}

/** One execution as the Home resolved it: whom it works for and every mode in its lineage. */
export interface ExecutionAuthority {
  readonly ownerUserId: UserId;
  readonly subject: AuthoritySubject;
  /**
   * Who acts, proven by the row that authenticated it: the person, a native execution of the
   * person, or an execution working for an agent connection. Anything else was refused.
   */
  readonly actor: "person" | "native" | "agent";
  readonly threadId: ThreadId | null;
  readonly runId: RunId | null;
  /** Absent for the person's own work. */
  readonly agentConnection: AgentConnectionAuthority | null;
  readonly taskMode: ThreadAccessMode | null;
  /** The Run's own snapshot, for a Run binding while that Run is active. */
  readonly runMode: ThreadAccessMode | null;
  /** The minimum of every mode in the lineage; the person's own work keeps its legacy rule. */
  readonly mode: ThreadAccessMode;
}

const activeRunStatuses = ["queued", "starting", "running", "waiting"] as const;

function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}
export const lineageEndedMessage =
  "This connected agent's access ended. The person can reconnect it from Connected agents.";
export const tasksWithdrawnMessage = "This connected agent may no longer ask your agents to work.";

export async function readLiveAgentConnectionRow(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
  lock = false,
) {
  const query = database
    .selectFrom("agentConnections")
    .select(["id", "label", "grant", "grantRevision", "consentVersion", "accessMode", "cleanupMinimumGrantRevision", "cleanupMaximumMode"])
    .where("id", "=", agentConnectionId)
    .where("userId", "=", ownerUserId)
    .where("revokedAt", "is", null)
    .where("tokenHash", "is not", null)
    .where("expiresAt", ">", new Date());
  const authority = lock ? query.forShare("agentConnections") : query;
  if (!isWorkHomeDatabase(database)) return authority.executeTakeFirst();
  const row = await authority
    .innerJoin("workHomePolicy", (join) => join.on("workHomePolicy.singleton", "=", true))
    .select(["workHomePolicy.policy", "workHomePolicy.state"])
    .executeTakeFirst();
  if (!row) return undefined;
  const { policy, state, ...connection } = row;
  return { ...connection, accessMode: applyConnectionPolicy({ policy, state }, row.grant, row.accessMode) };
}

/** The live connection, or a refusal: a revoked or expired connection has no authority. */
export async function liveAgentConnection(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
): Promise<AgentConnectionAuthority & {
  readonly cleanupMinimumGrantRevision: number | null;
  readonly cleanupMaximumMode: ThreadAccessMode | null;
}> {
  const row = await readLiveAgentConnectionRow(database, ownerUserId, agentConnectionId);
  if (!row) throw forbidden(lineageEndedMessage);
  const grant = AgentGrantSchema.parse(row.grant);
  return {
    agentConnectionId: row.id,
    grant,
    grantRevision: row.grantRevision,
    consentVersion: row.consentVersion,
    accessMode: row.accessMode,
    cleanupMinimumGrantRevision: row.cleanupMinimumGrantRevision,
    cleanupMaximumMode: row.cleanupMaximumMode,
  };
}

/** The connection delegated work may still run for: live, and still granted Tasks. */
export async function liveDelegatingConnection(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
) {
  const connection = await liveAgentConnection(database, ownerUserId, agentConnectionId);
  if (!agentGrantAllowsTasks(connection.grant)) throw forbidden(tasksWithdrawnMessage);
  return connection;
}

export function meetsConnectionFloor(
  connection: Awaited<ReturnType<typeof liveAgentConnection>>,
  revision: number | null,
  mode: ThreadAccessMode | null,
): boolean {
  const floor = connection.cleanupMinimumGrantRevision;
  return floor === null || (revision !== null && (revision > floor ||
    (revision === floor && (connection.cleanupMaximumMode === null ||
      (mode !== null && threadAccessModeAtMost(mode, connection.cleanupMaximumMode))))));
}

/**
 * The one send rule, applied at send, at dequeue, at every follow-up claim and before a provider
 * session is chosen: work for a connection enters, and keeps running in, only its own lineage's
 * tasks, or the person's own tasks when its grant is `everything`. Native work and the person may
 * use any of the person's tasks.
 */
export function sendEligible(
  connection: Pick<AgentConnectionAuthority, "agentConnectionId" | "grant"> | null,
  taskOriginConnectionId: string | null,
): boolean {
  if (!connection) return true;
  if (taskOriginConnectionId === connection.agentConnectionId) return true;
  return taskOriginConnectionId === null && connection.grant.scope === "everything";
}

/** The send rule against the connection as it stands now; refuses as an unknown task would. */
export async function assertSendEligible(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  taskOriginConnectionId: string | null,
  agentConnectionId: string | null,
): Promise<AgentConnectionAuthority | null> {
  if (!agentConnectionId) return null;
  const connection = await liveAgentConnection(database, ownerUserId, agentConnectionId);
  if (!sendEligible(connection, taskOriginConnectionId)) throw forbidden("Task is unavailable");
  return connection;
}

/**
 * A binding's immutable connection, read before any lock is taken: a Run's own, a task's origin,
 * an automation's origin or a session's. Null only for a native execution of the person; a binding
 * that names nothing, or whose Run and task disagree, is refused rather than read as the person's.
 */
export async function bindingAgentConnectionId(
  database: Kysely<DatabaseSchema>,
  bindingId: string,
): Promise<string | null> {
  const facts = await bindingFacts(database, bindingId);
  if (!facts || facts.inconsistent) throw forbidden("Task authority is no longer available");
  return facts.agentConnectionId;
}

interface BindingFacts {
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly agentConnectionId: string | null;
  /** The execution the binding names is still running (or queued, or active). */
  readonly live: boolean;
  /** Its own lineage and its task's disagree: neither may be assumed. */
  readonly inconsistent: boolean;
  readonly createdBy: UserId;
  readonly taskMode: ThreadAccessMode;
  /** A Run binding's own snapshot, from the same read. */
  readonly runMode: ThreadAccessMode | null;
}

/** Every fact a binding needs, in one read of the row that names it joined to its task. */
async function bindingFacts(
  database: Kysely<DatabaseSchema>,
  bindingId: string,
): Promise<BindingFacts | null> {
  const task = ["threads.createdBy", "threads.accessMode as taskMode"] as const;
  if (bindingId.startsWith("run:")) {
    const runId = RunIdSchema.parse(bindingId.slice(4));
    const row = await database
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select([
        ...task,
        "runs.threadId",
        "runs.connectionId",
        "runs.status",
        "runs.accessMode",
        "threads.originConnectionId",
      ])
      .where("runs.id", "=", runId)
      .executeTakeFirst();
    return row
      ? {
          threadId: row.threadId,
          runId,
          agentConnectionId: row.connectionId,
          live: (activeRunStatuses as readonly string[]).includes(row.status),
          // A task in a lineage only ever runs work of that lineage.
          inconsistent:
            row.originConnectionId !== null && row.connectionId !== row.originConnectionId,
          createdBy: row.createdBy,
          taskMode: row.taskMode,
          runMode: row.accessMode,
        }
      : null;
  }
  if (bindingId.startsWith("session:")) {
    const row = await database
      .selectFrom("agentSessions")
      .innerJoin("threads", "threads.id", "agentSessions.threadId")
      .select([
        ...task,
        "agentSessions.threadId",
        "agentSessions.connectionId",
        "agentSessions.status",
      ])
      .where("agentSessions.id", "=", AgentSessionIdSchema.parse(bindingId.slice(8)))
      .executeTakeFirst();
    return row
      ? {
          threadId: row.threadId,
          runId: null,
          agentConnectionId: row.connectionId,
          live: row.status === "active",
          inconsistent: false,
          createdBy: row.createdBy,
          taskMode: row.taskMode,
          runMode: null,
        }
      : null;
  }
  if (bindingId.startsWith("thread:")) {
    const threadId = ThreadIdSchema.parse(bindingId.slice(7));
    const row = await database
      .selectFrom("threads")
      .select([...task, "originConnectionId"])
      .where("id", "=", threadId)
      .executeTakeFirst();
    if (!row) return null;
    // A task binding speaks for the task's own lineage; an active Run of another lineage on it
    // makes "the task's work" ambiguous, so it is refused rather than given the task's authority.
    const runs = await database
      .selectFrom("runs")
      .select(["connectionId", "accessMode"])
      .where("threadId", "=", threadId)
      .where("requestedBy", "=", row.createdBy)
      .where("status", "in", activeRunStatuses)
      .orderBy("createdAt", "desc")
      .execute();
    return {
      threadId,
      runId: null,
      agentConnectionId: row.originConnectionId,
      live: true,
      inconsistent: runs.some(({ connectionId }) => connectionId !== row.originConnectionId),
      createdBy: row.createdBy,
      taskMode: row.taskMode,
      runMode: runs[0]?.accessMode ?? null,
    };
  }
  const row = bindingId.startsWith("trigger:")
    ? await database
        .selectFrom("triggerOccurrences")
        .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
        .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
        .select([
          ...task,
          "triggers.anchorThreadId",
          "triggers.originConnectionId",
          sql<boolean>`trigger_occurrences.status in ('pending', 'running')`.as("live"),
        ])
        .where("triggerOccurrences.id", "=", TriggerOccurrenceIdSchema.parse(bindingId.slice(8)))
        .executeTakeFirst()
    : bindingId.startsWith("watch:")
      ? await database
          .selectFrom("triggerWatchActivations")
          .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
          .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
          .select([
            ...task,
            "triggers.anchorThreadId",
            "triggers.originConnectionId",
            sql<boolean>`trigger_watch_activations.desired = 'active'
              and trigger_watch_activations.observed not in ('expired', 'stopped')`.as("live"),
          ])
          .where(
            "triggerWatchActivations.id",
            "=",
            TriggerWatchActivationIdSchema.parse(bindingId.slice(6)),
          )
          .executeTakeFirst()
      : undefined;
  return row
    ? {
        threadId: row.anchorThreadId,
        runId: null,
        agentConnectionId: row.originConnectionId,
        live: row.live,
        inconsistent: false,
        createdBy: row.createdBy,
        taskMode: row.taskMode,
        runMode: null,
      }
    : null;
}

/**
 * Is this execution still allowed at all? Resolves the subject server-side and intersects every
 * live mode in its lineage; when nothing resolves the answer is a refusal, never `full-access`.
 * A supplied thread must be the binding's own. It says nothing about any concrete resource:
 * ask `authorizeTarget` for that.
 */
export async function admitExecution(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerUserId: UserId;
    readonly subject: AuthoritySubject;
    readonly threadId?: ThreadId | undefined;
  },
): Promise<ExecutionAuthority> {
  await assertPersonalOwner(database, input.ownerUserId);
  const { subject, ownerUserId } = input;
  const base = { ownerUserId, subject, runId: null, runMode: null } as const;
  if (subject.kind === "person") {
    const task = input.threadId ? await ownedThread(database, input.threadId, ownerUserId) : null;
    return {
      ...base,
      threadId: input.threadId ?? null,
      actor: "person",
      agentConnection: null,
      taskMode: task?.accessMode ?? null,
      mode: "full-access",
    };
  }
  if (subject.kind === "connection") {
    const connection = await liveAgentConnection(database, ownerUserId, subject.agentConnectionId);
    let taskMode: ThreadAccessMode | null = null;
    if (input.threadId) {
      const thread = await ownedThread(database, input.threadId, ownerUserId);
      if (
        connection.grant.scope === "selected" &&
        thread.originConnectionId !== connection.agentConnectionId
      )
        throw forbidden("Task is unavailable");
      taskMode = thread.accessMode;
    }
    return {
      ...base,
      threadId: input.threadId ?? null,
      actor: "agent",
      agentConnection: connection,
      taskMode,
      mode: connection.accessMode,
    };
  }
  const facts = await bindingFacts(database, subject.bindingId);
  // Owner means a known owner: an unknown, ended or inconsistent execution is refused.
  if (
    !facts ||
    !facts.live ||
    facts.inconsistent ||
    facts.createdBy !== ownerUserId ||
    (input.threadId && input.threadId !== facts.threadId)
  )
    throw forbidden("Task authority is no longer available");
  const execution = {
    ...base,
    threadId: facts.threadId,
    runId: facts.runId,
    taskMode: facts.taskMode,
    runMode: facts.runMode,
  };
  if (!facts.agentConnectionId)
    return {
      ...execution,
      actor: "native",
      agentConnection: null,
      mode: facts.runMode ?? facts.taskMode,
    };
  // A session acts directly and needs no Tasks switch; delegated work needs it.
  const session = subject.bindingId.startsWith("session:");
  const connection = session
    ? await liveAgentConnection(database, ownerUserId, facts.agentConnectionId)
    : await liveDelegatingConnection(database, ownerUserId, facts.agentConnectionId);
  if (session && !directOperationsAllowed(connection))
    throw forbidden("This connected agent was approved before direct work.");
  return {
    ...execution,
    actor: "agent",
    agentConnection: connection,
    mode: minThreadAccessMode(connection.accessMode, facts.taskMode, facts.runMode),
  };
}

async function ownedThread(database: Kysely<DatabaseSchema>, id: ThreadId, owner: UserId) {
  const thread = await database
    .selectFrom("threads")
    .select(["createdBy", "accessMode", "originConnectionId"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!thread || thread.createdBy !== owner)
    throw forbidden("Task authority is no longer available");
  return thread;
}

/**
 * May this admitted execution touch this concrete resource? The grant's ceiling only: the
 * owner's own approval, its access level and the Device switch are intersected by the caller.
 */
export function authorizeTarget(
  execution: Pick<ExecutionAuthority, "actor" | "agentConnection">,
  target: AgentGrantTarget,
): ResourceAccessLevel | null {
  // The person, or a native execution proven by its own row, reaches everything they own.
  if (execution.actor === "agent")
    return execution.agentConnection
      ? agentGrantAccess(execution.agentConnection.grant, target)
      : null;
  return execution.actor === "person" || execution.actor === "native" ? "read-write" : null;
}

/**
 * Direct operations need a consent the person made on the grant screen. A connection that kept
 * its old `everything` at consent version 1 may delegate as before, but not act directly.
 */
export function directOperationsAllowed(connection: AgentConnectionAuthority): boolean {
  return connection.consentVersion >= 2;
}

/** Whether an admitted execution reaches only what its connection's grant names. */
export function selectedGrantOf(
  execution: Pick<ExecutionAuthority, "agentConnection">,
): Extract<AgentGrant, { scope: "selected" }> | null {
  const grant = execution.agentConnection?.grant;
  return grant?.scope === "selected" ? grant : null;
}

export interface ResourceAccessInput {
  readonly ownerUserId: UserId;
  readonly agentConnectionId?: string;
  /** Never an integration connection: an external agent is named `agentConnectionId`. */
  readonly connectionId?: never;
  readonly threadId?: ThreadId | undefined;
  readonly agentBindingId?: string;
  readonly explicitAccess?: ResourceAccessLevel | null;
  readonly connectionCeiling?: ResourceAccessLevel | null;
  /** The concrete thing the effect touches. Without one, a `selected` grant is refused. */
  readonly grantTarget?: AgentGrantTarget;
}

export function authoritySubject(input: {
  readonly agentConnectionId?: string | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly agentBindingId?: string | undefined;
}): AuthoritySubject {
  if (input.agentBindingId) return { kind: "binding", bindingId: input.agentBindingId };
  if (input.agentConnectionId)
    return { kind: "connection", agentConnectionId: input.agentConnectionId };
  if (input.threadId) return { kind: "binding", bindingId: `thread:${input.threadId}` };
  return { kind: "person" };
}

/** Both questions at once, for a caller with one concrete target in hand. */
export async function resolveResourceAccess(
  database: Kysely<DatabaseSchema>,
  input: ResourceAccessInput,
) {
  const execution = await admitExecution(database, {
    ownerUserId: input.ownerUserId,
    subject: authoritySubject(input),
    ...(input.threadId && (input.agentBindingId || input.agentConnectionId)
      ? { threadId: input.threadId }
      : {}),
  });
  const runAccess = executionAccessCeiling(execution);
  const grantAccess = input.grantTarget
    ? authorizeTarget(execution, input.grantTarget)
    : selectedGrantOf(execution)
      ? null
      : "read-write";
  return {
    execution,
    runAccess,
    grantAccess,
    access: intersectResourceAccess(
      intersectResourceAccess(
        intersectResourceAccess(input.explicitAccess ?? null, input.connectionCeiling),
        runAccess,
      ),
      grantAccess,
    ),
  };
}

/** The execution's structural read/write ceiling, with no resource implied. */
export function executionAccess(
  execution: Pick<ExecutionAuthority, "mode" | "subject">,
  explicitAccess: ResourceAccessLevel | null = "read-write",
): ResourceAccessLevel | null {
  return intersectResourceAccess(explicitAccess, executionAccessCeiling(execution));
}

function executionAccessCeiling(execution: Pick<ExecutionAuthority, "mode" | "subject">) {
  // The session pipeline already decides each effect before hand-off.
  if (execution.subject.kind === "binding" && execution.subject.bindingId.startsWith("session:"))
    return "read-write";
  return integrationAccessCeilingForRun(execution.mode);
}

export async function assertLineageCompatibleReuse(
  database: Kysely<DatabaseSchema>,
  callerId: ThreadId,
  targetId: ThreadId,
): Promise<void> {
  const rows = await database
    .selectFrom("threads")
    .select(["id", "createdBy", "accessMode", "originConnectionId"])
    .where("id", "in", [callerId, targetId])
    .execute();
  const caller = rows.find((row) => row.id === callerId);
  const target = rows.find((row) => row.id === targetId);
  if (
    !caller ||
    !target ||
    caller.createdBy !== target.createdBy ||
    !threadAccessModeAtMost(target.accessMode, caller.accessMode) ||
    caller.originConnectionId !== target.originConnectionId
  )
    throw new OpensteerError({ code: "forbidden", message: "Start a new task for this work" });
  await assertPersonalOwner(database, caller.createdBy);
}
