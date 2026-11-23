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
import { sql, type Kysely, type RawBuilder } from "kysely";
import type { BridgeSenders, DatabaseSchema } from "./schema.js";
import { connectionState } from "./connection-liveness.js";

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
  /**
   * Who may speak to a messaging bridge; null for an MCP connection. Work descending from a
   * bridge anyone in its conversation may speak to runs without the person's personal context.
   */
  readonly bridgeSenders?: BridgeSenders | null;
}

/** Whether work in this lineage may use the person's personal context (memory, tabs, apps). */
export function lineageAllowsPersonalContext(
  connection: Pick<AgentConnectionAuthority, "bridgeSenders"> | null,
): boolean {
  return connection?.bridgeSenders !== "anyone";
}

/**
 * Whether work in this lineage may use the person's personal context, from its connection's own
 * row. The person's own work reads nothing: it has no connection, and always has it.
 */
export async function lineagePersonalContext(
  database: Kysely<DatabaseSchema>,
  connectionId: string | null,
): Promise<boolean> {
  if (connectionId === null) return true;
  const { rows } = await sql<{ personal: boolean }>`
    select ${lineageHasPersonalContext(sql`${connectionId}::text`)} as personal
  `.execute(database);
  return rows[0]?.personal === true;
}

/**
 * The one rule, as SQL over a lineage's connection id (null: the person's own work): personal
 * context only where no bridge anyone may speak to is the lineage. Every reader of the rule (a
 * Run, a session, the memory passes' sources) asks it here.
 */
export function lineageHasPersonalContext(connectionId: RawBuilder<unknown>): RawBuilder<boolean> {
  return sql<boolean>`(${connectionId} is null or exists (
    select 1 from agent_connections personal_lineage
    where personal_lineage.id = ${connectionId}
      and personal_lineage.bridge_senders is distinct from 'anyone'))`;
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
export const tasksWithdrawnMessage =
  "This connected agent may no longer ask your own agents to work.";
/** The same refusal for a chat; it is recorded with the message the chat sent. */
export const chatTasksWithdrawnMessage = "This chat may no longer ask your own agents to work.";

interface ConnectionTargetCheck {
  readonly grantTarget?: AgentGrantTarget | undefined;
  readonly writeTargetName?: string | undefined;
}

/**
 * The one statement for where a connection stands: its row and its state (`connectionState`).
 * Every reader of a connection's standing is a view of this (`readConnectionRowStanding`,
 * `liveAgentConnection`, `delegatingConnectionStanding`).
 */
async function readConnectionStanding(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
  lock: boolean,
) {
  const query = database
    .selectFrom("agentConnections")
    .select([
      "id",
      "label",
      "grant",
      "grantRevision",
      "consentVersion",
      "accessMode",
      "cleanupMinimumGrantRevision",
      "cleanupMaximumMode",
      "bridgeSenders",
      "bridgeAccountId",
      connectionState().as("connectionState"),
    ])
    .where("id", "=", agentConnectionId)
    .where("userId", "=", ownerUserId);
  const row = await (lock ? query.forShare("agentConnections") : query).executeTakeFirst();
  if (!row) return undefined;
  const { connectionState: state, ...connection } = row;
  return { connection, state };
}

/**
 * The refusal for work whose connection is a chat that is only waiting (its account paused or
 * needing attention), from the same read that found it not live: the caller holds the work
 * rather than refuse it, and never asks a second time.
 */
export class ConnectionWaiting extends OpensteerError {
  constructor() {
    super({ code: "forbidden", message: lineageEndedMessage });
  }
}

/** Whether a refusal says its connection is a chat that waits (`ConnectionWaiting`). */
export function connectionIsWaiting(error: unknown): boolean {
  return error instanceof ConnectionWaiting;
}

/**
 * A live connection's row, or, from the same statement, whether one that is not live is a chat
 * that waits: live, waiting or ended, answered once.
 */
export async function readConnectionRowStanding(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
  lock = false,
  { grantTarget, writeTargetName }: ConnectionTargetCheck = {},
) {
  const read = await readConnectionStanding(database, ownerUserId, agentConnectionId, lock);
  if (!read || read.state !== "live") return { row: undefined, waiting: read?.state === "waiting" };
  const row = read.connection;
  const access = grantTarget && agentGrantAccess(row.grant, grantTarget);
  if (access === null)
    throw new OpensteerError({ code: "not_found", message: "That item is unavailable." });
  if (access === "read" && writeTargetName !== undefined)
    throw forbidden(`${writeTargetName} is shared for reading only.`);
  return { row, waiting: false };
}

export async function readLiveAgentConnectionRow(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
  lock = false,
  target: ConnectionTargetCheck = {},
) {
  return (await readConnectionRowStanding(database, ownerUserId, agentConnectionId, lock, target))
    .row;
}

/** The live connection, or a refusal: a revoked or expired connection has no authority. */
export async function liveAgentConnection(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
  target?: ConnectionTargetCheck,
): Promise<
  AgentConnectionAuthority & {
    readonly cleanupMinimumGrantRevision: number | null;
    readonly cleanupMaximumMode: ThreadAccessMode | null;
  }
> {
  const { row, waiting } = await readConnectionRowStanding(
    database,
    ownerUserId,
    agentConnectionId,
    false,
    target,
  );
  if (!row) throw waiting ? new ConnectionWaiting() : forbidden(lineageEndedMessage);
  const grant = AgentGrantSchema.parse(row.grant);
  return {
    agentConnectionId: row.id,
    grant,
    grantRevision: row.grantRevision,
    consentVersion: row.consentVersion,
    accessMode: row.accessMode,
    bridgeSenders: row.bridgeSenders,
    cleanupMinimumGrantRevision: row.cleanupMinimumGrantRevision,
    cleanupMaximumMode: row.cleanupMaximumMode,
  };
}

/**
 * Which of the person's tasks a connected agent may read: all of them with `everything`, its own
 * lineage with a `selected` grant. Refused once the grant no longer holds Tasks or the caller's
 * mode is above the connection's.
 */
export async function connectionTaskReadScope(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly userId: UserId;
    readonly connectionId: string;
    readonly accessMode: ThreadAccessMode;
  },
  refusal = "Task is unavailable",
): Promise<"everything" | "selected"> {
  const { grant, accessMode } = await liveAgentConnection(
    database,
    input.userId,
    input.connectionId,
  );
  if (!agentGrantAllowsTasks(grant) || !threadAccessModeAtMost(input.accessMode, accessMode))
    throw forbidden(refusal);
  return grant.scope;
}

