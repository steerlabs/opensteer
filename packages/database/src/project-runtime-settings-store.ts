import {
  CommandIdSchema,
  HarnessInstanceIdSchema,
  ModelSelectionSchema,
  OpensteerError,
  ThreadAccessModeSchema,
  TimeZoneSchema,
  WorkspaceIdSchema,
  createId,
  matchModelSelection,
  storedModelSelection,
  type AuthenticatedHuman,
  type EnvironmentId,
  type ModelSelection,
  type RunnerId,
  type WorkspaceId,
} from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { createHash } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod";
import { checkAccess } from "./access-store.js";
import { withDatabaseTransaction } from "./connection.js";
import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { jsonValue, lockCommandIdempotency, lockWorkspaceRow } from "./store-primitives.js";
import type { DatabaseSchema, ProjectRuntimeSettingsTable } from "./schema.js";

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const settingsInput = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  expectedAccessRevision: revision,
  expectedSettingsRevision: revision.nullable(),
  commandIdentity: CommandIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  modelSelection: ModelSelectionSchema.omit({ nativeModelId: true }),
  accessMode: ThreadAccessModeSchema,
  instructions: z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= 65_536,
      "Project instructions exceed 65536 bytes",
    ),
  timeZone: TimeZoneSchema,
});

export type ProjectRuntimeSettings = Omit<Selectable<ProjectRuntimeSettingsTable>, "revision"> & {
  revision: number;
};
type UnavailableReason =
  | "not-configured"
  | "computer-offline"
  | "engine-unavailable"
  | "model-unavailable"
  | "runner-update-required";
export type ProjectRuntimeResolution =
  | { state: "ready"; settings: ProjectRuntimeSettings; environmentId: EnvironmentId }
  | { state: "unavailable"; reason: UnavailableReason };

function settingsFromRow(row: Selectable<ProjectRuntimeSettingsTable>): ProjectRuntimeSettings {
  return {
    ...row,
    revision: revision.parse(Number(row.revision)),
    modelSelection: ModelSelectionSchema.parse(row.modelSelection),
  };
}

function refuse(message: string): never {
  throw new OpensteerError({ code: "forbidden", message });
}

function conflict(message: string): never {
  throw new OpensteerError({ code: "conflict", message });
}

async function projectWorkspace(database: Kysely<DatabaseSchema>, workspaceId: WorkspaceId) {
  const workspace = await database
    .selectFrom("workspaces")
    .select(["ownerEnvironmentId", "backing"])
    .where("id", "=", workspaceId)
    .where("kind", "=", "project")
    .where("deletedAt", "is", null)
    .where("status", "not in", ["deleting", "deleted"])
    .executeTakeFirst();
  if (!workspace?.ownerEnvironmentId) refuse("A live Project is required");
  return workspace;
}

async function selectedRuntime(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  harnessInstanceId: ProjectRuntimeSettings["harnessInstanceId"],
  selection: ModelSelection,
) {
  const workspace = await projectWorkspace(database, workspaceId);
  const instance = await database
    .selectFrom("harnessInstances")
    .innerJoin(
      "executionEnvironments",
      "executionEnvironments.id",
      "harnessInstances.environmentId",
    )
    .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
    .select([
      "harnessInstances.id",
      "harnessInstances.environmentId",
      "harnessInstances.driverKind",
      "harnessInstances.enabled",
      "harnessInstances.removedAt",
      "harnessInstances.stateKind",
      "runners.id as runnerId",
      "runners.ownerKind",
      "runners.revokedAt",
      "runners.updateRequired",
      "runners.capabilities",
    ])
    .where("harnessInstances.id", "=", harnessInstanceId)
    .executeTakeFirst();
  if (
    !instance ||
    instance.ownerKind !== "deployment" ||
    instance.environmentId !== workspace.ownerEnvironmentId ||
    !instance.enabled ||
    instance.removedAt ||
    instance.stateKind !== "isolated" ||
    (instance.driverKind !== "codex" && instance.driverKind !== "claude")
  )
    return { state: "unavailable", reason: "engine-unavailable" } as const;
  if (instance.revokedAt) return { state: "unavailable", reason: "computer-offline" } as const;
  const row = await database
    .selectFrom("harnessCatalogs")
    .select("catalog")
    .where("environmentId", "=", instance.environmentId)
    .where("harnessInstanceId", "=", instance.id)
    .executeTakeFirst();
  const catalog = row && HarnessInstanceCatalogSchema.parse(row.catalog);
  if (
    !catalog ||
    catalog.status !== "ready" ||
    catalog.harnessInstanceId !== instance.id ||
    catalog.driverKind !== instance.driverKind
  )
    return { state: "unavailable", reason: "engine-unavailable" } as const;
  const match = matchModelSelection(catalog.models, selection, "refuse");
  if (match.kind !== "offered")
    return { state: "unavailable", reason: "model-unavailable" } as const;
  return {
    state: "ready",
    instance,
    modelSelection: storedModelSelection(selection, match.model),
  } as const;
}

