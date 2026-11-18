import { integrationAccessCeilingForRun } from "@opensteer/integration-core/effective-grants";
import { assertPersonalOwner } from "./private-resource-owner.js";
import {
  RunIdSchema,
  threadAccessModeAtMost,
  ThreadIdSchema,
  TriggerOccurrenceIdSchema,
  TriggerWatchActivationIdSchema,
  intersectResourceAccess,
  OpensteerError,
  type ResourceAccessLevel,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export interface ResourceAccessInput {
  readonly ownerUserId: UserId;
  readonly connectionId?: string;
  readonly threadId?: ThreadId | undefined;
  readonly agentBindingId?: string;
  readonly explicitAccess?: ResourceAccessLevel | null;
  readonly connectionCeiling?: ResourceAccessLevel | null;
}

export async function resolveResourceAccess(
  database: Kysely<DatabaseSchema>,
  input: ResourceAccessInput,
) {
  await assertPersonalOwner(database, input.ownerUserId);
  let threadId = input.threadId;
  if (!threadId && input.agentBindingId?.startsWith("run:")) {
    threadId = (
      await database
        .selectFrom("runs")
        .select("threadId")
        .where("id", "=", RunIdSchema.parse(input.agentBindingId.slice(4)))
        .where("requestedBy", "=", input.ownerUserId)
        .executeTakeFirst()
    )?.threadId;
  }
  if (!threadId && input.agentBindingId?.startsWith("thread:"))
    threadId = ThreadIdSchema.parse(input.agentBindingId.slice(7));
  if (!threadId && input.agentBindingId?.startsWith("trigger:"))
    threadId = (
      await database
        .selectFrom("triggerOccurrences")
        .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
        .select("triggers.anchorThreadId")
        .where(
          "triggerOccurrences.id",
          "=",
          TriggerOccurrenceIdSchema.parse(input.agentBindingId.slice(8)),
        )
        .executeTakeFirst()
    )?.anchorThreadId;
  if (!threadId && input.agentBindingId?.startsWith("watch:"))
    threadId = (
      await database
        .selectFrom("triggerWatchActivations")
        .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
        .select("triggers.anchorThreadId")
        .where(
          "triggerWatchActivations.id",
          "=",
          TriggerWatchActivationIdSchema.parse(input.agentBindingId.slice(6)),
        )
        .executeTakeFirst()
    )?.anchorThreadId;
  const thread = threadId
    ? await database
        .selectFrom("threads")
        .select(["createdBy", "accessMode"])
        .where("id", "=", threadId)
        .executeTakeFirst()
    : undefined;
  if ((threadId && thread?.createdBy !== input.ownerUserId) || (input.agentBindingId && !threadId))
    throw new OpensteerError({
      code: "forbidden",
      message: "Task authority is no longer available",
    });
  const connection = input.connectionId
    ? await database
        .selectFrom("agentConnections")
        .select("accessMode")
        .where("id", "=", input.connectionId)
        .where("userId", "=", input.ownerUserId)
        .where("revokedAt", "is", null)
        .where("tokenHash", "is not", null)
        .where("expiresAt", ">", new Date())
        .executeTakeFirst()
    : undefined;
  if (input.connectionId && !connection)
    throw new OpensteerError({ code: "forbidden", message: "Connection access was revoked" });
  const run = threadId
    ? await database
        .selectFrom("runs")
        .select("accessMode")
        .where("threadId", "=", threadId)
        .where("requestedBy", "=", input.ownerUserId)
        .$if(Boolean(input.agentBindingId?.startsWith("run:")), (query) =>
          query.where("id", "=", RunIdSchema.parse(input.agentBindingId!.slice(4))),
        )
        .where("status", "in", ["queued", "starting", "running", "waiting"])
        .orderBy("createdAt", "desc")
        .executeTakeFirst()
    : undefined;
  const runAccess = integrationAccessCeilingForRun(
    connection?.accessMode ?? run?.accessMode ?? thread?.accessMode ?? "full-access",
  );
  return {
    runAccess,
    access: intersectResourceAccess(
      intersectResourceAccess(input.explicitAccess ?? null, input.connectionCeiling),
      runAccess,
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
    .select(["id", "createdBy", "accessMode"])
    .where("id", "in", [callerId, targetId])
    .execute();
  const caller = rows.find((row) => row.id === callerId);
  const target = rows.find((row) => row.id === targetId);
  if (
    !caller ||
    !target ||
    caller.createdBy !== target.createdBy ||
    !threadAccessModeAtMost(target.accessMode, caller.accessMode)
  )
    throw new OpensteerError({ code: "forbidden", message: "Start a new task for this work" });
  await assertPersonalOwner(database, caller.createdBy);
}