export function connectionTaskRequestScope(
  database: Kysely<DatabaseSchema>,
  input: Parameters<typeof connectionTaskReadScope>[1],
): Promise<"everything" | "selected"> {
  return connectionTaskReadScope(database, input, "Request is unavailable");
}

/**
 * Where a connection stands for new delegated work, read as one fact in one statement: `live`
 * (its state is live and its grant holds Tasks), `waiting` (a chat whose account is paused or
 * needs attention: its work is held) or `ended`. The same state and grant rule as
 * `liveDelegatingConnection`, for a caller that must tell held from lost.
 */
export async function delegatingConnectionStanding(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
): Promise<"live" | "waiting" | "ended"> {
  const read = await readConnectionStanding(database, ownerUserId, agentConnectionId, false);
  if (!read || read.state !== "live") return read?.state ?? "ended";
  return agentGrantAllowsTasks(AgentGrantSchema.parse(read.connection.grant)) ? "live" : "ended";
}

/**
 * A connection's grant as its standing allows it, from the one statement: the grant while the
 * connection is live, and null otherwise. What a connection may see is decided from this, never
 * from the grant row alone.
 */
export async function standingGrant(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
): Promise<AgentGrant | null> {
  const read = await readConnectionStanding(database, ownerUserId, agentConnectionId, false);
  return read?.state === "live" ? AgentGrantSchema.parse(read.connection.grant) : null;
}

/** The connection delegated work may still run for: live, and still granted Tasks. */
export async function liveDelegatingConnection(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
  target?: ConnectionTargetCheck,
) {
  const connection = await liveAgentConnection(database, ownerUserId, agentConnectionId, target);
  if (!agentGrantAllowsTasks(connection.grant)) throw forbidden(tasksWithdrawnMessage);
  return connection;
}

export function meetsConnectionFloor(
  connection: Awaited<ReturnType<typeof liveAgentConnection>>,
  revision: number | null,
  mode: ThreadAccessMode | null,
): boolean {
  const floor = connection.cleanupMinimumGrantRevision;
  return (
    floor === null ||
    (revision !== null &&
      (revision > floor ||
        (revision === floor &&
          (connection.cleanupMaximumMode === null ||
            (mode !== null && threadAccessModeAtMost(mode, connection.cleanupMaximumMode))))))
  );
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
  onMissing?: () => OpensteerError,
): Promise<string | null> {
  const facts = await bindingFacts(database, bindingId);
  if (!facts && onMissing) throw onMissing();
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
 * A supplied thread must be the binding's own. A supplied target must be in the live grant.
 */
export async function admitExecution(
  database: Kysely<DatabaseSchema>,
  input: ConnectionTargetCheck & {
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
    const connection = await liveAgentConnection(
      database,
      ownerUserId,
      subject.agentConnectionId,
      input,
    );
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
    ? await liveAgentConnection(database, ownerUserId, facts.agentConnectionId, input)
    : await liveDelegatingConnection(database, ownerUserId, facts.agentConnectionId, input);
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

type AuthorityScope =
  | {
      readonly kind: "person";
      readonly agentConnectionId?: never;
      readonly agentBindingId?: never;
      readonly threadId?: never;
    }
  | ({ readonly kind?: never; readonly threadId?: ThreadId | undefined } & (
      | { readonly agentBindingId: string; readonly agentConnectionId?: never }
      | { readonly agentConnectionId: string; readonly agentBindingId?: never }
      | {
          readonly threadId: ThreadId;
          readonly agentBindingId?: never;
          readonly agentConnectionId?: never;
        }
    ));

export type ResourceAccessInput = AuthorityScope & {
  readonly ownerUserId: UserId;
  /** Never an integration connection: an external agent is named `agentConnectionId`. */
  readonly connectionId?: never;
  readonly explicitAccess?: ResourceAccessLevel | null;
  readonly connectionCeiling?: ResourceAccessLevel | null;
  /** The concrete thing the effect touches. Without one, a `selected` grant is refused. */
  readonly grantTarget?: AgentGrantTarget;
};

export function authoritySubject(input: AuthorityScope): AuthoritySubject {
  if (input.agentBindingId) return { kind: "binding", bindingId: input.agentBindingId };
  if (input.agentConnectionId)
    return { kind: "connection", agentConnectionId: input.agentConnectionId };
  if (input.threadId) return { kind: "binding", bindingId: `thread:${input.threadId}` };
  if (input.kind === "person") return { kind: "person" };
  throw forbidden("Task authority is no longer available");
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