export async function getProjectRuntimeSettings(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<ProjectRuntimeSettings | null> {
  await assertProjectAuthority(database);
  await projectWorkspace(database, workspaceId);
  const row = await database
    .selectFrom("projectRuntimeSettings")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .executeTakeFirst();
  return row ? settingsFromRow(row) : null;
}

export async function setProjectRuntimeSettings(
  database: Kysely<DatabaseSchema>,
  authenticatedHuman: AuthenticatedHuman,
  input: z.input<typeof settingsInput>,
): Promise<ProjectRuntimeSettings> {
  await assertProjectAuthority(database);
  const parsed = settingsInput.parse(input);
  const fingerprint = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  return withDatabaseTransaction(database, async (transaction) => {
    await assertProjectAuthority(transaction);
    const access = await transaction
      .selectFrom("accessState")
      .select("revision")
      .where("singletonKey", "=", "primary")
      .forShare()
      .executeTakeFirstOrThrow();
    await lockCommandIdempotency(transaction, authenticatedHuman.userId, parsed.commandIdentity);
    await lockWorkspaceRow(transaction, parsed.workspaceId);
    const placement = await transaction
      .selectFrom("harnessInstances")
      .innerJoin(
        "executionEnvironments",
        "executionEnvironments.id",
        "harnessInstances.environmentId",
      )
      .select(["harnessInstances.environmentId", "executionEnvironments.runnerId"])
      .where("harnessInstances.id", "=", parsed.harnessInstanceId)
      .executeTakeFirst();
    if (!placement?.runnerId) refuse("A deployment-owned engine is required");
    await transaction
      .selectFrom("runners")
      .select("id")
      .where("id", "=", placement.runnerId)
      .forShare()
      .executeTakeFirstOrThrow();
    await transaction
      .selectFrom("workspaceMemberships")
      .select("id")
      .where("workspaceId", "=", parsed.workspaceId)
      .where("userId", "=", authenticatedHuman.userId)
      .forShare()
      .execute();
    const allowed = await checkAccess(transaction, {
      principal: { kind: "person", userId: authenticatedHuman.userId },
      callerKind: "person",
      target: { kind: "project", workspaceId: parsed.workspaceId },
      action: "manage",
      ...(authenticatedHuman.authorityGeneration === undefined
        ? {}
        : { expectedMemberGeneration: authenticatedHuman.authorityGeneration }),
    });
    if (!allowed.allowed) refuse("An active admitted Project manager is required");
    const environment = await transaction
      .selectFrom("executionEnvironments")
      .select("runnerId")
      .where("id", "=", placement.environmentId)
      .forShare()
      .executeTakeFirstOrThrow();
    const instance = await transaction
      .selectFrom("harnessInstances")
      .select("environmentId")
      .where("id", "=", parsed.harnessInstanceId)
      .forShare()
      .executeTakeFirstOrThrow();
    if (
      environment.runnerId !== placement.runnerId ||
      instance.environmentId !== placement.environmentId
    )
      conflict("Project runtime placement changed");
    const previous = await transaction
      .selectFrom("projectRuntimeSettings")
      .selectAll()
      .where("workspaceId", "=", parsed.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const receipt = await transaction
      .selectFrom("securityAudit")
      .select(["actorUserId", "metadata"])
      .where("action", "=", "project-runtime-settings.updated")
      .where("requestId", "=", parsed.commandIdentity)
      .where("actorUserId", "=", authenticatedHuman.userId)
      .executeTakeFirst();
    if (receipt) {
      const saved = z.object({ fingerprint: z.string(), revision }).parse(receipt.metadata);
      if (saved.fingerprint !== fingerprint)
        conflict("Settings command identity was reused with different input");
      if (!previous || Number(previous.revision) !== saved.revision)
        conflict("Settings changed after this command");
      return settingsFromRow(previous);
    }
    if (
      Number(access.revision) !== parsed.expectedAccessRevision ||
      (previous ? Number(previous.revision) : null) !== parsed.expectedSettingsRevision
    )
      conflict("Project runtime settings or access revision changed");
    await transaction
      .selectFrom("harnessCatalogs")
      .select("harnessInstanceId")
      .where("environmentId", "=", placement.environmentId)
      .where("harnessInstanceId", "=", parsed.harnessInstanceId)
      .forShare()
      .execute();
    const runtime = await selectedRuntime(
      transaction,
      parsed.workspaceId,
      parsed.harnessInstanceId,
      parsed.modelSelection,
    );
    if (runtime.state !== "ready") refuse(`Project runtime is unavailable: ${runtime.reason}`);
    const nextRevision = revision.parse(previous ? Number(previous.revision) + 1 : 1);
    const updated = await transaction
      .insertInto("projectRuntimeSettings")
      .values({
        workspaceId: parsed.workspaceId,
        harnessInstanceId: parsed.harnessInstanceId,
        modelSelection: jsonValue(runtime.modelSelection),
        accessMode: parsed.accessMode,
        instructions: parsed.instructions,
        timeZone: parsed.timeZone,
        revision: nextRevision,
        updatedBy: authenticatedHuman.userId,
        updatedAt: sql`now()`,
      })
      .onConflict((row) =>
        row.column("workspaceId").doUpdateSet({
          harnessInstanceId: parsed.harnessInstanceId,
          modelSelection: jsonValue(runtime.modelSelection),
          accessMode: parsed.accessMode,
          instructions: parsed.instructions,
          timeZone: parsed.timeZone,
          revision: nextRevision,
          updatedBy: authenticatedHuman.userId,
          updatedAt: sql`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    const result = settingsFromRow(updated);
    await transaction
      .insertInto("securityAudit")
      .values({
        id: createId("securityAudit"),
        action: "project-runtime-settings.updated",
        actorUserId: authenticatedHuman.userId,
        actorSessionId: null,
        workspaceId: parsed.workspaceId,
        requestId: parsed.commandIdentity,
        targetId: parsed.workspaceId,
        targetType: "project",
        metadata: jsonValue({ fingerprint, revision: result.revision }),
      })
      .execute();
    return result;
  });
}

export async function resolveProjectRuntime(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  runnerIsConnected: (runnerId: RunnerId) => boolean,
): Promise<ProjectRuntimeResolution> {
  const settings = await getProjectRuntimeSettings(database, workspaceId);
  if (!settings) return { state: "unavailable", reason: "not-configured" };
  const runtime = await selectedRuntime(
    database,
    workspaceId,
    settings.harnessInstanceId,
    settings.modelSelection,
  );
  if (runtime.state !== "ready") return runtime;
  if (!runnerIsConnected(runtime.instance.runnerId))
    return { state: "unavailable", reason: "computer-offline" };
  if (
    runtime.instance.updateRequired ||
    !runtime.instance.capabilities.includes("project-authority-v1")
  )
    return { state: "unavailable", reason: "runner-update-required" };
  return {
    state: "ready",
    settings: { ...settings, modelSelection: runtime.modelSelection },
    environmentId: runtime.instance.environmentId,
  };
}
