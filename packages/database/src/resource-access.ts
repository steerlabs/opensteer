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
  agentEndedForPersonMessage,
  agentGrantAccess,
  agentGrantAllowsTasks,
  chatEndedMessage,
  requestOptionDeclines,
  intersectResourceAccess,
  minThreadAccessMode,
  OpensteerError,
  type AgentGrant,
  type AgentGrantResource,
  type RequestId,
  type AgentGrantTarget,
  type ResourceAccessLevel,
  type RunId,
  type ThreadAccessMode,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  commandFace,
  commandFaceStep,
  commandGovernedKinds,
  commandRow,
  type Command,
  type CommandFace,
  type CommandResource,
  type CommandResourceKind,
  type CommandRow,
  type CommandType,
  type CommandScope,
  type EffectClass,
} from "@opensteer/protocol/command-table";
import { sql, type Kysely, type RawBuilder } from "kysely";
import type { BridgeSenders, DatabaseSchema } from "./schema.js";
import { connectionState } from "./connection-liveness.js";
import { withDatabaseTransaction } from "./connection.js";
import { readerSees, type TaskReader } from "./task-reader.js";

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

/**
 * The grant a connection's lineage holds, the only one admission, its reach and the listing
 * read: a chat anyone may speak in holds what a selected grant with nothing in it holds (X15),
 * its own tasks as its grant allows them (a chat's messages are delegated work) and no thing of
 * the person's.
 */
