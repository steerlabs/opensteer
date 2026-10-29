import { withDatabaseTransaction } from "./connection.js";
import {
  type WorkspaceMembershipId,
  type UserId,
  type WorkspaceId,
  type SecurityEffectId,
  type WorkspaceInvitationId,
  deploymentSupportsSharing,
  OpensteerError,
  createId,
  type AgentEvent,
} from "@opensteer/core";
import { type Transaction, type Kysely, sql } from "kysely";
import { type DatabaseSchema } from "./schema.js";
import { jsonValue, safeCount, boundedWindowLimit, safeGeneration } from "./store-primitives.js";
import { cancelPending } from "./request-cancellation.js";
import { discoverRequestWorkspaces, withRequestWorkspaceLocks } from "./request-workspace-locks.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { threadInputFromRow } from "./thread-row-mappers.js";

export interface WorkspaceMembershipRecord {
  readonly generation: number;
  readonly id: WorkspaceMembershipId;
  readonly invitedBy: UserId | null;
  readonly joinedAt: Date;
  readonly role: "owner" | "collaborator";
  readonly state: "active" | "revoked";
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

export type WorkspaceMembershipChangeListener = (membership: WorkspaceMembershipRecord) => void;

export interface SecurityEffectRecord {
  readonly attempts: number;
  readonly id: SecurityEffectId;
  readonly kind:
    | "close-realtime"
    | "stop-runs"
    | "revoke-mounts"
    | "revoke-browser"
    | "revoke-credentials"
    | "revoke-triggers";
  readonly membershipGeneration: number;
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

export interface WorkspaceMemberRecord extends WorkspaceMembershipRecord {
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface WorkspaceInvitationRecord {
  readonly acceptedAt: Date | null;
  readonly acceptedBy: UserId | null;
  readonly createdAt: Date;
  readonly createdBy: UserId;
  readonly expiresAt: Date;
  readonly id: WorkspaceInvitationId;
  readonly intendedEmail: string | null;
  readonly revokedAt: Date | null;
  readonly role: "owner" | "collaborator";
  readonly selector: string;
  readonly type: "email" | "link";
  readonly workspaceId: WorkspaceId;
}

async function requireWorkspaceSharingCapability(
  transaction: Transaction<DatabaseSchema>,
): Promise<void> {
  const deployment = await transaction
    .selectFrom("deployments")
    .select("deploymentShape")
    .where("singletonKey", "=", "primary")
    .executeTakeFirst();
  if (!deployment || !deploymentSupportsSharing(deployment.deploymentShape)) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Workspace sharing is unavailable for this Deployment",
    });
  }
}

function workspaceMembershipFromRow(row: {
  readonly generation: string;
  readonly id: WorkspaceMembershipId;
  readonly invitedBy: UserId | null;
  readonly joinedAt: Date;
  readonly role: "owner" | "collaborator";
  readonly state: "active" | "revoked";
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}): WorkspaceMembershipRecord {
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new OpensteerError({
      code: "internal",
      message: "Stored Workspace membership generation is invalid",
    });
  }
  return { ...row, generation };
}

function workspaceInvitationFromRow(row: {
  readonly acceptedAt: Date | null;
  readonly acceptedBy: UserId | null;
  readonly createdAt: Date;
  readonly createdBy: UserId;
  readonly expiresAt: Date;
  readonly id: WorkspaceInvitationId;
  readonly intendedEmail: string | null;
  readonly revokedAt: Date | null;
  readonly role: "owner" | "collaborator";
  readonly selector: string;
  readonly type: "email" | "link";
  readonly workspaceId: WorkspaceId;
}): WorkspaceInvitationRecord {
  return row;
}

async function appendSecurityAudit(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly action: string;
    readonly actorUserId: UserId | null;
    readonly requestId: string | null;
    readonly targetId: string | null;
    readonly targetType: string;
    readonly workspaceId: WorkspaceId | null;
  },
): Promise<void> {
  await transaction
    .insertInto("securityAudit")
    .values({
      ...input,
      actorSessionId: null,
      id: createId("securityAudit"),
      metadata: jsonValue({}),
    })
    .executeTakeFirstOrThrow();
}

