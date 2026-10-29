import { withDatabaseTransaction } from "./connection.js";
import {
  type UserId,
  type EnvironmentId,
  type RunnerId,
  type WorkspaceId,
  OpensteerError,
} from "@opensteer/core";
import { type Selectable, type Kysely } from "kysely";
import { type WorkspaceMountTable, type DatabaseSchema } from "./schema.js";
import {
  safeGeneration,
  requireBoundedIdentity,
  requirePositiveSafeGeneration,
  lockWorkspaceRow,
  boundedWindowLimit,
} from "./store-primitives.js";
import { randomUUID } from "node:crypto";

export interface WorkspaceMountRecord {
  readonly authorizedBy: UserId;
  readonly enrollmentId: string;
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly membershipGeneration: number;
  readonly revocationAttempts: number;
  readonly runnerId: RunnerId;
  readonly status: "active" | "revocation_pending" | "closed" | "revoked" | "expired";
  readonly terminationReason: string | null;
  readonly volumeId: string;
  readonly workspaceId: WorkspaceId;
  readonly workspaceBackingGeneration: number;
}

export interface PendingWorkspaceMountRevocation extends WorkspaceMountRecord {
  readonly revocationAttempt: number;
  readonly status: "revocation_pending";
  readonly terminationReason: string;
}

export interface WorkspaceMountInventoryEntry {
  readonly enrollmentId: string;
  readonly volumeId: string;
  readonly workspaceId: WorkspaceId;
}

function workspaceMountFromRow(row: Selectable<WorkspaceMountTable>): WorkspaceMountRecord {
  return {
    authorizedBy: row.authorizedBy,
    enrollmentId: row.enrollmentId,
    environmentId: row.environmentId,
    id: row.id,
    membershipGeneration: safeGeneration(row.membershipGeneration),
    revocationAttempts: row.revocationAttempts,
    runnerId: row.runnerId,
    status: row.status,
    terminationReason: row.terminationReason,
    volumeId: row.volumeId,
    workspaceBackingGeneration: safeGeneration(row.workspaceBackingGeneration),
    workspaceId: row.workspaceId,
  };
}

export async function recordWorkspaceMount(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly authorizedBy: UserId;
    readonly enrollmentId: string;
    readonly environmentId: EnvironmentId;
    readonly membershipGeneration: number;
    readonly runnerId: RunnerId;
    readonly volumeId: string;
    readonly workspaceBackingGeneration: number;
    readonly workspaceId: WorkspaceId;
  },
): Promise<WorkspaceMountRecord> {
  requireBoundedIdentity(input.enrollmentId, "mount enrollment ID", 256);
  requireBoundedIdentity(input.volumeId, "PortableFS volume ID", 255);
  requirePositiveSafeGeneration(input.membershipGeneration, "Workspace membership generation");
  requirePositiveSafeGeneration(input.workspaceBackingGeneration, "Workspace backing generation");
  return withDatabaseTransaction(database, async (transaction) => {
    await lockWorkspaceRow(transaction, input.workspaceId);
    const authority = await transaction
      .selectFrom("workspaces")
      .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
      .innerJoin("executionEnvironments", (join) =>
        join.on("executionEnvironments.id", "=", input.environmentId),
      )
      .select([
        "executionEnvironments.runnerId",
        "workspaces.backing",
        "workspaceMemberships.generation",
        "workspaceMemberships.state",
      ])
      .where("workspaces.id", "=", input.workspaceId)
      .where("workspaceMemberships.userId", "=", input.authorizedBy)
      .executeTakeFirst();
    if (
      !authority ||
      authority.runnerId !== input.runnerId ||
      authority.state !== "active" ||
      safeGeneration(authority.generation) !== input.membershipGeneration ||
      authority.backing.kind !== "portablefs" ||
      authority.backing.volumeId !== input.volumeId ||
      authority.backing.generation !== input.workspaceBackingGeneration
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Workspace mount authority changed before the exchange completed",
      });
    }
    const existing = await transaction
      .selectFrom("workspaceMounts")
      .selectAll()
      .where("enrollmentId", "=", input.enrollmentId)
      .executeTakeFirst();
    if (existing) {
      const record = workspaceMountFromRow(existing);
      if (record.status !== "active") {
        throw new OpensteerError({
          code: "conflict",
          message: "Mount enrollment identity is no longer active",
        });
      }
      if (
        record.authorizedBy !== input.authorizedBy ||
        record.environmentId !== input.environmentId ||
        record.membershipGeneration !== input.membershipGeneration ||
        record.runnerId !== input.runnerId ||
        record.volumeId !== input.volumeId ||
        record.workspaceBackingGeneration !== input.workspaceBackingGeneration ||
        record.workspaceId !== input.workspaceId
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Mount enrollment identity already belongs to another Workspace mount",
        });
      }
      return record;
    }
    const row = await transaction
      .insertInto("workspaceMounts")
      .values({
        authorizedBy: input.authorizedBy,
        enrollmentId: input.enrollmentId,
        environmentId: input.environmentId,
        id: `wmt_${randomUUID()}`,
        lastErrorCode: null,
        membershipGeneration: input.membershipGeneration,
        nextAttemptAt: null,
        revocationAttempts: 0,
        runnerId: input.runnerId,
        status: "active",
        terminationReason: null,
        updatedAt: new Date(),
        volumeId: input.volumeId,
        workspaceBackingGeneration: input.workspaceBackingGeneration,
        workspaceId: input.workspaceId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return workspaceMountFromRow(row);
  });
}

