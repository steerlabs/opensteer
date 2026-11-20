import { integrationAccessCeilingForRun } from "@opensteer/integration-core/effective-grants";
import { assertPersonalOwner } from "./private-resource-owner.js";
import {
  AgentGrantSchema,
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
 * Who an effect is for. A binding names an execution the Home issued (`run:`, `thread:`,
 * `trigger:`, `watch:`; the next phase adds `session:`); its lineage is read here, never taken
 * from the caller.
 */
export type AuthoritySubject =
  | { readonly kind: "person" }
  | { readonly kind: "connection"; readonly connectionId: string }
  | { readonly kind: "binding"; readonly bindingId: string };

/** The connected agent an execution works for, as it stands now. */
export interface AuthorityLineage {
  readonly connectionId: string;
  readonly grant: AgentGrant;
  readonly grantRevision: number;
  readonly consentVersion: number;
  readonly accessMode: ThreadAccessMode;
}

export interface ResolvedAuthority {
  /** The minimum of every mode in the lineage; native owner work keeps today's rule. */
  readonly mode: ThreadAccessMode;
  readonly lineage: AuthorityLineage | null;
  readonly threadId: ThreadId | null;
  readonly runId: RunId | null;
}

const activeRunStatuses = ["queued", "starting", "running", "waiting"] as const;

function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}
export const lineageEndedMessage =
  "This connected agent's access ended. The person can reconnect it from Connected agents.";

/** The live lineage connection, or a refusal: revoked or expired lineage has no authority. */
export async function liveLineage(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  connectionId: string,
): Promise<AuthorityLineage> {
  const row = await database
    .selectFrom("agentConnections")
    .select(["id", "grant", "grantRevision", "consentVersion", "accessMode"])
    .where("id", "=", connectionId)
    .where("userId", "=", ownerUserId)
    .where("revokedAt", "is", null)
    .where("tokenHash", "is not", null)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  if (!row) throw forbidden(lineageEndedMessage);
  return {
    connectionId: row.id,
    grant: AgentGrantSchema.parse(row.grant),
    grantRevision: row.grantRevision,
    consentVersion: row.consentVersion,
    accessMode: row.accessMode,
  };
}

/** A binding's immutable lineage connection id, read before any lock is taken. */
export async function bindingLineageConnectionId(
  database: Kysely<DatabaseSchema>,
  bindingId: string,
): Promise<string | null> {
  if (bindingId.startsWith("run:")) {
    const row = await database
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["runs.connectionId", "threads.originConnectionId"])
      .where("runs.id", "=", RunIdSchema.parse(bindingId.slice(4)))
      .executeTakeFirst();
    return row?.connectionId ?? row?.originConnectionId ?? null;
  }
  if (bindingId.startsWith("thread:")) {
    const id = ThreadIdSchema.parse(bindingId.slice(7));
    const thread = await database
      .selectFrom("threads")
      .select("originConnectionId")
      .where("id", "=", id)
      .executeTakeFirst();
    if (thread?.originConnectionId) return thread.originConnectionId;
    const run = await database
      .selectFrom("runs")
      .select("connectionId")
      .where("threadId", "=", id)
      .where("status", "in", activeRunStatuses)
      .orderBy("createdAt", "desc")
      .executeTakeFirst();
    return run?.connectionId ?? null;
  }
  const trigger = bindingId.startsWith("trigger:")
    ? await database
        .selectFrom("triggerOccurrences")
        .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
        .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
        .select(["triggers.originConnectionId", "threads.originConnectionId as anchorConnectionId"])
        .where("triggerOccurrences.id", "=", TriggerOccurrenceIdSchema.parse(bindingId.slice(8)))
        .executeTakeFirst()
    : bindingId.startsWith("watch:")
      ? await database
          .selectFrom("triggerWatchActivations")
          .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
          .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
          .select([
            "triggers.originConnectionId",
            "threads.originConnectionId as anchorConnectionId",
          ])
          .where(
            "triggerWatchActivations.id",
            "=",
            TriggerWatchActivationIdSchema.parse(bindingId.slice(6)),
          )
          .executeTakeFirst()
      : undefined;
  return trigger?.originConnectionId ?? trigger?.anchorConnectionId ?? null;
}

/**
 * The one authority rule. Resolves the subject's lineage server-side and intersects every
 * current ceiling; when nothing resolves the answer is a refusal, never `full-access`. A supplied
 * thread must be the binding's own.
 */