export async function workspaceMembershipForUser(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  userId: UserId,
): Promise<WorkspaceMembershipRecord | null> {
  const row = await database
    .selectFrom("workspaceMemberships")
    .select(["generation", "id", "invitedBy", "joinedAt", "role", "state", "userId", "workspaceId"])
    .where("workspaceId", "=", workspaceId)
    .where("userId", "=", userId)
    .executeTakeFirst();
  return row ? workspaceMembershipFromRow(row) : null;
}

export async function listWorkspaceMembers(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  actorId: UserId,
): Promise<readonly WorkspaceMemberRecord[]> {
  const actor = await workspaceMembershipForUser(database, workspaceId, actorId);
  if (!actor || actor.state !== "active") {
    throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
  }
  const rows = await database
    .selectFrom("workspaceMemberships")
    .innerJoin("users", "users.id", "workspaceMemberships.userId")
    .select([
      "users.displayName",
      "users.email",
      "users.emailVerified",
      "workspaceMemberships.generation",
      "workspaceMemberships.id",
      "workspaceMemberships.invitedBy",
      "workspaceMemberships.joinedAt",
      "workspaceMemberships.role",
      "workspaceMemberships.state",
      "workspaceMemberships.userId",
      "workspaceMemberships.workspaceId",
    ])
    .where("workspaceMemberships.workspaceId", "=", workspaceId)
    .where("workspaceMemberships.state", "=", "active")
    .orderBy("workspaceMemberships.role", "asc")
    .orderBy("workspaceMemberships.joinedAt", "asc")
    .limit(1_001)
    .execute();
  if (rows.length > 1_000) {
    throw new OpensteerError({ code: "conflict", message: "Workspace member limit exceeded" });
  }
  return rows.map((row) => ({
    ...workspaceMembershipFromRow(row),
    displayName: row.displayName,
    email: row.email,
    emailVerified: row.emailVerified,
  }));
}