export async function assertWorkspaceMountAuthority(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly environmentId: EnvironmentId;
    readonly membershipGeneration: number;
    readonly requestedBy: UserId;
    readonly runnerId: RunnerId;
    readonly volumeId: string;
    readonly workspaceBackingGeneration: number;
    readonly workspaceId: WorkspaceId;
  },
): Promise<void> {
  const row = await database
    .selectFrom("workspaces")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
    .innerJoin("executionEnvironments", (join) =>
      join.on("executionEnvironments.id", "=", input.environmentId),
    )
    .select([
      "executionEnvironments.runnerId",
      "workspaceMemberships.generation",
      "workspaceMemberships.state",
      "workspaces.backing",
    ])
    .where("workspaces.id", "=", input.workspaceId)
    .where("workspaceMemberships.userId", "=", input.requestedBy)
    .executeTakeFirst();
  if (
    !row ||
    row.runnerId !== input.runnerId ||
    row.state !== "active" ||
    safeGeneration(row.generation) !== input.membershipGeneration ||
    row.backing.kind !== "portablefs" ||
    row.backing.volumeId !== input.volumeId ||
    row.backing.generation !== input.workspaceBackingGeneration
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Workspace mount authority is stale or unavailable",
    });
  }
}

export async function listWorkspaceMounts(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<readonly WorkspaceMountRecord[]> {
  const rows = await database
    .selectFrom("workspaceMounts")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("status", "in", ["active", "revocation_pending"])
    .orderBy("createdAt", "asc")
    .execute();
  return rows.map(workspaceMountFromRow);
}

export async function listWorkspaceMountsAuthorizedBy(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly authorizedBy: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<readonly WorkspaceMountRecord[]> {
  const rows = await database
    .selectFrom("workspaceMounts")
    .selectAll()
    .where("workspaceId", "=", input.workspaceId)
    .where("authorizedBy", "=", input.authorizedBy)
    .where("status", "in", ["active", "revocation_pending"])
    .orderBy("createdAt", "asc")
    .execute();
  return rows.map(workspaceMountFromRow);
}

export async function listEnvironmentWorkspaceMounts(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
): Promise<readonly WorkspaceMountRecord[]> {
  const rows = await database
    .selectFrom("workspaceMounts")
    .selectAll()
    .where("environmentId", "=", environmentId)
    .where("status", "in", ["active", "revocation_pending"])
    .orderBy("createdAt", "asc")
    .execute();
  return rows.map(workspaceMountFromRow);
}

export async function listReplacedWorkspaceMounts(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly currentGeneration: number;
    readonly workspaceId: WorkspaceId;
  },
): Promise<readonly WorkspaceMountRecord[]> {
  requirePositiveSafeGeneration(input.currentGeneration, "Workspace backing generation");
  const rows = await database
    .selectFrom("workspaceMounts")
    .selectAll()
    .where("workspaceId", "=", input.workspaceId)
    .where("workspaceBackingGeneration", "<", String(input.currentGeneration))
    .where("status", "in", ["active", "revocation_pending"])
    .orderBy("createdAt", "asc")
    .execute();
  return rows.map(workspaceMountFromRow);
}

export async function requestWorkspaceMountRevocations(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly workspaceMountIds: readonly string[];
    readonly now?: Date;
    readonly reason: string;
  },
): Promise<number> {
  requireBoundedIdentity(input.reason, "mount termination reason", 256);
  if (input.workspaceMountIds.length === 0) return 0;
  const now = input.now ?? new Date();
  const result = await database
    .updateTable("workspaceMounts")
    .set({
      nextAttemptAt: now,
      status: "revocation_pending",
      terminationReason: input.reason,
      updatedAt: now,
    })
    .where("id", "in", [...new Set(input.workspaceMountIds)])
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function requestWorkspaceMountRevocationByEnrollmentId(
  database: Kysely<DatabaseSchema>,
  enrollmentId: string,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  requireBoundedIdentity(enrollmentId, "mount enrollment ID", 256);
  requireBoundedIdentity(reason, "mount termination reason", 256);
  const result = await database
    .updateTable("workspaceMounts")
    .set({
      nextAttemptAt: now,
      status: "revocation_pending",
      terminationReason: reason,
      updatedAt: now,
    })
    .where("enrollmentId", "=", enrollmentId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (result.numUpdatedRows === 1n) return true;
  const existing = await database
    .selectFrom("workspaceMounts")
    .select("status")
    .where("enrollmentId", "=", enrollmentId)
    .executeTakeFirst();
  return existing?.status === "revocation_pending";
}

export async function closeEnvironment(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
  reason: string,
  now = new Date(),
): Promise<number> {
  requireBoundedIdentity(reason, "mount termination reason", 256);
  const result = await database
    .updateTable("workspaceMounts")
    .set({
      nextAttemptAt: null,
      status: "closed",
      terminationReason: reason,
      updatedAt: now,
    })
    .where("environmentId", "=", environmentId)
    .where("status", "in", ["active", "revocation_pending"])
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function reconcileRunnerInventory(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly environmentId: EnvironmentId;
    readonly mounts: readonly WorkspaceMountInventoryEntry[];
    readonly now?: Date;
  },
): Promise<readonly WorkspaceMountInventoryEntry[]> {
  const now = input.now ?? new Date();
  const reportedEnrollmentIds = [...new Set(input.mounts.map((mount) => mount.enrollmentId))];
  let closeQuery = database
    .updateTable("workspaceMounts")
    .set({
      nextAttemptAt: now,
      status: "revocation_pending",
      terminationReason: "runner-inventory",
      updatedAt: now,
    })
    .where("environmentId", "=", input.environmentId)
    // Inventory absence proves the mount is gone, not that its Manager-side
    // enrollment is terminal. Preserve that cleanup as durable revocation
    // intent; the reconciler owns it until the Manager reports an outcome.
    .where("status", "=", "active");
  if (reportedEnrollmentIds.length > 0) {
    closeQuery = closeQuery.where("enrollmentId", "not in", reportedEnrollmentIds);
  }
  await closeQuery.executeTakeFirst();
  if (input.mounts.length === 0) return [];
  const active = await database
    .selectFrom("workspaceMounts")
    .select(["enrollmentId", "volumeId", "workspaceId"])
    .where("environmentId", "=", input.environmentId)
    .where("status", "=", "active")
    .where("enrollmentId", "in", reportedEnrollmentIds)
    .execute();
  const known = new Set(
    active.map((mount) => `${mount.enrollmentId}\0${mount.volumeId}\0${mount.workspaceId}`),
  );
  return input.mounts.filter(
    (mount) => !known.has(`${mount.enrollmentId}\0${mount.volumeId}\0${mount.workspaceId}`),
  );
}

export async function claimPendingMountEnrollmentRevocations(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly leaseUntil: Date;
    readonly limit: number;
    readonly now: Date;
  },
): Promise<readonly PendingWorkspaceMountRevocation[]> {
  const limit = boundedWindowLimit(input.limit, 100);
  if (input.leaseUntil <= input.now) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Revocation lease must be future",
    });
  }
  return withDatabaseTransaction(database, async (transaction) => {
    const rows = await transaction
      .selectFrom("workspaceMounts")
      .selectAll()
      .where("status", "=", "revocation_pending")
      .where("nextAttemptAt", "<=", input.now)
      .orderBy("nextAttemptAt", "asc")
      .orderBy("createdAt", "asc")
      .limit(limit)
      .forNoKeyUpdate()
      .skipLocked()
      .execute();
    const claimed: PendingWorkspaceMountRevocation[] = [];
    for (const row of rows) {
      const revocationAttempt = row.revocationAttempts + 1;
      await transaction
        .updateTable("workspaceMounts")
        .set({
          lastErrorCode: null,
          nextAttemptAt: input.leaseUntil,
          revocationAttempts: revocationAttempt,
          updatedAt: input.now,
        })
        .where("id", "=", row.id)
        .where("status", "=", "revocation_pending")
        .executeTakeFirstOrThrow();
      if (!row.terminationReason) {
        throw new OpensteerError({
          code: "internal",
          message: "Pending mount enrollment has no termination reason",
        });
      }
      claimed.push({
        ...workspaceMountFromRow(row),
        revocationAttempt,
        status: "revocation_pending",
        terminationReason: row.terminationReason,
      });
    }
    return claimed;
  });
}

