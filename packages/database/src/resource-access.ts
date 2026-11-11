import { integrationAccessCeilingForRun } from "@opensteer/integration-core/effective-grants";
import { pluginPolicyAllows } from "./plugin-settings-store.js";
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
  readonly resource?: {
    readonly type: "integration" | "browser-profile" | "computer-app" | "phone";
    readonly id: string;
  };
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
        .select(["createdBy", "specialistId", "accessMode"])
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
        .where("status", "in", ["queued", "starting", "running", "waiting"])
        .orderBy("createdAt", "desc")
        .executeTakeFirst()
    : undefined;
  const runAccess = integrationAccessCeilingForRun(
    connection?.accessMode ?? run?.accessMode ?? thread?.accessMode ?? "full-access",
  );
  const agentRequester = Boolean(threadId || input.agentBindingId || input.connectionId);
  let specialistAllowed = true;
  if (thread?.specialistId) {
    const registration = await database
      .selectFrom("specialists")
      .select("pluginId")
      .where("id", "=", thread.specialistId)
      .where("ownerUserId", "=", input.ownerUserId)
      .where("removedAt", "is", null)
      .executeTakeFirst();
    specialistAllowed =
      Boolean(registration) &&
      (!agentRequester ||
        ((await pluginPolicyAllows(database, input.ownerUserId, {
          kind: "specialist",
          pluginId: registration!.pluginId,
          ownerUserId: input.ownerUserId,
        })) &&
          (await pluginPolicyAllows(database, input.ownerUserId, {
            kind: "plugin",
            pluginId: registration!.pluginId,
          }))));
  }
  let policyAllowed = true;
  if (agentRequester && input.resource && input.resource.type !== "browser-profile") {
    const resource = await database
      .selectFrom("integrationConnections")
      .select(["integrationDefinitionId", "connectionKind"])
      .where("id", "=", input.resource.id as DatabaseSchema["integrationConnections"]["id"])
      .where("ownerUserId", "=", input.ownerUserId)
      .executeTakeFirst();
    if (resource?.integrationDefinitionId)
      policyAllowed = await pluginPolicyAllows(database, input.ownerUserId, {
        kind: resource.connectionKind === "computer" ? "device-app" : "service",
        definitionId: resource.integrationDefinitionId,
      });
  }
  return {
    runAccess,
    access:
      policyAllowed && specialistAllowed
        ? intersectResourceAccess(
            intersectResourceAccess(input.explicitAccess ?? null, input.connectionCeiling),
            runAccess,
          )
        : null,
    specialistAllowed,
  };
}

export async function assertLineageCompatibleReuse(
  database: Kysely<DatabaseSchema>,
  callerId: ThreadId,
  targetId: ThreadId,
): Promise<void> {
  const rows = await database
    .selectFrom("threads")
    .select(["id", "createdBy", "specialistId", "accessMode"])
    .where("id", "in", [callerId, targetId])
    .execute();
  const caller = rows.find((row) => row.id === callerId);
  const target = rows.find((row) => row.id === targetId);
  if (
    !caller ||
    !target ||
    caller.createdBy !== target.createdBy ||
    !threadAccessModeAtMost(target.accessMode, caller.accessMode) ||
    (caller.specialistId && caller.specialistId !== target.specialistId)
  )
    throw new OpensteerError({ code: "forbidden", message: "Start a new task for this work" });
  await assertPersonalOwner(database, caller.createdBy);
}
