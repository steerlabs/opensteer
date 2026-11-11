import { checkAccess, mutateAccess, type AccessWorkRevocationPort } from "./access-store.js";
import { createHash } from "node:crypto";
import {
  matchModelSelection,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
  OpensteerError,
  createId,
  nonTerminalRunStatuses,
  type AuthenticatedHuman,
  type CommandId,
} from "@opensteer/core";
import { lockTeamHuman, requireTeamHuman, teamRefusal } from "./team-administration-authority.js";
import { jsonValue, safeGeneration } from "./store-primitives.js";
import { HarnessInstanceCatalogSchema, type RuntimeState } from "@opensteer/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { teamComputerHasExecutionGrant } from "./team-computer.js";

export interface ProjectHomeChatPort {
  ensureHomeChat(input: {
    readonly workspaceId: WorkspaceId;
    /** The acting person, never an execution identity or a stored-creator fallback. */
    readonly createdBy: UserId;
    readonly settingsRevision: number | null;
    readonly inheritsMain: false;
  }): Promise<TeamProjectChatState>;
}

export type TeamProjectChatState =
  | { readonly state: "not-configured"; readonly homeThreadId: null }
  | { readonly state: "ready"; readonly homeThreadId: ThreadId };

export async function teamProjectRuntimes(
  database: Kysely<DatabaseSchema>,
  workspaceIds: readonly WorkspaceId[],
  connected: (id: RunnerId) => boolean,
): Promise<Map<WorkspaceId, RuntimeState>> {
  if (!workspaceIds.length) return new Map();
  const rows = await database
    .selectFrom("workspaces as w")
    .leftJoin("projectRuntimeSettings as s", "s.workspaceId", "w.id")
    .leftJoin("harnessInstances as h", "h.id", "s.harnessInstanceId")
    .leftJoin("executionEnvironments as e", "e.id", "h.environmentId")
    .leftJoin("runners as r", "r.id", "e.runnerId")
    .leftJoin("harnessCatalogs as c", "c.harnessInstanceId", "h.id")
    .select([
      "w.id",
      "w.homeThreadId",
      "w.ownerEnvironmentId",
      "w.status",
      "s.revision",
      "s.modelSelection",
      "h.environmentId",
      "h.driverKind",
      "h.enabled",
      "h.removedAt",
      "h.stateKind",
      "r.id as runnerId",
      "r.revokedAt",
      "r.updateRequired",
      "r.capabilities",
      "r.ownerKind",
      "r.ownerUserId",
      "r.device",
      "r.allowedModules",
      "c.catalog",
    ])
    .where("w.id", "in", [...workspaceIds])
    .execute();
  return new Map(
    rows.map((row) => {
      let reason: Exclude<RuntimeState, { state: "ready" }>["reason"] | null = null;
      if (!row.revision || !row.homeThreadId) reason = "not-configured";
      else if (!row.runnerId || row.revokedAt || !connected(row.runnerId) || row.status !== "ready")
        reason = "computer-offline";
      else if (row.updateRequired || !row.capabilities?.includes("project-authority-v1"))
        reason = "runner-update-required";
      else if (
        !row.ownerKind ||
        !row.allowedModules ||
        !teamComputerHasExecutionGrant({
          ...row,
          ownerKind: row.ownerKind,
          allowedModules: row.allowedModules,
        }) ||
        row.environmentId !== row.ownerEnvironmentId ||
        !row.enabled ||
        row.removedAt ||
        row.stateKind !== "isolated" ||
        (row.driverKind !== "codex" && row.driverKind !== "claude")
      )
        reason = "engine-unavailable";
      else {
        const catalog = HarnessInstanceCatalogSchema.safeParse(row.catalog);
        if (!catalog.success || catalog.data.status !== "ready") reason = "engine-unavailable";
        else if (
          !row.modelSelection ||
          matchModelSelection(catalog.data.models, row.modelSelection, "refuse").kind !== "offered"
        )
          reason = "model-unavailable";
      }
      const runtime: RuntimeState = reason ? { state: "unavailable", reason } : { state: "ready" };
      return [row.id, runtime];
    }),
  );
}

export async function teamProjectAudiences(
  database: Kysely<DatabaseSchema>,
  viewer: UserId,
  ids: readonly WorkspaceId[],
) {
  if (!ids.length)
    return new Map<WorkspaceId, { people: number; myLevel: "use" | "manage" | null }>();
  const rows = await database
    .selectFrom("workspaceMemberships as m")
    .innerJoin("users as u", "u.id", "m.userId")
    .select([
      "m.workspaceId",
      sql<number>`count(*)::int`.as("people"),
      sql<
        "use" | "manage" | null
      >`max(case when m.user_id = ${viewer} then case when m.role = 'owner' then 'manage' else 'use' end end)`.as(
        "myLevel",
      ),
    ])
    .where("m.workspaceId", "in", [...ids])
    .where("m.state", "=", "active")
    .where("u.admittedAt", "is not", null)
    .where("u.memberState", "=", "active")
    .where("u.disabledAt", "is", null)
    .groupBy("m.workspaceId")
    .execute();
  return new Map(
    rows.map((row) => [row.workspaceId, { people: row.people, myLevel: row.myLevel }]),
  );
}

