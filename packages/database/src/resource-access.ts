import { pluginPolicyAllows } from "./plugin-settings-store.js";
import {
  SpecialistManifestSchema,
  BrowserProfileIdSchema,
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
  readonly specialistId?: string;
  readonly resource?: {
    readonly type: "integration" | "browser-profile" | "computer-app" | "phone";
    readonly id: string;
  };
  /** An additional ceiling supplied by a trusted caller. */
  readonly specialistAccess?: ResourceAccessLevel | null;
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
  let specialistAccess = input.specialistAccess;
  const specialistId = root?.specialistId ?? input.specialistId;
  let specialistPolicyAllowed = true;
  if (specialistId) {
    const registration = await database
      .selectFrom("specialists")
      .innerJoin("pluginVersions", "pluginVersions.id", "specialists.pluginVersionId")
      .innerJoin(
        "workspaceMemberships",
        "workspaceMemberships.workspaceId",
        "specialists.workspaceId",
      )
      .select([
        "specialists.status",
        "specialists.bindings",
        "specialists.pluginId",
        "pluginVersions.specialistManifest",
      ])
      .where("specialists.removedAt", "is", null)
      .where("specialists.id", "=", specialistId)
      .where("specialists.workspaceId", "=", input.workspaceId)
      .where("specialists.ownerUserId", "=", input.ownerUserId)
      .where("workspaceMemberships.userId", "=", input.ownerUserId)
      .where("workspaceMemberships.state", "=", "active")
      .executeTakeFirst();
    if (registration && agentRequester)
      specialistPolicyAllowed =
        (await pluginPolicyAllows(
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
        ));
    const manifest = registration
      ? SpecialistManifestSchema.parse(registration.specialistManifest)
      : null;
    const binding =
      registration?.status === "ready" && input.resource
        ? registration.bindings.find(
            (binding) =>
              binding.resourceId === input.resource?.id &&
              manifest?.access?.[binding.requirement]?.type === input.resource.type,
          )
        : undefined;
    let liveAccess: ResourceAccessLevel | null = null;
    if (binding && input.resource?.type === "browser-profile") {
      const profile = await database
        .selectFrom("browserProfiles")
        .select("id")
        .where("id", "=", BrowserProfileIdSchema.parse(binding.resourceId))
        .where("ownerId", "=", input.ownerUserId)
        .where("archivedAt", "is", null)
        .executeTakeFirst();
      if (profile) {
        const grants = await database
          .selectFrom("browserProfileGrants")
          .select("access")
          .where("workspaceId", "=", input.workspaceId)
          .where("createdBy", "=", input.ownerUserId)
          .where("profileId", "=", profile.id)
          .where("revokedAt", "is", null)
          .execute();
        liveAccess = inheritsMain
          ? "read-write"
          : grants.some((g) => g.access === "read-write")
            ? "read-write"
            : (grants[0]?.access ?? null);
      }
    } else if (binding && input.resource) {
      const connection = await database
        .selectFrom("integrationConnections")
        .selectAll()
        .where("id", "=", binding.resourceId as DatabaseSchema["integrationConnections"]["id"])
        .where("ownerUserId", "=", input.ownerUserId)
        .where("status", "=", "connected")
        .where("computerBlockedAt", "is", null)
        .executeTakeFirst();
      const requirement = manifest?.access?.[binding.requirement];
      const matches =
        connection &&
        requirement &&
        (requirement.type === "integration"
          ? connection.provider === requirement.service ||
            connection.integrationDefinitionId === requirement.service
          : requirement.type === "phone"
            ? connection.integrationDefinitionId === "android-phone"
            : requirement.type === "computer-app" &&
              connection.integrationDefinitionId === "macos-app" &&
              connection.computerAppKey === requirement.app.toLowerCase());
      if (connection && matches) {
        const grants = await database
          .selectFrom("integrationGrants")
          .innerJoin(
            "integrationInstallations",
            "integrationInstallations.id",
            "integrationGrants.installationId",
          )
          .select("integrationGrants.access")
          .where("integrationGrants.workspaceId", "=", input.workspaceId)
          .where("integrationGrants.ownerUserId", "=", input.ownerUserId)
          .where("integrationGrants.connectionId", "=", connection.id)
          .where("integrationGrants.status", "=", "active")
          .where("integrationGrants.revokedAt", "is", null)
          .where("integrationInstallations.status", "=", "active")
          .execute();
        liveAccess = inheritsMain
          ? "read-write"
          : grants.some((g) => g.access === "read-write")
            ? "read-write"
            : (grants[0]?.access ?? null);
        if (connection.connectionKind === "computer")
          liveAccess = intersectResourceAccess(liveAccess, connection.computerAccess);
      }
    }
    specialistAccess = intersectResourceAccess(
      intersectResourceAccess(liveAccess, binding?.level ?? null),
      specialistAccess,
    );
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
    policyAllowed && specialistPolicyAllowed
      ? intersectResourceAccess(
          intersectResourceAccess(
            inheritsMain ? "read-write" : (input.explicitAccess ?? null),
            input.connectionCeiling,
          ),
          specialistAccess,
        )
      : null;
  return {
    access,
    specialistId,
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
