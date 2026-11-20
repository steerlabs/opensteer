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
import type { Kysely } from "kysely";
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

/** The live connection, or a refusal: a revoked or expired connection has no authority. */
export async function liveAgentConnection(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
): Promise<AgentConnectionAuthority> {
  const row = await database
    .selectFrom("agentConnections")
    .select(["id", "grant", "grantRevision", "consentVersion", "accessMode"])
    .where("id", "=", agentConnectionId)
    .where("userId", "=", ownerUserId)
    .where("revokedAt", "is", null)
    .where("tokenHash", "is not", null)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  if (!row) throw forbidden(lineageEndedMessage);
  return {
    agentConnectionId: row.id,
    grant: AgentGrantSchema.parse(row.grant),
    grantRevision: row.grantRevision,
    consentVersion: row.consentVersion,
    accessMode: row.accessMode,
  };
}

/** The connection delegated work may still run for: live, and still granted Tasks. */
export async function liveDelegatingConnection(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  agentConnectionId: string,
): Promise<AgentConnectionAuthority> {
  const connection = await liveAgentConnection(database, ownerUserId, agentConnectionId);
  if (!agentGrantAllowsTasks(connection.grant)) throw forbidden(tasksWithdrawnMessage);
  return connection;
}

/**
 * A binding's immutable connection, read before any lock is taken: a Run's own, a task's origin,
 * or an automation's origin. Nothing falls back to another execution's facts.
 */
export async function bindingAgentConnectionId(
  database: Kysely<DatabaseSchema>,
  bindingId: string,
): Promise<string | null> {
  return (await bindingFacts(database, bindingId))?.agentConnectionId ?? null;
}

async function bindingFacts(
  database: Kysely<DatabaseSchema>,
  bindingId: string,
): Promise<{
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly agentConnectionId: string | null;
} | null> {
  if (bindingId.startsWith("run:")) {
    const runId = RunIdSchema.parse(bindingId.slice(4));
    const row = await database
      .selectFrom("runs")
      .select(["threadId", "connectionId"])
      .where("id", "=", runId)
      .executeTakeFirst();
    return row ? { threadId: row.threadId, runId, agentConnectionId: row.connectionId } : null;
  }
  if (bindingId.startsWith("session:")) {
    const sessionId = AgentSessionIdSchema.parse(bindingId.slice(8));
    const row = await database
      .selectFrom("agentSessions")
      .select(["threadId", "connectionId", "status"])
      .where("id", "=", sessionId)
      .executeTakeFirst();
    // An ended session has no authority at all.
    return row?.status === "active"
      ? { threadId: row.threadId, runId: null, agentConnectionId: row.connectionId }
      : null;
  }
  if (bindingId.startsWith("thread:")) {
    const threadId = ThreadIdSchema.parse(bindingId.slice(7));
    const row = await database
      .selectFrom("threads")
      .select("originConnectionId")
      .where("id", "=", threadId)
      .executeTakeFirst();
    return row ? { threadId, runId: null, agentConnectionId: row.originConnectionId } : null;
  }
  const row = bindingId.startsWith("trigger:")
    ? await database
        .selectFrom("triggerOccurrences")
        .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
        .select(["triggers.anchorThreadId", "triggers.originConnectionId"])
        .where("triggerOccurrences.id", "=", TriggerOccurrenceIdSchema.parse(bindingId.slice(8)))
        .executeTakeFirst()
    : bindingId.startsWith("watch:")
      ? await database
          .selectFrom("triggerWatchActivations")
          .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
          .select(["triggers.anchorThreadId", "triggers.originConnectionId"])
          .where(
            "triggerWatchActivations.id",
            "=",
            TriggerWatchActivationIdSchema.parse(bindingId.slice(6)),
          )
          .executeTakeFirst()
      : undefined;
  return row
    ? { threadId: row.anchorThreadId, runId: null, agentConnectionId: row.originConnectionId }
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
      agentConnection: connection,
      taskMode,
      mode: connection.accessMode,
    };
  }
  const facts = await bindingFacts(database, subject.bindingId);
  if (!facts || (input.threadId && input.threadId !== facts.threadId))
    throw forbidden("Task authority is no longer available");
  const thread = await ownedThread(database, facts.threadId, ownerUserId);
  const isRun = facts.runId !== null;
  // A program's or a session's mode is its task's (and its connection's), never a Run's.
  const isProgram =
    subject.bindingId.startsWith("trigger:") ||
    subject.bindingId.startsWith("watch:") ||
    subject.bindingId.startsWith("session:");
  // A program's own mode is its anchor task's; another Run sharing the anchor is not its lineage.
  const run = isProgram
    ? undefined
    : await database
        .selectFrom("runs")
        .select(["id", "accessMode"])
        .where("threadId", "=", facts.threadId)
        .where("requestedBy", "=", ownerUserId)
        .$if(isRun, (query) => query.where("id", "=", facts.runId!))
        .where("status", "in", activeRunStatuses)
        .orderBy("createdAt", "desc")
        .executeTakeFirst();
  const runMode = run?.accessMode ?? null;
  const execution = {
    ...base,
    threadId: facts.threadId,
    runId: facts.runId,
    taskMode: thread.accessMode,
    runMode,
  };
  if (!facts.agentConnectionId)
    return { ...execution, agentConnection: null, mode: runMode ?? thread.accessMode };
  // A session acts directly and needs no Tasks switch; delegated work needs it.
  const connection = subject.bindingId.startsWith("session:")
    ? await liveAgentConnection(database, ownerUserId, facts.agentConnectionId)
    : await liveDelegatingConnection(database, ownerUserId, facts.agentConnectionId);
  if (subject.bindingId.startsWith("session:") && !directOperationsAllowed(connection))
    throw forbidden("This connected agent was approved before direct work.");
  return {
    ...execution,
    agentConnection: connection,
    mode: minThreadAccessMode(connection.accessMode, thread.accessMode, runMode),
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
  execution: Pick<ExecutionAuthority, "agentConnection">,
  target: AgentGrantTarget,
): ResourceAccessLevel | null {
  return execution.agentConnection
    ? agentGrantAccess(execution.agentConnection.grant, target)
    : "read-write";
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
  const runAccess = integrationAccessCeilingForRun(execution.mode);
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
  execution: Pick<ExecutionAuthority, "mode">,
  explicitAccess: ResourceAccessLevel | null = "read-write",
): ResourceAccessLevel | null {
  return intersectResourceAccess(explicitAccess, integrationAccessCeilingForRun(execution.mode));
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