export async function createWorkspaceInvitation(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly createdBy: UserId;
    readonly expiresAt: Date;
    readonly id?: WorkspaceInvitationId;
    readonly idempotencyKey: string;
    readonly intendedEmail: string | null;
    readonly requestFingerprint: string;
    readonly role: "owner" | "collaborator";
    readonly selector: string;
    readonly tokenHash: string;
    readonly type: "email" | "link";
    readonly workspaceId: WorkspaceId;
  },
): Promise<WorkspaceInvitationRecord> {
  return withDatabaseTransaction(database, async (transaction) => {
    await requireWorkspaceSharingCapability(transaction);
    await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
      input.createdBy,
      "workspace-invitation",
      input.idempotencyKey,
    ])}, 0))`.execute(transaction);
    const existing = await transaction
      .selectFrom("workspaceInvitations")
      .selectAll()
      .where("createdBy", "=", input.createdBy)
      .where("idempotencyKey", "=", input.idempotencyKey)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (existing) {
      if (
        existing.requestFingerprint !== input.requestFingerprint ||
        existing.workspaceId !== input.workspaceId ||
        existing.tokenHash !== input.tokenHash
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Idempotency key is already bound to another invitation",
        });
      }
      return workspaceInvitationFromRow(existing);
    }
    await transaction
      .selectFrom("workspaces")
      .select("id")
      .where("workspaces.id", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const actor = await transaction
      .selectFrom("workspaceMemberships")
      .select(["role", "state"])
      .where("workspaceId", "=", input.workspaceId)
      .where("userId", "=", input.createdBy)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!actor || actor.state !== "active" || actor.role !== "owner") {
      throw new OpensteerError({
        code: "forbidden",
        message: "Only a Workspace owner may invite members",
      });
    }
    const activeCount = await transaction
      .selectFrom("workspaceInvitations")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("workspaceId", "=", input.workspaceId)
      .where("acceptedAt", "is", null)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .executeTakeFirstOrThrow();
    if (safeCount(activeCount.count) >= 1_000) {
      throw new OpensteerError({ code: "conflict", message: "Invitation limit reached" });
    }
    const row = await transaction
      .insertInto("workspaceInvitations")
      .values({
        acceptedAt: null,
        acceptedBy: null,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
        id: input.id ?? createId("workspaceInvitation"),
        idempotencyKey: input.idempotencyKey,
        intendedEmail: input.intendedEmail,
        requestFingerprint: input.requestFingerprint,
        revokedAt: null,
        revokedBy: null,
        role: input.role,
        selector: input.selector,
        tokenHash: input.tokenHash,
        type: input.type,
        workspaceId: input.workspaceId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendSecurityAudit(transaction, {
      action: "workspace.invitation-created",
      actorUserId: input.createdBy,
      requestId: input.idempotencyKey,
      targetId: row.id,
      targetType: "workspace-invitation",
      workspaceId: input.workspaceId,
    });
    return workspaceInvitationFromRow(row);
  });
}

export async function listActiveWorkspaceInvitations(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  actorId: UserId,
): Promise<readonly WorkspaceInvitationRecord[]> {
  const actor = await workspaceMembershipForUser(database, workspaceId, actorId);
  if (!actor || actor.state !== "active" || actor.role !== "owner") {
    throw new OpensteerError({
      code: "forbidden",
      message: "Only a Workspace owner may view invitations",
    });
  }
  const rows = await database
    .selectFrom("workspaceInvitations")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("acceptedAt", "is", null)
    .where("revokedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .orderBy("createdAt", "desc")
    .limit(1_001)
    .execute();
  if (rows.length > 1_000) {
    throw new OpensteerError({ code: "conflict", message: "Invitation limit exceeded" });
  }
  return rows.map(workspaceInvitationFromRow);
}

export async function revokeWorkspaceInvitation(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly actorId: UserId;
    readonly invitationId: WorkspaceInvitationId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<WorkspaceInvitationRecord> {
  return withDatabaseTransaction(database, async (transaction) => {
    await transaction
      .selectFrom("workspaces")
      .select("id")
      .where("workspaces.id", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const actor = await transaction
      .selectFrom("workspaceMemberships")
      .select(["role", "state"])
      .where("workspaceId", "=", input.workspaceId)
      .where("userId", "=", input.actorId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!actor || actor.state !== "active" || actor.role !== "owner") {
      throw new OpensteerError({
        code: "forbidden",
        message: "Only a Workspace owner may revoke invitations",
      });
    }
    const invitation = await transaction
      .selectFrom("workspaceInvitations")
      .selectAll()
      .where("id", "=", input.invitationId)
      .where("workspaceId", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!invitation) {
      throw new OpensteerError({ code: "not_found", message: "Invitation not found" });
    }
    if (invitation.acceptedAt) {
      throw new OpensteerError({
        code: "conflict",
        message: "An accepted invitation cannot be revoked",
      });
    }
    if (invitation.revokedAt) return workspaceInvitationFromRow(invitation);
    const now = new Date();
    const row = await transaction
      .updateTable("workspaceInvitations")
      .set({ revokedAt: now, revokedBy: input.actorId })
      .where("id", "=", invitation.id)
      .where("revokedAt", "is", null)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendSecurityAudit(transaction, {
      action: "workspace.invitation-revoked",
      actorUserId: input.actorId,
      requestId: null,
      targetId: invitation.id,
      targetType: "workspace-invitation",
      workspaceId: input.workspaceId,
    });
    return workspaceInvitationFromRow(row);
  });
}

export async function invitationForExchange(
  database: Kysely<DatabaseSchema>,
  selector: string,
): Promise<{
  readonly invitation: WorkspaceInvitationRecord;
  readonly inviterName: string;
  readonly tokenHash: string;
  readonly workspaceName: string;
} | null> {
  const row = await database
    .selectFrom("workspaceInvitations")
    .innerJoin("workspaces", "workspaces.id", "workspaceInvitations.workspaceId")
    .innerJoin("users", "users.id", "workspaceInvitations.createdBy")
    .select([
      "users.displayName as inviterName",
      "workspaceInvitations.acceptedAt",
      "workspaceInvitations.acceptedBy",
      "workspaceInvitations.createdAt",
      "workspaceInvitations.createdBy",
      "workspaceInvitations.expiresAt",
      "workspaceInvitations.id",
      "workspaceInvitations.intendedEmail",
      "workspaceInvitations.revokedAt",
      "workspaceInvitations.role",
      "workspaceInvitations.selector",
      "workspaceInvitations.tokenHash",
      "workspaceInvitations.type",
      "workspaceInvitations.workspaceId",
      "workspaces.name as workspaceName",
    ])
    .where("workspaceInvitations.selector", "=", selector)
    .executeTakeFirst();
  if (!row) return null;
  return {
    invitation: workspaceInvitationFromRow(row),
    inviterName: row.inviterName,
    tokenHash: row.tokenHash,
    workspaceName: row.workspaceName,
  };
}

export async function acceptWorkspaceInvitation(
  database: Kysely<DatabaseSchema>,
  workspaceMembershipChangeListeners: ReadonlySet<WorkspaceMembershipChangeListener>,
  input: {
    readonly selector: string;
    readonly tokenHash: string;
    readonly userEmail: string;
    readonly userEmailVerified: boolean;
    readonly userId: UserId;
  },
): Promise<WorkspaceMembershipRecord> {
  const membership = await withDatabaseTransaction(database, async (transaction) => {
    await requireWorkspaceSharingCapability(transaction);
    const observed = await transaction
      .selectFrom("workspaceInvitations")
      .select("workspaceId")
      .where("selector", "=", input.selector)
      .executeTakeFirst();
    if (!observed) {
      throw new OpensteerError({ code: "not_found", message: "Invitation not found" });
    }
    await transaction
      .selectFrom("workspaces")
      .select("id")
      .where("id", "=", observed.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const existing = await transaction
      .selectFrom("workspaceMemberships")
      .selectAll()
      .where("workspaceId", "=", observed.workspaceId)
      .where("userId", "=", input.userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const invitation = await transaction
      .selectFrom("workspaceInvitations")
      .selectAll()
      .where("selector", "=", input.selector)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (
      invitation.workspaceId !== observed.workspaceId ||
      invitation.tokenHash !== input.tokenHash
    ) {
      throw new OpensteerError({ code: "forbidden", message: "Invitation is invalid" });
    }
    if (invitation.revokedAt || invitation.expiresAt <= new Date()) {
      throw new OpensteerError({ code: "forbidden", message: "Invitation is no longer active" });
    }
    if (invitation.acceptedAt && invitation.acceptedBy !== input.userId) {
      throw new OpensteerError({ code: "conflict", message: "Invitation has already been used" });
    }
    if (
      invitation.type === "email" &&
      (!input.userEmailVerified || invitation.intendedEmail !== input.userEmail)
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Invitation requires the matching verified email address",
      });
    }
    const now = new Date();
    let membership;
    if (!existing) {
      membership = await transaction
        .insertInto("workspaceMemberships")
        .values({
          generation: 1,
          id: createId("workspaceMembership"),
          invitedBy: invitation.createdBy,
          joinedAt: now,
          revokedAt: null,
          revokedBy: null,
          role: invitation.role,
          state: "active",
          updatedAt: now,
          userId: input.userId,
          workspaceId: invitation.workspaceId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } else if (existing.state === "revoked") {
      const unfinishedRevocation = await transaction
        .selectFrom("securityEffects")
        .select("id")
        .where("workspaceId", "=", invitation.workspaceId)
        .where("userId", "=", input.userId)
        .where("membershipGeneration", "=", existing.generation)
        .where("status", "!=", "completed")
        .executeTakeFirst();
      if (unfinishedRevocation) {
        throw new OpensteerError({
          code: "conflict",
          message: "Previous Workspace access is still being revoked",
        });
      }
      membership = await transaction
        .updateTable("workspaceMemberships")
        .set({
          generation: sql`${sql.ref("generation")} + 1`,
          invitedBy: invitation.createdBy,
          joinedAt: now,
          revokedAt: null,
          revokedBy: null,
          role: invitation.role,
          state: "active",
          updatedAt: now,
        })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else if (existing.role === "collaborator" && invitation.role === "owner") {
      membership = await transaction
        .updateTable("workspaceMemberships")
        .set({
          generation: sql`${sql.ref("generation")} + 1`,
          role: "owner",
          updatedAt: now,
        })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      membership = existing;
    }
    if (!invitation.acceptedAt) {
      await transaction
        .updateTable("workspaceInvitations")
        .set({ acceptedAt: now, acceptedBy: input.userId })
        .where("id", "=", invitation.id)
        .executeTakeFirstOrThrow();
      await appendSecurityAudit(transaction, {
        action: "workspace.invitation-accepted",
        actorUserId: input.userId,
        requestId: null,
        targetId: invitation.id,
        targetType: "workspace-invitation",
        workspaceId: invitation.workspaceId,
      });
    }
    return workspaceMembershipFromRow(membership);
  });
  emitWorkspaceMembershipChanged(workspaceMembershipChangeListeners, membership);
  return membership;
}

export async function changeWorkspaceMembership(
  database: Kysely<DatabaseSchema>,
  workspaceMembershipChangeListeners: ReadonlySet<WorkspaceMembershipChangeListener>,
  input: {
    readonly actorId: UserId;
    readonly role?: "owner" | "collaborator";
    readonly state?: "active" | "revoked";
    readonly targetUserId: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<{
  readonly membership: WorkspaceMembershipRecord;
  readonly requestEvents: readonly AgentEvent[];
}> {
  const mutation = await withRequestWorkspaceLocks(
    database,
    async (transaction) => [
      input.workspaceId,
      ...(await discoverRequestWorkspaces(transaction, {
        workspaceId: input.workspaceId,
        requestedBy: input.targetUserId,
        pending: true,
      })),
    ],
    async (transaction) => {
      await transaction
        .selectFrom("workspaces")
        .select("id")
        .where("workspaces.id", "=", input.workspaceId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const memberships = await transaction
        .selectFrom("workspaceMemberships")
        .selectAll()
        .where("workspaceId", "=", input.workspaceId)
        .where("userId", "in", [input.actorId, input.targetUserId])
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      const actor = memberships.find((row) => row.userId === input.actorId);
      if (!actor || actor.state !== "active" || actor.role !== "owner") {
        throw new OpensteerError({
          code: "forbidden",
          message: "Only a Workspace owner may change membership",
        });
      }
      const target = memberships.find((row) => row.userId === input.targetUserId);
      if (!target) {
        throw new OpensteerError({ code: "not_found", message: "Workspace member not found" });
      }
      const nextRole = input.role ?? target.role;
      const nextState = input.state ?? target.state;
      if (nextRole === target.role && nextState === target.state) {
        return { membership: workspaceMembershipFromRow(target), requestEvents: [] };
      }
      if (target.state === "revoked" && nextState === "active") {
        throw new OpensteerError({
          code: "conflict",
          message: "Revoked members must rejoin through a new invitation",
        });
      }
      if (
        target.state === "active" &&
        target.role === "owner" &&
        (nextState !== "active" || nextRole !== "owner")
      ) {
        const otherOwner = await transaction
          .selectFrom("workspaceMemberships")
          .select("id")
          .where("workspaceId", "=", input.workspaceId)
          .where("userId", "!=", input.targetUserId)
          .where("state", "=", "active")
          .where("role", "=", "owner")
          .executeTakeFirst();
        if (!otherOwner) {
          throw new OpensteerError({
            code: "conflict",
            message: "A Workspace must keep at least one active owner",
          });
        }
      }
      const now = new Date();
      const row = await transaction
        .updateTable("workspaceMemberships")
        .set({
          generation: sql`${sql.ref("generation")} + 1`,
          revokedAt: nextState === "revoked" ? now : null,
          revokedBy: nextState === "revoked" ? input.actorId : null,
          role: nextRole,
          state: nextState,
          updatedAt: now,
        })
        .where("id", "=", target.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const requestEvents: AgentEvent[] = [
        ...(nextState === "revoked"
          ? await cancelPending(transaction, {
              reason: "membership-revoked",
              requestedBy: input.targetUserId,
              resolvedAt: now,
              workspaceId: input.workspaceId,
            })
          : []),
      ];
      // Reports are scoped to one membership generation. A changed grant must
      // not leave undeliverable context occupying the Thread's report capacity.
      // Claimed snapshots are settled by their Run's finalization path.
      const cancelledReports = await transaction
        .updateTable("threadInputs")
        .set({ cancelReason: "membership-changed", state: "cancelled", updatedAt: now })
        .where("requestedBy", "=", input.targetUserId)
        .where("policy", "=", "report")
        .where("state", "in", ["pending", "unknown"])
        .where(
          "threadId",
          "in",
          transaction
            .selectFrom("threads")
            .select("id")
            .where("workspaceId", "=", input.workspaceId),
        )
        .returningAll()
        .execute();
      for (const report of cancelledReports) {
        const reportThread = await transaction
          .selectFrom("threads")
          .select("environmentId")
          .where("id", "=", report.threadId)
          .executeTakeFirstOrThrow();
        requestEvents.push(
          await appendHostWorkspaceEvent(transaction, {
            data: { input: threadInputFromRow(report) },
            environmentId: reportThread.environmentId,
            runId: report.runId,
            threadId: report.threadId,
            type: "thread-input.updated",
            workspaceId: input.workspaceId,
          }),
        );
      }
      if (nextState === "revoked") {
        for (const kind of [
          "close-realtime",
          "stop-runs",
          "revoke-mounts",
          "revoke-browser",
          "revoke-credentials",
          "revoke-triggers",
        ] as const) {
          await transaction
            .insertInto("securityEffects")
            .values({
              id: createId("securityEffect"),
              kind,
              lastError: null,
              membershipGeneration: row.generation,
              nextAttemptAt: now,
              status: "pending",
              userId: input.targetUserId,
              workspaceId: input.workspaceId,
            })
            .executeTakeFirstOrThrow();
        }
      }
      await appendSecurityAudit(transaction, {
        action:
          nextState === "revoked" ? "workspace.member-revoked" : "workspace.member-role-changed",
        actorUserId: input.actorId,
        requestId: null,
        targetId: input.targetUserId,
        targetType: "user",
        workspaceId: input.workspaceId,
      });
      return { membership: workspaceMembershipFromRow(row), requestEvents };
    },
  );
  emitWorkspaceMembershipChanged(workspaceMembershipChangeListeners, mutation.membership);
  return mutation;
}

function emitWorkspaceMembershipChanged(
  workspaceMembershipChangeListeners: ReadonlySet<WorkspaceMembershipChangeListener>,
  membership: WorkspaceMembershipRecord,
): void {
  for (const listener of workspaceMembershipChangeListeners) listener(membership);
}

export async function claimSecurityEffects(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly leaseUntil: Date;
    readonly limit: number;
    readonly now: Date;
  },
): Promise<readonly SecurityEffectRecord[]> {
  const limit = boundedWindowLimit(input.limit, 100);
  if (input.leaseUntil <= input.now) {
    throw new OpensteerError({ code: "bad_request", message: "Effect lease must be future" });
  }
  return withDatabaseTransaction(database, async (transaction) => {
    const rows = await transaction
      .selectFrom("securityEffects")
      .selectAll()
      .where("status", "in", ["pending", "processing"])
      .where("nextAttemptAt", "<=", input.now)
      .orderBy("createdAt", "asc")
      .limit(limit)
      .forNoKeyUpdate()
      .skipLocked()
      .execute();
    const claimed: SecurityEffectRecord[] = [];
    for (const row of rows) {
      const membership = await transaction
        .selectFrom("workspaceMemberships")
        .select(["generation", "state"])
        .where("workspaceId", "=", row.workspaceId)
        .where("userId", "=", row.userId)
        .executeTakeFirst();
      if (
        !membership ||
        membership.state !== "revoked" ||
        safeGeneration(membership.generation) !== safeGeneration(row.membershipGeneration)
      ) {
        await transaction
          .updateTable("securityEffects")
          .set({ lastError: null, status: "completed", updatedAt: input.now })
          .where("id", "=", row.id)
          .executeTakeFirstOrThrow();
        continue;
      }
      const attempts = row.attempts + 1;
      await transaction
        .updateTable("securityEffects")
        .set({
          attempts,
          lastError: null,
          nextAttemptAt: input.leaseUntil,
          status: "processing",
          updatedAt: input.now,
        })
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      claimed.push({
        attempts,
        id: row.id,
        kind: row.kind,
        membershipGeneration: safeGeneration(row.membershipGeneration),
        userId: row.userId,
        workspaceId: row.workspaceId,
      });
    }
    return claimed;
  });
}

export async function completeSecurityEffect(
  database: Kysely<DatabaseSchema>,
  effectId: SecurityEffectId,
): Promise<void> {
  await database
    .updateTable("securityEffects")
    .set({ lastError: null, status: "completed", updatedAt: new Date() })
    .where("id", "=", effectId)
    .where("status", "=", "processing")
    .executeTakeFirst();
}

export async function failSecurityEffect(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly effectId: SecurityEffectId;
    readonly error: string;
    readonly nextAttemptAt: Date;
  },
): Promise<void> {
  await database
    .updateTable("securityEffects")
    .set({
      lastError: input.error.slice(0, 512),
      nextAttemptAt: input.nextAttemptAt,
      status: "pending",
      updatedAt: new Date(),
    })
    .where("id", "=", input.effectId)
    .where("status", "=", "processing")
    .executeTakeFirst();
}
