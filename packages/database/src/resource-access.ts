import { effectiveMembershipPredicate } from "./effective-membership.js";
import { pluginPolicyAllows } from "./plugin-settings-store.js";
import {
  RunIdSchema,
  ThreadIdSchema,
  TriggerOccurrenceIdSchema,
  TriggerWatchActivationIdSchema,
  intersectResourceAccess,
  lineageCompatibleForReuse,
  threadInReach,
  OpensteerError,
  type ResourceAccessLevel,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export interface ResourceAccessInput {
  readonly ownerUserId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly connectionId?: string;
  readonly threadId?: ThreadId | undefined;
  readonly agentBindingId?: string;
  /** Explicit consent must already be filtered to its owner and active membership. */
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
  let threadId = input.threadId;
  if (!threadId && input.agentBindingId?.startsWith("run:")) {
    const run = await database
      .selectFrom("runs")
      .select("threadId")
      .where("id", "=", RunIdSchema.parse(input.agentBindingId.slice(4)))
      .executeTakeFirst();
    threadId = run?.threadId;
  }
  if (!threadId && input.agentBindingId?.startsWith("thread:"))
    threadId = ThreadIdSchema.parse(input.agentBindingId.slice(7));
  if (!threadId && input.agentBindingId?.startsWith("trigger:")) {
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
  }
  if (!threadId && input.agentBindingId?.startsWith("watch:")) {
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
  }
  const workspace = await database
    .selectFrom("workspaces")
    .select(["kind", "createdBy"])
    .where("id", "=", input.workspaceId)
    .executeTakeFirst();
  const main = workspace?.kind === "main" && workspace.createdBy === input.ownerUserId;
  const root = threadId
    ? await database
        .selectFrom("threads as asking")
        .innerJoin("threads as root", "root.id", "asking.lineageRootThreadId")
        .select(["root.inheritsMain", "asking.workspaceId", "asking.specialistId"])
        .where("asking.id", "=", threadId)
        .executeTakeFirst()
    : undefined;
  const connection = input.connectionId
    ? await database
        .selectFrom("agentConnections")
        .select("workspaceId")
        .where("id", "=", input.connectionId)
        .where("userId", "=", input.ownerUserId)
        .where("revokedAt", "is", null)
        .where("tokenHash", "is not", null)
        .where("expiresAt", ">", new Date())
        .executeTakeFirst()
    : undefined;
  if (
    input.connectionId &&
    (!connection || (connection.workspaceId && connection.workspaceId !== input.workspaceId))
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Connection cannot access this Workspace",
    });
  const inheritsMain =
    main &&
    (input.connectionId
      ? connection?.workspaceId === null
      : root
        ? root.workspaceId === input.workspaceId && root.inheritsMain
        : !input.threadId && !input.agentBindingId);
  // Owner Off and Main exclusion bind every agent, including connections without a Thread.
  const agentRequester = Boolean(threadId || input.agentBindingId || input.connectionId);
  const specialistId = root?.specialistId;
  // A specialist adopts its caller's access; only its owner's live registration carries it.
  let specialistAllowed = true;
  if (specialistId) {
    const registration = await database
      .selectFrom("specialists")
      .innerJoin(
        "workspaceMemberships",
        "workspaceMemberships.workspaceId",
        "specialists.workspaceId",
      )
      .select("specialists.pluginId")
      .where("specialists.removedAt", "is", null)
      .where("specialists.id", "=", specialistId)
      .where("specialists.workspaceId", "=", input.workspaceId)
      .where("specialists.ownerUserId", "=", input.ownerUserId)
      .where("workspaceMemberships.userId", "=", input.ownerUserId)
      .where(effectiveMembershipPredicate(database))
      .executeTakeFirst();
    specialistAllowed =
      registration !== undefined &&
      (!agentRequester ||
        ((await pluginPolicyAllows(
          database,
          input.ownerUserId,
          { kind: "specialist", pluginId: registration.pluginId, ownerUserId: input.ownerUserId },
          main,
        )) &&
          (await pluginPolicyAllows(
            database,
            input.ownerUserId,
            { kind: "plugin", pluginId: registration.pluginId },
            main,
          ))));
  }
  let policyAllowed = true;
  if (agentRequester && input.resource && input.resource.type !== "browser-profile") {
    const connection = await database
      .selectFrom("integrationConnections")
      .select(["integrationDefinitionId", "connectionKind"])
      .where("id", "=", input.resource.id as DatabaseSchema["integrationConnections"]["id"])
      .where("ownerUserId", "=", input.ownerUserId)
      .executeTakeFirst();
    if (connection?.integrationDefinitionId)
      policyAllowed = await pluginPolicyAllows(
        database,
        input.ownerUserId,
        {
          kind: connection.connectionKind === "computer" ? "device-app" : "service",
          definitionId: connection.integrationDefinitionId,
        },
        main,
      );
  }
  const access =
    policyAllowed && specialistAllowed
      ? intersectResourceAccess(
          inheritsMain ? "read-write" : (input.explicitAccess ?? null),
          input.connectionCeiling,
        )
      : null;
  return {
    access,
    specialistAllowed,
    inheritsMain,
    mainAccess: main ? (inheritsMain ? ("inherited" as const) : ("withheld" as const)) : null,
  };
}

export async function assertLineageCompatibleReuse(
  database: Kysely<DatabaseSchema>,
  callerId: ThreadId,
  targetId: ThreadId,
): Promise<void> {
  const roots = await database
    .selectFrom("threads as asking")
    .innerJoin("threads as root", "root.id", "asking.lineageRootThreadId")
    .select([
      "asking.id",
      "asking.specialistId",
      "root.inheritsMain",
      "asking.workspaceId",
      "asking.lineageRootThreadId",
    ])
    .where("asking.id", "in", [callerId, targetId])
    .execute();
  const caller = roots.find((row) => row.id === callerId);
  const target = roots.find((row) => row.id === targetId);
  if (caller?.specialistId && caller.specialistId !== target?.specialistId) {
    throw new OpensteerError({
      code: "forbidden",
      message:
        "Specialists may only send reports to Threads outside their registration. Start a new task instead.",
    });
  }
  if (
    !caller ||
    !target ||
    !lineageCompatibleForReuse(caller, target) ||
    !threadInReach(caller, target)
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message:
        "This Thread's consent scope is incompatible with your lineage. Start a new task instead.",
    });
  }
}