export async function completeMountEnrollmentRevocation(
  database: Kysely<DatabaseSchema>,
  enrollmentId: string,
  state: "ABSENT" | "CLOSED" | "EXPIRED" | "REVOKED",
): Promise<void> {
  const result = await database
    .updateTable("workspaceMounts")
    .set({
      lastErrorCode: null,
      nextAttemptAt: null,
      status: state === "CLOSED" ? "closed" : state === "REVOKED" ? "revoked" : "expired",
      updatedAt: new Date(),
    })
    .where("enrollmentId", "=", enrollmentId)
    .where("status", "=", "revocation_pending")
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    const row = await database
      .selectFrom("workspaceMounts")
      .select("status")
      .where("enrollmentId", "=", enrollmentId)
      .executeTakeFirst();
    if (!row || !["closed", "revoked", "expired"].includes(row.status)) {
      throw new OpensteerError({
        code: "conflict",
        message: "Mount enrollment is not revocable",
      });
    }
  }
}

export async function failMountEnrollmentRevocation(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly enrollmentId: string;
    readonly errorCode: string;
    readonly nextAttemptAt: Date;
  },
): Promise<void> {
  requireBoundedIdentity(input.errorCode, "mount enrollment error code", 120);
  await database
    .updateTable("workspaceMounts")
    .set({
      lastErrorCode: input.errorCode,
      nextAttemptAt: input.nextAttemptAt,
      updatedAt: new Date(),
    })
    .where("enrollmentId", "=", input.enrollmentId)
    .where("status", "=", "revocation_pending")
    .executeTakeFirst();
}
