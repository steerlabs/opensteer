import { isDeepStrictEqual } from "node:util";
import { OpensteerError, type Thread, type WorkspaceId, type UserId } from "@opensteer/core";
import type { HarnessInstanceCatalog } from "@opensteer/protocol";
import type { TriggerProgram, TriggerSource, TriggerSystemRole } from "@opensteer/triggers";
import { sql, type Kysely } from "kysely";
import { withDatabaseTransaction } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";
import { lockCommandIdempotency } from "./store-primitives.js";
import { prepareThreadInsertion } from "./thread-insertion.js";
import { createThreadInTransaction } from "./thread-store.js";
import { createTriggerInTransaction } from "./trigger-store.js";

/** The role row is the receipt, including paused schedules and Done workers. */
export function missingMemoryPassMains(
  database: Kysely<DatabaseSchema>,
  after?: WorkspaceId,
  limit = 20,
) {
  let query = database
    .selectFrom("workspaces")
    .innerJoin("users", "users.id", "workspaces.createdBy")
    .innerJoin("workspaceMemberships as owner", (join) =>
      join
        .onRef("owner.workspaceId", "=", "workspaces.id")
        .onRef("owner.userId", "=", "workspaces.createdBy")
        .on("owner.state", "=", "active")
        .on("owner.role", "=", "owner"),
    )
    .select("workspaces.id")
    .where("workspaces.kind", "=", "main")
    .where("workspaces.status", "=", "ready")
    .where("workspaces.homeThreadId", "is not", null)
    .where("users.disabledAt", "is", null)
    .where("users.timeZone", "is not", null)
    .where(({ or, not, exists, selectFrom }) =>
      or(
        (["memory-light", "memory-nightly"] as const).map((role) =>
          not(
            exists(
              selectFrom("triggers")
                .select("id")
                .whereRef("workspaceId", "=", "workspaces.id")
                .where("systemRole", "=", role),
            ),
          ),
        ),
      ),
    );
  if (after) query = query.where("workspaces.id", ">", after);
  return query.orderBy("workspaces.id").limit(limit).execute();
}

export async function createMemoryPass(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly workspaceId: WorkspaceId;
    readonly ownerId: UserId;
    readonly chat: Thread;
    readonly catalog: HarnessInstanceCatalog;
    readonly runtimeRevision: number;
    readonly systemRole: TriggerSystemRole;
    readonly modelSelection: Thread["modelSelection"];
    readonly program: TriggerProgram;
    readonly source: TriggerSource;
    readonly pauseReason: string | null;
  },
) {
  const key = `memory:${input.workspaceId}:${input.systemRole}`;
  return withDatabaseTransaction(database, async (transaction) => {
    // Creation reservations precede every materialized parent in lock-order.ts.
    await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["trigger-create", input.ownerId, key])}, 0))`.execute(
      transaction,
    );
    await lockCommandIdempotency(transaction, input.ownerId, key);
    const workspace = await transaction
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const existing = await transaction
      .selectFrom("triggers")
      .select("id")
      .where("workspaceId", "=", workspace.id)
      .where("systemRole", "=", input.systemRole)
      .executeTakeFirst();
    if (existing) return null;
    const owner = await transaction
      .selectFrom("workspaceMemberships")
      .select(["role", "state"])
      .where("workspaceId", "=", workspace.id)
      .where("userId", "=", input.ownerId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const user = await transaction
      .selectFrom("users")
      .select("disabledAt")
      .where("id", "=", input.ownerId)
      .executeTakeFirst();
    if (
      workspace.kind !== "main" ||
      workspace.createdBy !== input.ownerId ||
      workspace.status !== "ready" ||
      workspace.homeThreadId !== input.chat.id ||
      owner?.state !== "active" ||
      owner.role !== "owner" ||
      !user ||
      user.disabledAt
    )
      throw snapshotChanged();
    const insertThread = await prepareThreadInsertion(transaction, {
      createdBy: input.ownerId,
      environmentId: input.chat.environmentId,
      harnessInstanceId: input.chat.harnessInstanceId,
    });
    const harness = await transaction
      .selectFrom("harnessInstances")
      .select("runtimeRevision")
      .where("id", "=", input.chat.harnessInstanceId)
      .executeTakeFirstOrThrow();
    const chat = await transaction
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", input.chat.id)
      .forShare()
      .executeTakeFirstOrThrow();
    const catalog = await transaction
      .selectFrom("harnessCatalogs")
      .select("catalog")
      .where("environmentId", "=", chat.environmentId)
      .where("harnessInstanceId", "=", chat.harnessInstanceId)
      .executeTakeFirst();
    if (
      harness.runtimeRevision !== input.runtimeRevision ||
      !isDeepStrictEqual(catalog?.catalog, input.catalog) ||
      chat.workspaceId !== workspace.id ||
      chat.role !== "conversation" ||
      chat.capabilityProfileId !== "main" ||
      chat.lineageRootThreadId !== input.chat.lineageRootThreadId ||
      chat.environmentId !== input.chat.environmentId ||
      chat.harnessInstanceId !== input.chat.harnessInstanceId ||
      chat.accessMode !== input.chat.accessMode ||
      !isDeepStrictEqual(chat.modelSelection, input.chat.modelSelection)
    )
      throw snapshotChanged();
    const created = await createThreadInTransaction(
      transaction,
      {
        createdBy: input.ownerId,
        environmentId: chat.environmentId,
        harnessInstanceId: chat.harnessInstanceId,
        accessMode: chat.accessMode,
        idempotencyKey: key,
        modelSelection: input.modelSelection,
        parentThreadId: chat.id,
        role: "work",
        title: input.systemRole === "memory-light" ? "Memory light pass" : "Memory nightly pass",
        workspaceId: workspace.id,
      },
      { insertThread, unlisted: true },
    );
    const trigger = await createTriggerInTransaction(
      transaction,
      {
        actorThreadId: null,
        anchorThreadId: created.thread.id,
        createdBy: input.ownerId,
        idempotencyKey: key,
        name: created.thread.title,
        program: input.program,
        source: input.source,
      },
      {
        systemRole: input.systemRole,
        paused: input.pauseReason !== null,
        pauseReason: input.pauseReason,
      },
    );
    return { ...trigger, event: created.event };
  });
}

function snapshotChanged() {
  return new OpensteerError({
    code: "conflict",
    message: "Memory pass prerequisites changed",
    retryable: true,
  });
}