export async function resolveAuthority(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerUserId: UserId;
    readonly subject: AuthoritySubject;
    readonly threadId?: ThreadId | undefined;
  },
): Promise<ResolvedAuthority> {
  await assertPersonalOwner(database, input.ownerUserId);
  const { subject } = input;
  if (subject.kind === "person") {
    if (input.threadId) await ownedThread(database, input.threadId, input.ownerUserId);
    return { mode: "full-access", lineage: null, threadId: input.threadId ?? null, runId: null };
  }
  if (subject.kind === "connection") {
    const lineage = await liveLineage(database, input.ownerUserId, subject.connectionId);
    if (input.threadId) {
      const thread = await ownedThread(database, input.threadId, input.ownerUserId);
      if (lineage.grant.scope === "selected" && thread.originConnectionId !== lineage.connectionId)
        throw forbidden("Task is unavailable");
    }
    return { mode: lineage.accessMode, lineage, threadId: input.threadId ?? null, runId: null };
  }
  const { bindingId } = subject;
  let threadId: ThreadId | undefined;
  let runId: RunId | null = null;
  let bindingConnectionId: string | null = null;
  if (bindingId.startsWith("run:")) {
    runId = RunIdSchema.parse(bindingId.slice(4));
    const run = await database
      .selectFrom("runs")
      .select(["threadId", "connectionId"])
      .where("id", "=", runId)
      .where("requestedBy", "=", input.ownerUserId)
      .executeTakeFirst();
    threadId = run?.threadId;
    bindingConnectionId = run?.connectionId ?? null;
  } else if (bindingId.startsWith("thread:")) {
    threadId = ThreadIdSchema.parse(bindingId.slice(7));
  } else if (bindingId.startsWith("trigger:")) {
    const row = await database
      .selectFrom("triggerOccurrences")
      .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
      .select(["triggers.anchorThreadId", "triggers.originConnectionId"])
      .where("triggerOccurrences.id", "=", TriggerOccurrenceIdSchema.parse(bindingId.slice(8)))
      .executeTakeFirst();
    threadId = row?.anchorThreadId;
    bindingConnectionId = row?.originConnectionId ?? null;
  } else if (bindingId.startsWith("watch:")) {
    const row = await database
      .selectFrom("triggerWatchActivations")
      .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
      .select(["triggers.anchorThreadId", "triggers.originConnectionId"])
      .where(
        "triggerWatchActivations.id",
        "=",
        TriggerWatchActivationIdSchema.parse(bindingId.slice(6)),
      )
      .executeTakeFirst();
    threadId = row?.anchorThreadId;
    bindingConnectionId = row?.originConnectionId ?? null;
  }
  if (!threadId || (input.threadId && input.threadId !== threadId))
    throw forbidden("Task authority is no longer available");
  const thread = await ownedThread(database, threadId, input.ownerUserId);
  const run = await database
    .selectFrom("runs")
    .select(["id", "accessMode", "connectionId"])
    .where("threadId", "=", threadId)
    .where("requestedBy", "=", input.ownerUserId)
    .$if(runId !== null, (query) => query.where("id", "=", runId!))
    .where("status", "in", activeRunStatuses)
    .orderBy("createdAt", "desc")
    .executeTakeFirst();
  const lineageId =
    bindingConnectionId ??
    thread.originConnectionId ??
    (bindingId.startsWith("thread:") ? (run?.connectionId ?? null) : null);
  if (!lineageId)
    return { mode: run?.accessMode ?? thread.accessMode, lineage: null, threadId, runId };
  const lineage = await liveLineage(database, input.ownerUserId, lineageId);
  if (!agentGrantAllowsTasks(lineage.grant))
    throw forbidden("This connected agent may no longer ask your agents to work.");
  return {
    mode: minThreadAccessMode(lineage.accessMode, thread.accessMode, run?.accessMode),
    lineage,
    threadId,
    runId,
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

/** The grant's ceiling for a target, or for no target: only unlimited lineage passes. */
export function lineageGrantAccess(
  lineage: AuthorityLineage | null,
  target: AgentGrantTarget | "actor" | undefined,
): ResourceAccessLevel | null {
  if (!lineage || target === "actor") return "read-write";
  if (!target) return lineage.grant.scope === "everything" ? "read-write" : null;
  return agentGrantAccess(lineage.grant, target);
}

export interface ResourceAccessInput {
  readonly ownerUserId: UserId;
  readonly connectionId?: string;
  readonly threadId?: ThreadId | undefined;
  readonly agentBindingId?: string;
  readonly explicitAccess?: ResourceAccessLevel | null;
  readonly connectionCeiling?: ResourceAccessLevel | null;
  /**
   * The concrete thing the effect touches. Without one, a `selected` lineage is refused; `actor`
   * asks only whether the execution itself still has authority.
   */
  readonly grantTarget?: AgentGrantTarget | "actor";
}

export function authoritySubject(input: {
  readonly connectionId?: string | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly agentBindingId?: string | undefined;
}): AuthoritySubject {
  if (input.agentBindingId) return { kind: "binding", bindingId: input.agentBindingId };
  if (input.connectionId) return { kind: "connection", connectionId: input.connectionId };
  if (input.threadId) return { kind: "binding", bindingId: `thread:${input.threadId}` };
  return { kind: "person" };
}

export async function resolveResourceAccess(
  database: Kysely<DatabaseSchema>,
  input: ResourceAccessInput,
) {
  const authority = await resolveAuthority(database, {
    ownerUserId: input.ownerUserId,
    subject: authoritySubject(input),
    ...(input.threadId && (input.agentBindingId || input.connectionId)
      ? { threadId: input.threadId }
      : {}),
  });
  const runAccess = integrationAccessCeilingForRun(authority.mode);
  const grantAccess = lineageGrantAccess(authority.lineage, input.grantTarget);
  return {
    authority,
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
    (caller.originConnectionId !== null &&
      target.originConnectionId !== caller.originConnectionId &&
      !(await everythingConnection(database, caller.originConnectionId)))
  )
    throw new OpensteerError({ code: "forbidden", message: "Start a new task for this work" });
  await assertPersonalOwner(database, caller.createdBy);
}

async function everythingConnection(
  database: Kysely<DatabaseSchema>,
  connectionId: string,
): Promise<boolean> {
  const row = await database
    .selectFrom("agentConnections")
    .select("grant")
    .where("id", "=", connectionId)
    .executeTakeFirst();
  return row ? AgentGrantSchema.parse(row.grant).scope === "everything" : false;
}