export function effectiveConnectionGrant(
  grant: AgentGrant,
  bridgeSenders: BridgeSenders | null | undefined,
): AgentGrant {
  // Such a chat is made holding only tasks and the plugins the person chose; an `everything`
  // grant on one (it cannot be made so now) holds its tasks and nothing of the person's.
  return bridgeSenders === "anyone" && grant.scope === "everything"
    ? { scope: "selected", tasks: true, resources: [] }
    : grant;
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
export { agentEndedForPersonMessage, chatEndedMessage };
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
  if (!read || read.state !== "live")
    return {
      row: undefined,
      waiting: read?.state === "waiting",
      // A chat is a connection with a sender rule; what it says when it has ended is a chat's.
      chat: read !== undefined && read.connection.bridgeSenders !== null,
    };
  // The effective grant, from this one place (G1, K6): nothing past it reads the stored one. A
  // chat anyone may speak in is narrowed here (its row cannot store more: agent_connections_bridge).
  const grant = effectiveConnectionGrant(
    AgentGrantSchema.parse(read.connection.grant),
    read.connection.bridgeSenders,
  );
  const row = { ...read.connection, grant };
  const access = grantTarget && agentGrantAccess(grant, grantTarget);
  if (access === null)
    throw new OpensteerError({ code: "not_found", message: "That item is unavailable." });
  if (access === "read" && writeTargetName !== undefined)
    throw forbidden(`${writeTargetName} is shared for reading only.`);
  return { row, waiting: false, chat: row.bridgeSenders !== null };
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
  const { row, waiting, chat } = await readConnectionRowStanding(
    database,
    ownerUserId,
    agentConnectionId,
    false,
    target,
  );
  if (!row)
    throw waiting
      ? new ConnectionWaiting()
      : forbidden(chat ? chatEndedMessage : lineageEndedMessage);
  return {
    agentConnectionId: row.id,
    grant: row.grant,
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

/**
 * The person's own message to a task a connection made. They may type in any task of theirs while
 * its connection is live; one that waits (a paused chat) holds the message until it is back; one
 * that has ended takes no new work, and says so at once in its kind's words (a chat's, or a
 * connected agent's), as a resume or a change of its automation is refused. One read, and only
 * for a task a connection made: the person's own tasks read nothing here.
 */
export async function assertPersonMayContinue(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  taskOriginConnectionId: string | null,
): Promise<void> {
  if (taskOriginConnectionId === null) return;
  const standing = await readConnectionRowStanding(database, ownerUserId, taskOriginConnectionId);
  if (standing.row || standing.waiting) return;
  throw forbidden(standing.chat ? chatEndedMessage : agentEndedForPersonMessage);
}

/**
 * The one standing check for answering a Request (live, durable, or direct-operation): neither the
 * Request's own connection nor its task's origin connection may have ended. Called in the
 * transaction that records a decision, never in a post-effect receipt write. For the person's own
 * tasks both ids are null and this runs no query.
 */
export async function assertRequestOriginMayContinue(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  origin: {
    readonly connectionId: string | null;
    readonly threadOriginConnectionId: string | null;
  },
): Promise<void> {
  await assertPersonMayContinue(database, ownerUserId, origin.connectionId);
  if (
    origin.threadOriginConnectionId !== null &&
    origin.threadOriginConnectionId !== origin.connectionId
  )
    await assertPersonMayContinue(database, ownerUserId, origin.threadOriginConnectionId);
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
  return admitExecutionWith(database, input, undefined);
}

/**
 * The admission, given the binding's row when the caller already read it in this transaction,
 * so a command's admission reads its Run once.
 */
async function admitExecutionWith(
  database: Kysely<DatabaseSchema>,
  input: Parameters<typeof admitExecution>[1],
  known: BindingFacts | null | undefined,
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
  const facts = known === undefined ? await bindingFacts(database, subject.bindingId) : known;
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

export type CommandAnswer = "now" | "ask" | "not_found";
/** Why an agent is asked rather than let through; nothing here is shown to a connection. */
export type CommandAskReason =
  | "widens-other"
  | "grant"
  | "approval"
  | "secret"
  | "identity"
  | "mode"
  | "session"
  | "step"
  | "lineage";

/** A caller as the command rule reads it. The person never reaches the rule. */
export interface CommandRuleCaller {
  /** Null for your own agents: a Run or program with no connection in its lineage. */
  readonly connection: { readonly grant: "everything" | "selected" } | null;
  /** The lineage's mode: the lowest of every mode in it. */
  readonly mode: ThreadAccessMode;
  /**
   * The governed thing exists and is within the caller's reach: for a connection, inside its
   * grant and its lineage, or its own connection; for your own agents, one of the person's.
   * Outside reach reads exactly like something that does not exist.
   */
  readonly reach: boolean;
  /** For a task row: the task's mode is no higher than the caller's, so it is its own work. */
  readonly ownWork: boolean;
  /**
   * The governed thing is in the caller's own lineage (a connection's, or for your own agents the
   * person's), so what goes on after the command is its own work, in its own Disconnect set.
   * Undefined where that is not known: a face that runs on then asks.
   */
  readonly ownLineage?: boolean;
}

export interface CommandRuleAnswer {
  readonly answer: CommandAnswer;
  readonly reason?: CommandAskReason;
}

const answerOrder: readonly CommandAnswer[] = ["now", "ask", "not_found"];
function stricter(left: CommandRuleAnswer, right: CommandRuleAnswer): CommandRuleAnswer {
  return answerOrder.indexOf(right.answer) > answerOrder.indexOf(left.answer) ? right : left;
}
function looser<T extends CommandRuleAnswer>(left: T, right: T): T {
  return answerOrder.indexOf(right.answer) < answerOrder.indexOf(left.answer) ? right : left;
}

/**
 * The one rule for commands, as data: the face's class and the row's scope against who calls.
 * `face` undefined means only the stored state can tell which face this is; the caller is held to
 * the strictest one until the store decides. It reads nothing; `admitCommand` gathers the facts.
 */
export function commandRule(
  row: CommandRow,
  face: number | undefined,
  caller: CommandRuleCaller,
): CommandRuleAnswer {
  if (face === undefined)
    return row.faces
      .map((_, index) => commandRule(row, index, caller))
      .reduce((left, right) => stricter(left, right));
  const shape = row.faces[face];
  if (!shape) return { answer: "not_found" };
  const classes = shape.also ? [shape.class, shape.also] : [shape.class];
  return classes
    .map((effect) => classRule(effect, row.scope, shape, caller))
    .reduce((left, right) => stricter(left, right));
}

function classRule(
  effect: EffectClass,
  scope: CommandScope,
  face: CommandFace,
  caller: CommandRuleCaller,
): CommandRuleAnswer {
  const notFound = { answer: "not_found" } as const;
  // The person's own screen and device state: never an agent's, not even to ask about.
  if (effect === "person-view") return notFound;
  // Outside reach, or not there at all, reads the same: a Home-wide thing has no reach to miss.
  if (!caller.reach && scope !== "home") return notFound;
  const connection = caller.connection;
  if (connection) {
    // Another connection is another principal's, `everything` included.
    if (scope === "other-connection") return notFound;
    if (connection.grant === "selected" && (scope === "home" || effect === "identity"))
      return notFound;
  }
  switch (effect) {
    case "approve":
      // A schedule your own Full agent makes asks no less than its task, which asks nothing.
      return face.ownFullAccess && !connection && caller.mode === "full-access"
        ? { answer: "now" }
        : { answer: "ask", reason: "approval" };
    case "widen-other":
      return { answer: "ask", reason: "widens-other" };
    case "secret":
      return { answer: "ask", reason: "secret" };
    case "identity":
      return { answer: "ask", reason: "identity" };
    default:
  }
  if (face.personSession) return { answer: "ask", reason: "session" };
  // What goes on after the command, unless it is in the caller's own lineage, gives another
  // lineage more than it holds and is out of reach of the caller's Stop and Disconnect: the person
  // is asked. For your own agents too (T1): a program put on the computer to run as a connected
  // agent's task is not their own work.
  // A thing with no task lineage (a plugin, an app, a profile) is the person's: your own agents'
  // own lineage, never a connection's.
  const ownLineage = caller.ownLineage ?? !connection;
  if (face.lineage && !ownLineage) return { answer: "ask", reason: "lineage" };
  if (effect === "read") return { answer: "now" };
  const selected = connection?.grant === "selected";
  // Destroying, or making something new, inside a selected grant asks: it changes what is granted.
  if (selected && (effect === "destroy" || (effect === "widen-self" && scope === "new")))
    return { answer: "ask", reason: "grant" };
  if (caller.mode === "full-access") return { answer: "now" };
  if (
    (face.readWrite === true || (face.readWrite === "connections" && connection)) &&
    caller.mode !== "auto"
  )
    return { answer: "ask", reason: "mode" };
  // Below Full access the person is asked for every effect outside the caller's own task work.
  const ownTaskWork =
    scope === "task" &&
    caller.ownWork &&
    !face.fullAccess &&
    (effect === "preference" || effect === "narrow" || effect === "widen-self");
  return ownTaskWork ? { answer: "now" } : { answer: "ask", reason: "mode" };
}

/** What the Home answers a command, and on which face it decided. */
export interface CommandAdmission {
  readonly answer: CommandAnswer;
  /** Undefined while only the stored state can tell: the strictest face was applied. */
  readonly face: number | undefined;
  readonly reason?: CommandAskReason;
  /** Null for the person, who is admitted by the session and reads nothing. */
  readonly execution: ExecutionAuthority | null;
}

/** The store's own view of what a two-faced command does, reported inside its transaction. */
export interface CommandStoredFace {
  readonly face: EffectClass;
}

/**
 * The subject a connection is admitted as: its direct session when it has one live (the one its
 * `taskId` names, or its active one), so what it does in that task is its own work and its own
 * asks are its own; otherwise the connection itself. Reads only for a connection.
 */
export async function connectionAdmissionSubject(
  database: Kysely<DatabaseSchema>,
  connectionId: string,
  taskId?: string | null,
): Promise<AuthoritySubject> {
  let query = database
    .selectFrom("agentSessions")
    .select("id")
    .where("connectionId", "=", connectionId)
    .where("status", "=", "active");
  if (taskId) query = query.where("threadId", "=", taskId as ThreadId);
  const session = await query.orderBy("id").executeTakeFirst();
  return session
    ? { kind: "binding", bindingId: `session:${session.id}` }
    : { kind: "connection", agentConnectionId: connectionId };
}

/** The subject an agent's credential speaks for: its connection, or the execution it is bound to. */
export function commandSubject(callerKey: string): AuthoritySubject {
  return callerKey.startsWith("connection:")
    ? { kind: "connection", agentConnectionId: callerKey.slice("connection:".length) }
    : { kind: "binding", bindingId: callerKey };
}

/**
 * The one admission for Home commands: `now`, `ask` the person, or `not_found`. The person is
 * admitted by the session and reads nothing. For an agent, in one transaction under its
 * connection row's `FOR SHARE`: its execution as `admitExecution` reads it (binding, every mode
 * in its lineage, and the effective grant read in the same statement), then the
 * governed thing itself (the task it belongs to and that task's lineage and mode, a profile in
 * the grant, its own session), then the rule. A handler not yet written for agents turns its
 * `now` into `ask` (its step).
 *
 * The face is the input's, or the store's when it reports one (`stored`). With `awaitingStore`,
 * at commit before the store has looked, a command only the store can tell passes if some face of
 * it could be `now`; it must then be reported before it commits (`administrationCommand`).
 */
export async function admitCommand(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerUserId: UserId;
    readonly subject: AuthoritySubject;
    readonly command: Command;
    readonly stored?: CommandStoredFace | undefined;
    readonly awaitingStore?: true;
  },
): Promise<CommandAdmission> {
  const row = commandRow(input.command.type) as CommandRow | undefined;
  if (!row) return { answer: "not_found", face: undefined, execution: null };
  const face = commandFaceFor(row, input);
  if (input.subject.kind === "person") return { answer: "now", face, execution: null };
  const admit = async (transaction: Kysely<DatabaseSchema>) => {
    // A Run's row is read once: it names the connection to hold, and admission reads the rest of
    // it. The connection itself is read after the hold, so a Disconnect meanwhile is seen.
    const binding =
      input.subject.kind === "binding"
        ? await bindingFacts(transaction, input.subject.bindingId)
        : undefined;
    const connectionId =
      input.subject.kind === "connection"
        ? input.subject.agentConnectionId
        : binding && !binding.inconsistent
          ? binding.agentConnectionId
          : null;
    if (connectionId)
      await transaction
        .selectFrom("agentConnections")
        .select("id")
        .where("id", "=", connectionId)
        .forShare()
        .executeTakeFirst();
    const execution = await admitExecutionWith(
      transaction,
      { ownerUserId: input.ownerUserId, subject: input.subject },
      binding,
    );
    const reach = await commandReach(
      transaction,
      execution,
      row,
      (row.governs as (command: Command) => CommandResource)(input.command),
      input.command,
    );
    return { execution, reach };
  };
  const { execution, reach } = database.isTransaction
    ? await admit(database)
    : await withDatabaseTransaction(database, admit);
  const connection = execution.agentConnection;
  // The same holding rule the listing reads, where it is admitted (and readmitted at the effect).
  if (connection && !lineageAllowsPersonalContext(connection) && anyoneChatHoldsNo(row))
    return { answer: "not_found", face: undefined, execution };
  const scope = effectiveGrantScope(execution);
  const caller: CommandRuleCaller = {
    connection: scope ? { grant: scope } : null,
    mode: execution.mode,
    reach: reach.reach,
    ownWork: reach.ownWork,
    ...(reach.ownLineage === undefined ? {} : { ownLineage: reach.ownLineage }),
  };
  const steps = { connection: connection !== null, selected: scope === "selected" };
  const decide = (at: number | undefined): CommandAdmission => {
    const rule = commandRule(row, at, caller);
    if (rule.answer !== "now") return { ...rule, face: at, execution };
    const faces = at === undefined ? row.faces.map((_, index) => index) : [at];
    if (faces.some((index) => commandFaceStep(row, index, steps) !== "A"))
      return { answer: "ask", reason: "step", face: at, execution };
    return { answer: "now", face: at, execution };
  };
  // A face only stored state can tell, read by the Home from that state where it can (the kind of
  // the Request an answer is for), never taken from the caller.
  const known = face ?? (input.stored ? undefined : reach.face);
  if (known !== undefined || !input.awaitingStore) return decide(known);
  // Before the store has looked: the most this command could be. The store's report decides.
  const best = row.faces
    .map((_, index) => decide(index))
    .reduce((left, right) => looser(left, right));
  return { ...best, face: undefined };
}

/** The grant scope the rule reads, from the effective grant admission holds; null for your own agents. */
function effectiveGrantScope(
  execution: Pick<ExecutionAuthority, "agentConnection">,
): "everything" | "selected" | null {
  return execution.agentConnection?.grant.scope ?? null;
}

/**
 * What a chat anyone in its conversation may message never holds (X15, K3): any automation
 * command, whatever thing it names (a new one names its anchor task). A stranger's message never
 * ends in a standing automation that later runs with a task's authority.
 */
function anyoneChatHoldsNo(row: CommandRow): boolean {
  return row.family === "automations";
}

/** A caller as whether it holds a command reads it: its live scope and grant, and its mode. */
export interface CommandHolder {
  readonly scope: "everything" | "selected" | null;
  readonly grant: AgentGrant | null;
  readonly mode: ThreadAccessMode;
  /** A chat anyone in its conversation may message: it may have no automation (X15). */
  readonly anyoneChat?: boolean;
}

/**
 * Whether a caller holds a command type at all: the one function the listing and the door both
 * ask, from the caller's live grant, before any input is read (rule 5). A selected grant holds a
 * type only if it holds the kind of thing the type governs, as admission reaches it per thing.
 */
export function commandHolds(type: CommandType, holder: CommandHolder): boolean {
  const row = commandRow(type) as CommandRow;
  if (holder.anyoneChat && anyoneChatHoldsNo(row)) return false;
  if (
    !commandHeld(row, {
      connection: holder.scope ? { grant: holder.scope } : null,
      mode: holder.mode,
    })
  )
    return false;
  const grant = holder.grant;
  if (holder.scope !== "selected" || grant?.scope !== "selected") return true;
  // A new thing has nothing to be outside of: admission reaches it, and a selected grant asks.
  if (row.scope === "new") return true;
  // Otherwise what it governs must be a kind this grant reaches some thing of.
  return commandGovernedKinds(type).some((kind) => selectedHoldsKind(kind, grant));
}

/**
 * Whether a selected grant reaches any thing of this kind, by the rule `commandReach` applies to
 * the thing itself: a kind it names through `grantNamed` (or through one, as a profile's tabs),
 * task work through Tasks, and its own session's Requests, its sessions and its own connection
 * (D9). A kind with no reach rule for a selected grant is not held.
 */
function selectedHoldsKind(
  kind: CommandResourceKind,
  grant: Extract<AgentGrant, { scope: "selected" }>,
): boolean {
  const named = grantNamed[(reachedThrough[kind] ?? kind) as keyof typeof grantNamed];
  if (named) return grant.resources.some((entry) => named.holds(entry));
  switch (kind) {
    case "task":
    case "assignment":
    case "automation":
      return agentGrantAllowsTasks(grant);
    case "request":
    case "agent-session":
    case "connection":
      return true;
    default:
      return false;
  }
}

/**
 * What a caller holds, from the one admission's own read (`admitExecution`): its scope and
 * effective grant (null for your own agents) and its live mode; `gone` once it may not act.
 * The listing, the parse gate and the door's admission all start from this.
 */
export async function commandCallerHolder(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  subject: AuthoritySubject,
): Promise<CommandHolder | "gone"> {
  try {
    const execution = await admitExecution(database, { ownerUserId, subject });
    const connection = execution.agentConnection;
    return {
      scope: connection?.grant.scope ?? null,
      grant: connection?.grant ?? null,
      mode: execution.mode,
      ...(connection && !lineageAllowsPersonalContext(connection) ? { anyoneChat: true } : {}),
    };
  } catch (error) {
    if (error instanceof ConnectionWaiting) return "gone";
    if (error instanceof OpensteerError && error.code === "forbidden") return "gone";
    throw error;
  }
}

export const commandNotFoundMessage = "That item is unavailable.";

/**
 * At commit, inside the effect's transaction: the command must still be `now` for this agent, on
 * the face the store sees. What is no longer reachable reads as the fixed not found; what now
 * needs the person refuses with `authority-changed`. Nothing is written either way.
 */
export async function assertCommandAdmitted(
  transaction: Kysely<DatabaseSchema>,
  input: Parameters<typeof admitCommand>[1],
): Promise<void> {
  const admission = await admitCommand(transaction, input);
  if (admission.answer === "now") return;
  if (admission.answer === "not_found")
    throw new OpensteerError({ code: "not_found", message: commandNotFoundMessage });
  throw new OpensteerError({
    code: "forbidden",
    reason: "authority-changed",
    message: "This agent's access changed before the change was made.",
  });
}

function commandFaceFor(
  row: CommandRow,
  input: { readonly command: Command; readonly stored?: CommandStoredFace | undefined },
): number | undefined {
  const fromInput = commandFace(input.command);
  if (!input.stored) return fromInput;
  // The store's view decides; an input that says otherwise is not the command that was admitted.
  const index = row.faces.findIndex(
    (face, at) =>
      face.class === input.stored!.face && (fromInput === undefined || fromInput === at),
  );
  return index === -1 ? (row.faces.length > 1 ? undefined : 0) : index;
}

interface CommandReach {
  readonly reach: boolean;
  readonly ownWork: boolean;
  /** The governed thing's lineage is the caller's own; undefined where it has none. */
  readonly ownLineage?: boolean;
  /** The face the stored state shows, where the Home read it while finding the thing. */
  readonly face?: number;
}
const inReach: CommandReach = { reach: true, ownWork: true };
const outOfReach: CommandReach = { reach: false, ownWork: false };

/**
 * Whether the governed thing exists and is within this agent's reach, and whether a task row's
 * task is its own work. A task is reached in its lineage (a connection's own, or the person's
 * with `everything`) and only with Tasks in the grant; its mode decides own work. A Request,
 * a delegation, an automation and a direct session are reached through the task they belong to.
 * A selected grant reaches a nameable thing only when the input names it the way the grant does;
 * one the Home cannot name from the input (a device app, a device-data grant, a plugin account,
 * a tab without a profile) is outside until its family's store resolves it. Agents only: the
 * person never comes here.
 */
async function commandReach(
  database: Kysely<DatabaseSchema>,
  execution: ExecutionAuthority,
  row: CommandRow,
  resource: CommandResource,
  command: Command,
): Promise<CommandReach> {
  const connection = execution.agentConnection;
  const scope = effectiveGrantScope(execution);
  const selected = scope === "selected";
  const owner = execution.ownerUserId;
  /** The task this caller works in: what it opens is its own work, and only that. */
  const ownTask = execution.threadId;
  const own = (mode: ThreadAccessMode) => threadAccessModeAtMost(mode, execution.mode);
  // What the caller may see, as the task reader has it (T3): work in a memory pass's own task tree
  // sees only what ran with personal context; anything else reads exactly like nothing (rule 5).
  const reader: TaskReader = ownTask ? { kind: "work", threadId: ownTask } : { kind: "person" };
  const task = async (threadId: string, origin?: string | null): Promise<CommandReach> => {
    const thread = await database
      .selectFrom("threads")
      .select(["createdBy", "accessMode", "originConnectionId"])
      .select(
        readerSees(
          reader,
          sql`threads.origin_connection_id`,
          ...(origin ? [sql`${origin}::text`] : []),
        ).as("visible"),
      )
      .where("id", "=", threadId as ThreadId)
      .executeTakeFirst();
    if (!thread || thread.createdBy !== owner || !thread.visible) return outOfReach;
    const lineage = origin === undefined ? thread.originConnectionId : origin;
    // A connection's own task (its direct session's) is its own, with or without Tasks.
    if (connection && threadId !== ownTask) {
      if (!agentGrantAllowsTasks(connection.grant)) return outOfReach;
      if (!sendEligible(connection, lineage)) return outOfReach;
    }
    return {
      reach: true,
      ownWork: own(thread.accessMode),
      // A connection's own lineage, or for your own agents the person's (no connection).
      ownLineage: lineage === (connection ? connection.agentConnectionId : null),
    };
  };
  const both = (left: CommandReach, right: CommandReach): CommandReach => ({
    reach: left.reach && right.reach,
    ownWork: left.ownWork && right.ownWork,
    ...(left.ownLineage === undefined && right.ownLineage === undefined
      ? {}
      : { ownLineage: left.ownLineage !== false && right.ownLineage !== false }),
  });
  const granted = (target: AgentGrantTarget | null) =>
    !selected || (target !== null && authorizeTarget(execution, target) !== null);
  const profile = async (profileId: string): Promise<boolean> => {
    const row = await database
      .selectFrom("browserProfiles")
      .select("ownerId")
      .where("id", "=", profileId as never)
      .executeTakeFirst();
    return row?.ownerId === owner && granted({ kind: "browser-profile", profileId });
  };
  if (row.scope === "home") return inReach;
  if (row.scope === "other-connection") return connection ? outOfReach : inReach;
  switch (resource.kind) {
    case "task": {
      const requested: CommandReach = {
        reach: true,
        ownWork: resource.mode === undefined || own(resource.mode as ThreadAccessMode),
      };
      if (resource.id === null)
        return connection && !agentGrantAllowsTasks(connection.grant) ? outOfReach : requested;
      return both(await task(resource.id), requested);
    }
    case "request": {
      const request = await database
        .selectFrom("requests")
        .select(["originatingThreadId", "requestedBy", "kind", "presentation", "command"])
        .where("id", "=", resource.id as RequestId)
        .executeTakeFirst();
      if (!request || request.requestedBy !== owner) return outOfReach;
      const reach = await task(request.originatingThreadId);
      // The face is read from the Request only once it is in reach: outside reads like missing.
      return reach.reach && command.type === "request.respond"
        ? { ...reach, face: answerFace(request, command) }
        : reach;
    }
    case "assignment": {
      const assignment = await database
        .selectFrom("delegations")
        .select("parentThreadId")
        .where("id", "=", resource.id as never)
        .executeTakeFirst();
      return assignment ? task(assignment.parentThreadId) : outOfReach;
    }
    case "automation": {
      const trigger = await database
        .selectFrom("triggers")
        .select(["anchorThreadId", "originConnectionId", "createdBy"])
        .where("id", "=", resource.id as never)
        .executeTakeFirst();
      if (!trigger || trigger.createdBy !== owner) return outOfReach;
      return task(trigger.anchorThreadId, trigger.originConnectionId);
    }
    case "agent-session": {
      const session = await database
        .selectFrom("agentSessions")
        .select(["connectionId", "threadId", "userId"])
        .where("id", "=", resource.id as never)
        .executeTakeFirst();
      if (!session || session.userId !== owner) return outOfReach;
      if (resource.task !== undefined && resource.task !== session.threadId) return outOfReach;
      // A connected agent stops only its own session.
      return connection && session.connectionId !== connection.agentConnectionId
        ? outOfReach
        : inReach;
    }
    case "connection":
      return !connection || resource.id === connection.agentConnectionId ? inReach : outOfReach;
    case "tabs": {
      const ids = resource.ids ?? [];
      // Opening a tab with no profile (a Guest page, a window, an app): no selected grant names
      // it; it is the caller's own work only from a task of its own.
      if (ids.length === 0) return { reach: !selected, ownWork: !selected && ownTask !== null };
      const tabs = await database
        .selectFrom("personalTabs")
        .select(["profileId", "ownerId", "openedBy"])
        .where("id", "in", ids as never)
        .execute();
      if (tabs.length !== new Set(ids).size || tabs.some((tab) => tab.ownerId !== owner))
        return outOfReach;
      if (
        tabs.some(
          (tab) =>
            !granted(
              tab.profileId === null ? null : { kind: "browser-profile", profileId: tab.profileId },
            ),
        )
      )
        return outOfReach;
      // Its own work is what its own task opened; the person's tabs, and anything that records
      // no opener, are not.
      const opened = (tab: (typeof tabs)[number]) => {
        const by = tab.openedBy as unknown;
        return (
          ownTask !== null &&
          typeof by === "object" &&
          by !== null &&
          (by as { taskId?: unknown }).taskId === ownTask
        );
      };
      return { reach: true, ownWork: tabs.every(opened) };
    }
    case "tab-group": {
      if (selected) return outOfReach;
      const layout = await database
        .selectFrom("tabLayouts")
        .select("items")
        .where("ownerId", "=", owner)
        .executeTakeFirst();
      const items = (layout?.items ?? []) as readonly {
        readonly kind: string;
        readonly group?: { readonly groupId: string };
      }[];
      // A group records no opener: it is never an agent's own work.
      return items.some((item) => item.kind === "group" && item.group?.groupId === resource.id)
        ? { reach: true, ownWork: false }
        : outOfReach;
    }
    case "browser-session": {
      const session = await database
        .selectFrom("browserSessions")
        .select("profileId")
        .where("id", "=", resource.id as never)
        .executeTakeFirst();
      if (!session) return outOfReach;
      if (
        !granted(
          session.profileId === null
            ? null
            : { kind: "browser-profile", profileId: session.profileId },
        )
      )
        return outOfReach;
      const used =
        ownTask !== null &&
        (await database
          .selectFrom("browserSessionUses")
          .select("id")
          .where("sessionId", "=", resource.id as never)
          .where("threadId", "=", ownTask)
          .executeTakeFirst()) !== undefined;
      return { reach: true, ownWork: used };
    }
    case "browser-profile": {
      // A new profile has nothing to be outside of; a page with no profile is a Guest page,
      // which no selected grant names.
      if (row.scope === "new" && resource.id === null) return inReach;
      const reach = resource.id === null ? !selected : await profile(resource.id);
      if (!reach) return outOfReach;
      if (resource.task !== undefined) return task(resource.task);
      // A tab its own task opens is its own work; a browser not started for a task is not.
      return { reach: true, ownWork: command.type === "tab.open" && ownTask !== null };
    }
    case "device-setup": {
      if (selected) return outOfReach;
      const setup = await database
        .selectFrom("computerAppSetupRequests")
        .select(["ownerUserId", "threadId"])
        .where("id", "=", resource.id as never)
        .executeTakeFirst();
      if (!setup || setup.ownerUserId !== owner) return outOfReach;
      return { reach: true, ownWork: setup.threadId !== null && setup.threadId === ownTask };
    }
    default: {
      // A new thing (no id yet) has nothing to be outside of; an existing one is named or not.
      const reach =
        row.scope === "new" && resource.id === null ? true : granted(grantTargetOf(resource));
      if (!reach) return outOfReach;
      return resource.task === undefined ? inReach : task(resource.task);
    }
  }
}

/**
 * Which face an answer to a stored Request is, read from that Request: the answer to an agent's
 * question is the caller's own work; a decline narrows; anything else allows what the person was
 * asked, which is the person's to give.
 */
function answerFace(
  request: { readonly kind: string; readonly presentation: unknown; readonly command: unknown },
  command: Command,
): number {
  if (request.kind === "harness.input") return 0;
  // A proposed command is the person's to answer, either way: an agent's answer points at it.
  if (request.command !== null) return 1;
  const response = (
    command as {
      readonly response?: { kind?: string; optionId?: string; value?: { decision?: unknown } };
    }
  ).response;
  if (response?.kind === "external" && response.value?.decision === "declined") return 2;
  if (response?.kind === "choice") {
    const options = (request.presentation as { options?: readonly { id: string; hint?: string }[] })
      .options;
    const chosen = options?.find((option) => option.id === response.optionId);
    if (chosen && requestOptionDeclines(chosen as never)) return 2;
  }
  return 1;
}

/**
 * Whether a caller holds a command type at all, from the caller and the row alone: some face of
 * it could be anything but not found for such a caller. A type it does not hold reads as not
 * found before its input is looked at; the same answer builds the caller's list of commands.
 */
export function commandHeld(
  row: CommandRow,
  caller: Pick<CommandRuleCaller, "connection" | "mode">,
): boolean {
  return row.faces.some(
    (_, face) =>
      commandRule(row, face, { ...caller, reach: true, ownWork: true }).answer !== "not_found",
  );
}

/**
 * The kinds a selected grant names a thing of, and how: the one table both what is listed
 * (`selectedHoldsKind`) and what is reached (`grantTargetOf`) read.
 */
const grantNamed = {
  "browser-profile": {
    target: (id: string): AgentGrantTarget => ({ kind: "browser-profile", profileId: id }),
    holds: (entry: AgentGrantResource) => entry.kind === "browser-profile",
  },
  chrome: {
    target: (id: string): AgentGrantTarget => ({ kind: "chrome-tabs", sourceId: id }),
    holds: (entry: AgentGrantResource) => entry.kind === "chrome-tabs",
  },
  plugin: {
    target: (id: string): AgentGrantTarget => ({
      kind: "plugin",
      target: { kind: "installed", pluginId: id },
    }),
    holds: (entry: AgentGrantResource) =>
      entry.kind === "plugin" && entry.target.kind === "installed",
  },
  "local-server": {
    target: (id: string): AgentGrantTarget => ({
      kind: "plugin",
      target: { kind: "local-server", serverId: id },
    }),
    holds: (entry: AgentGrantResource) =>
      entry.kind === "plugin" && entry.target.kind === "local-server",
  },
} satisfies Partial<Record<CommandResourceKind, unknown>>;
/** Kinds reached through a thing a grant names: a profile's sessions and tabs. */
const reachedThrough: Partial<Record<CommandResourceKind, keyof typeof grantNamed>> = {
  "browser-session": "browser-profile",
  tabs: "browser-profile",
};

function grantTargetOf(resource: CommandResource): AgentGrantTarget | null {
  if (resource.id === null) return null;
  const named = grantNamed[resource.kind as keyof typeof grantNamed];
  return named ? named.target(resource.id) : null;
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