export interface ProjectComputerRevocationPort {
  reserve(
    transaction: Transaction<DatabaseSchema>,
    runnerId: RunnerId,
  ): Promise<{ cancel(): Promise<void> }>;
}

export async function teamComputerReplacementCan(database: Kysely<DatabaseSchema>) {
  const project = await database
    .selectFrom("workspaces")
    .select("id")
    .where("kind", "=", "project")
    .where("status", "!=", "deleted")
    .limit(1)
    .executeTakeFirst();
  return project
    ? { allowed: false as const, reason: "projects-prevent-replacement" as const }
    : { allowed: true as const };
}

export async function requireTeamComputerReplacementAvailable(database: Kysely<DatabaseSchema>) {
  const can = await teamComputerReplacementCan(database);
  if (!can.allowed) teamRefusal(can.reason);
}

export async function prepareTeamComputerReplacement(
  database: Kysely<DatabaseSchema>,
  actor: AuthenticatedHuman,
  input: {
    readonly commandId: CommandId;
    readonly expectedRevision: number;
    readonly expectedComputerId: RunnerId | null;
  },
  revocation?: ProjectComputerRevocationPort,
) {
  return database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended('opensteer:access-writer', 0))`.execute(
      transaction,
    );
    // FOR UPDATE: replacement and access changes share the authority revision fence.
    const state = await transaction
      .selectFrom("accessState")
      .select("revision")
      .where("singletonKey", "=", "primary")
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await requireTeamHuman(transaction, actor, true);
    await requireTeamComputerReplacementAvailable(transaction);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const receipt = await transaction
      .selectFrom("securityAudit")
      .select("metadata")
      .where("requestId", "=", input.commandId)
      .where("actorUserId", "=", actor.userId)
      .where("action", "=", "team.computer.replaced")
      .executeTakeFirst();
    const revision = safeGeneration(state.revision);
    if (receipt) {
      if (receipt.metadata.fingerprint !== fingerprint || receipt.metadata.revision !== revision)
        teamRefusal("access-revision-changed", "conflict");
      return { accessRevision: revision, revokedComputerId: input.expectedComputerId };
    }
    if (revision !== input.expectedRevision) teamRefusal("access-revision-changed", "conflict");
    const discovered = (
      await transaction
        .selectFrom("runners")
        .select(["id", "ownerKind", "ownerUserId", "device", "allowedModules"])
        .where("ownerKind", "=", "deployment")
        .where("ownerUserId", "is", null)
        .where("revokedAt", "is", null)
        .execute()
    ).filter(teamComputerHasExecutionGrant);
    if (discovered.length > 1 || (discovered[0]?.id ?? null) !== input.expectedComputerId)
      teamRefusal("invalid-selection", "conflict");
    const workRevocation =
      input.expectedComputerId && revocation
        ? await revocation.reserve(transaction, input.expectedComputerId)
        : null;
    // FOR UPDATE: freeze enrollment receipts before reserving the single computer slot.
    await transaction
      .selectFrom("runnerEnrollments")
      .select("id")
      .where("ownerKind", "=", "deployment")
      .where("ownerUserId", "is", null)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    // FOR UPDATE: computer admission takes Runner rows before the team slot advisory fence.
    await transaction
      .selectFrom("runners")
      .select("id")
      .where("ownerKind", "=", "deployment")
      .where("ownerUserId", "is", null)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    await sql`select pg_advisory_xact_lock(hashtextextended('deployment-team-computer', 0))`.execute(
      transaction,
    );
    const computers = await transaction
      .selectFrom("runners")
      .select(["id", "ownerKind", "ownerUserId", "device", "allowedModules"])
      .where("ownerKind", "=", "deployment")
      .where("ownerUserId", "is", null)
      .where("revokedAt", "is", null)
      .execute();
    const current = computers.filter(teamComputerHasExecutionGrant);
    if (current.length > 1 || (current[0]?.id ?? null) !== input.expectedComputerId)
      teamRefusal("invalid-selection", "conflict");
    if (input.expectedComputerId && !workRevocation) {
      const work = await transaction
        .selectFrom("runs")
        .innerJoin("executionEnvironments as e", "e.id", "runs.environmentId")
        .select("runs.id")
        .where("e.runnerId", "=", input.expectedComputerId)
        .where("runs.status", "in", nonTerminalRunStatuses)
        .limit(1)
        .executeTakeFirst();
      const pending = await transaction
        .selectFrom("requests")
        .innerJoin("runs", "runs.id", "requests.originatingRunId")
        .innerJoin("executionEnvironments as e", "e.id", "runs.environmentId")
        .select("requests.id")
        .where("e.runnerId", "=", input.expectedComputerId)
        .where("requests.status", "=", "pending")
        .limit(1)
        .executeTakeFirst();
      const watch = await transaction
        .selectFrom("triggerWatchActivations")
        .select("id")
        .where("runnerId", "=", input.expectedComputerId)
        .where("desired", "=", "active")
        .limit(1)
        .executeTakeFirst();
      const queuedInput = await transaction
        .selectFrom("threadInputs")
        .innerJoin("threads", "threads.id", "threadInputs.threadId")
        .innerJoin("executionEnvironments as e", "e.id", "threads.environmentId")
        .select("threadInputs.messageId")
        .where("e.runnerId", "=", input.expectedComputerId)
        .where("threadInputs.state", "in", ["pending", "claimed", "unknown"])
        .limit(1)
        .executeTakeFirst();
      const continuation = await transaction
        .selectFrom("requestContinuations")
        .innerJoin("requests", "requests.id", "requestContinuations.requestId")
        .innerJoin("runs", "runs.id", "requests.originatingRunId")
        .innerJoin("executionEnvironments as e", "e.id", "runs.environmentId")
        .select("requestContinuations.requestId")
        .where("e.runnerId", "=", input.expectedComputerId)
        .where("requestContinuations.status", "in", ["waiting", "queued"])
        .limit(1)
        .executeTakeFirst();
      if (work || pending || watch || queuedInput || continuation)
        throw new OpensteerError({
          code: "workspace_unavailable",
          reason: "team-not-implemented",
          message:
            "Project binding revocation must be connected before replacing a computer with live work",
        });
    }
    await transaction
      .updateTable("runnerEnrollments")
      .set({ expiresAt: new Date() })
      .where("ownerKind", "=", "deployment")
      .where("ownerUserId", "is", null)
      .where("consumedAt", "is", null)
      .execute();
    if (input.expectedComputerId)
      await transaction
        .updateTable("runners")
        .set({ revokedAt: new Date() })
        .where("id", "=", input.expectedComputerId)
        .execute();
    await workRevocation?.cancel();
    const next = safeGeneration(revision + 1);
    await transaction
      .updateTable("accessState")
      .set({ revision: next })
      .where("singletonKey", "=", "primary")
      .execute();
    await transaction
      .insertInto("securityAudit")
      .values({
        id: createId("securityAudit"),
        action: "team.computer.replaced",
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId ?? null,
        requestId: input.commandId,
        targetType: "runner",
        targetId: input.expectedComputerId,
        workspaceId: null,
        metadata: jsonValue({ fingerprint, revision: next }),
      })
      .execute();
    await lockTeamHuman(transaction, actor, true);
    return { accessRevision: next, revokedComputerId: input.expectedComputerId };
  });
}

export async function requireTeamProjectManager(
  database: Kysely<DatabaseSchema>,
  actor: AuthenticatedHuman,
  workspaceId: WorkspaceId,
): Promise<void> {
  await requireTeamHuman(database, actor);
  if (
    !(
      await checkAccess(database, {
        principal: { kind: "person", userId: actor.userId },
        callerKind: "person",
        target: { kind: "project", workspaceId },
        action: "manage",
      })
    ).allowed
  )
    teamRefusal("project-manage-required");
}

export async function deleteTeamProject(
  database: Kysely<DatabaseSchema>,
  actor: AuthenticatedHuman,
  input: {
    readonly workspaceId: WorkspaceId;
    readonly commandId: CommandId;
    readonly expectedRevision: number;
    readonly retentionMilliseconds: number;
  },
  work?: AccessWorkRevocationPort,
) {
  const authorize = async () => {
    const user = await requireTeamHuman(database, actor);
    if (user.instanceRole === "administrator") return;
    const decision = await checkAccess(database, {
      principal: { kind: "person", userId: actor.userId },
      callerKind: "person",
      target: { kind: "project", workspaceId: input.workspaceId },
      action: "manage",
    });
    if (decision.allowed) return;
    const ownDeletion = await database
      .selectFrom("workspaces")
      .select("id")
      .where("id", "=", input.workspaceId)
      .where("deletionRequestedBy", "=", actor.userId)
      .where("status", "in", ["deleting", "deleted"])
      .executeTakeFirst();
    if (!ownDeletion) teamRefusal("team-object-unavailable", "not_found");
  };
  const deleted = async () => {
    await authorize();
    const row = await database
      .selectFrom("workspaces")
      .select("status")
      .where("id", "=", input.workspaceId)
      .where("kind", "=", "project")
      .executeTakeFirst();
    return row?.status === "deleting" || row?.status === "deleted";
  };
  const acknowledgement = async () => ({
    revision: safeGeneration(
      (
        await database
          .selectFrom("accessState")
          .select("revision")
          .where("singletonKey", "=", "primary")
          .executeTakeFirstOrThrow()
      ).revision,
    ),
    transitions: [],
  });
  if (await deleted()) return acknowledgement();
  try {
    return await mutateAccess(
      database,
      {
        actor,
        expectedRevision: input.expectedRevision,
        commandIdentity: input.commandId,
        changes: [
          {
            kind: "delete-project",
            workspaceId: input.workspaceId,
            retentionMilliseconds: input.retentionMilliseconds,
          },
        ],
      },
      work,
    );
  } catch (error) {
    if (
      error instanceof OpensteerError &&
      (error.code === "conflict" || error.code === "bad_request") &&
      (await deleted())
    )
      return acknowledgement();
    throw error;
  }
}
