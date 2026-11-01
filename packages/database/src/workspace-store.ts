import {
  type AgentEvent,
  createId,
  type EnvironmentId,
  IsoDateTimeSchema,
  type MarkColor,
  MarkColorSchema,
  nextMarkColor,
  nonTerminalRunStatuses,
  OpensteerError,
  type UserId,
  type Workspace,
  type WorkspaceBacking,
  type WorkspaceCapacityPolicy,
  type WorkspaceIconName,
  type WorkspaceId,
  WorkspaceIdSchema,
  type WorkspaceKind,
  WorkspaceSchema,
} from "@opensteer/core";
import {
  type WorkspaceCatalogPage,
  workspacePageMaxItems,
  workspaceViewFromWorkspace,
} from "@opensteer/protocol";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import { isDeepStrictEqual } from "node:util";
import { lockBrowserTabGroupMembersForTabs } from "./browser-tab-group-locks.js";
import { withDatabaseTransaction } from "./connection.js";
import { boundedSerializedPrefix } from "./message-window.js";
import { NotificationStateStore } from "./notification-state.js";
import { databaseOperationOptions } from "./operation-budget.js";
import { cancelPending } from "./request-cancellation.js";
import { discoverRequestWorkspaces, withRequestWorkspaceLocks } from "./request-workspace-locks.js";
import { type DatabaseSchema } from "./schema.js";
import {
  boundedLimit,
  boundedWindowBytes,
  boundedWindowLimit,
  decodeWindowCursor,
  encodeWindowCursor,
  findCommandByIdempotency,
  idempotencyConflict,
  jsonValue,
  lockCommandIdempotency,
  principalIdForUser,
  safeCount,
  safeGeneration,
  workspaceFromRow,
} from "./store-primitives.js";

export interface CreateWorkspaceInput {
  readonly backing: WorkspaceBacking;
  readonly capacityPolicy: WorkspaceCapacityPolicy;
  readonly color?: MarkColor;
  readonly createdBy: UserId;
  /** A name the Host already checked against the shared icon catalog. */
  readonly icon?: WorkspaceIconName | null;
  readonly id?: WorkspaceId;
  readonly idempotencyKey: string;
  readonly kind?: WorkspaceKind;
  readonly name: string;
  readonly status?: Workspace["status"];
}

export interface WorkspaceFilesAdmission {
  readonly membershipGeneration: number;
  readonly userId: UserId;
  readonly workspace: Workspace;
}

/**
 * True when nothing can still be holding this Workspace's filesystem: no Run
 * is in a status that could dispatch against it, and no Runner holds a mount
 * enrollment that has not finished revoking.
 *
 * The archive candidate listing and the archive claim share this predicate
 * because they must agree exactly — the listing decides what to look at, and
 * the claim decides what the storage authority is allowed to detach.
 */
function workspaceHasNoLiveExecution(expression: ExpressionBuilder<DatabaseSchema, "workspaces">) {
  return expression.and([
    workspaceHasNoActiveRuns(expression),
    expression.not(
      expression.exists(
        expression
          .selectFrom("workspaceMounts")
          .select("workspaceMounts.id")
          .whereRef("workspaceMounts.workspaceId", "=", "workspaces.id")
          .where("workspaceMounts.status", "in", ["active", "revocation_pending"]),
      ),
    ),
  ]);
}

function workspaceHasNoActiveRuns(expression: ExpressionBuilder<DatabaseSchema, "workspaces">) {
  return expression.not(
    expression.exists(
      expression
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select("runs.id")
        .whereRef("threads.workspaceId", "=", "workspaces.id")
        .where("runs.status", "in", nonTerminalRunStatuses),
    ),
  );
}

function workspaceCreateCommandPayload(payload: unknown): {
  readonly request?: Readonly<Record<string, unknown>>;
  readonly workspaceId: WorkspaceId;
} {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("workspaceId" in payload) ||
    typeof payload.workspaceId !== "string"
  ) {
    throw new OpensteerError({ code: "internal", message: "Stored workspace command is invalid" });
  }
  const request =
    "request" in payload &&
    typeof payload.request === "object" &&
    payload.request !== null &&
    !Array.isArray(payload.request)
      ? (payload.request as Readonly<Record<string, unknown>>)
      : undefined;
  return {
    ...(request ? { request } : {}),
    workspaceId: WorkspaceSchema.shape.id.parse(payload.workspaceId),
  };
}

function workspaceIconCommandRequest(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "request" in payload
    ? payload.request
    : undefined;
}

function canonicalWorkspaceCreateRequest(
  input: CreateWorkspaceInput,
): Readonly<Record<string, unknown>> {
  return {
    backing: input.backing,
    capacityPolicy: input.capacityPolicy,
    createdBy: input.createdBy,
    // Omitted when unset so a replay of a request stored before icons existed
    // still matches its original.
    ...(input.icon ? { icon: input.icon } : {}),
    ...(input.color ? { color: input.color } : {}),
    ...(input.id ? { id: input.id } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    name: input.name,
  };
}

export async function createWorkspace(
  database: Kysely<DatabaseSchema>,
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.createdBy, input.idempotencyKey);
    const existing = await findCommandByIdempotency(
      transaction,
      input.createdBy,
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.type !== "workspace.create") throw idempotencyConflict(input.idempotencyKey);
      const stored = workspaceCreateCommandPayload(existing.payload);
      const workspaceId = stored.workspaceId;
      const row = await transaction
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", workspaceId)
        .executeTakeFirstOrThrow(databaseOperationOptions());
      const requestChanged = stored.request
        ? !isDeepStrictEqual(stored.request, canonicalWorkspaceCreateRequest(input))
        : !isDeepStrictEqual(row.capacityPolicy, input.capacityPolicy) ||
          row.name !== input.name ||
          // Stored before icons existed, so the original request had none;
          // the row's current icon may since have been changed by its owner.
          input.icon !== undefined ||
          input.color !== undefined ||
          !isDeepStrictEqual(row.backing, input.backing) ||
          (input.kind !== undefined && row.kind !== input.kind);
      if (requestChanged) {
        throw idempotencyConflict(input.idempotencyKey);
      }
      return workspaceFromRow(row);
    }

    const id = input.id ?? createId("workspace");
    await transaction
      .selectFrom("users")
      .select("id")
      .where("id", "=", input.createdBy)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow(databaseOperationOptions());
    const currentMain = await transaction
      .selectFrom("workspaces")
      .select("id")
      .where("createdBy", "=", input.createdBy)
      .where("kind", "=", "main")
      .executeTakeFirst(databaseOperationOptions());
    const kind = input.kind ?? (currentMain ? "specialized" : "main");
    if (kind === "main" && currentMain) {
      throw new OpensteerError({
        code: "conflict",
        message: "This user already has a Main Workspace",
      });
    }
    const recent = input.color
      ? []
      : await transaction
          .selectFrom("workspaces")
          .select("color")
          .where("createdBy", "=", input.createdBy)
          .orderBy("createdAt", "desc")
          .orderBy("id", "desc")
          .limit(6)
          .execute(databaseOperationOptions());
    const row = await transaction
      .insertInto("workspaces")
      .values({
        backing: jsonValue(input.backing),
        capacityPolicy: jsonValue(input.capacityPolicy),
        color: input.color ?? nextMarkColor(recent.map((row) => row.color)),
        createdBy: input.createdBy,
        icon: input.icon ?? null,
        id,
        kind,
        name: input.name,
        status: input.status ?? "provisioning",
      })
      .returningAll()
      .executeTakeFirstOrThrow(databaseOperationOptions());
    await transaction
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: null,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "owner",
        state: "active",
        updatedAt: new Date(),
        userId: input.createdBy,
        workspaceId: id,
      })
      .executeTakeFirstOrThrow(databaseOperationOptions());
    await transaction
      .insertInto("securityAudit")
      .values({
        action: "workspace.created",
        actorSessionId: null,
        actorUserId: input.createdBy,
        id: createId("securityAudit"),
        metadata: jsonValue({}),
        requestId: input.idempotencyKey,
        targetId: id,
        targetType: "workspace",
        workspaceId: id,
      })
      .executeTakeFirstOrThrow(databaseOperationOptions());
    const actorPrincipalId = await principalIdForUser(transaction, input.createdBy);
    await transaction
      .insertInto("commands")
      .values({
        actorPrincipalId,
        authoritySource: jsonValue({ kind: "user-session", userId: input.createdBy }),
        dispatcherId: null,
        environmentId: null,
        id: createId("command"),
        idempotencyKey: input.idempotencyKey,
        lastError: null,
        payload: jsonValue({
          request: canonicalWorkspaceCreateRequest(input),
          type: "workspace.create",
          workspaceId: id,
        }),
        requestedBy: input.createdBy,
        runId: null,
        status: "succeeded",
        threadId: null,
        type: "workspace.create",
      })
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return workspaceFromRow(row);
  });
}

/**
 * Changes the icon a Workspace wears, or clears it back to its initials.
 *
 * Only an owner may, as with every other change to the Workspace itself, and
 * Main's mark is fixed. The command ledger makes a retried request a replay
 * rather than a second write, so a late retry cannot undo a newer choice.
 * `updatedAt` moves like any other edit, which is what carries the change to
 * every client's next refresh.
 */
export async function setWorkspaceIcon(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly icon: WorkspaceIconName | null;
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<Workspace> {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    const request = { icon: input.icon, workspaceId: input.workspaceId };
    const existing = await findCommandByIdempotency(
      transaction,
      input.requestedBy,
      input.idempotencyKey,
    );
    if (
      existing &&
      (existing.type !== "workspace.icon.set" ||
        !isDeepStrictEqual(workspaceIconCommandRequest(existing.payload), request))
    ) {
      throw idempotencyConflict(input.idempotencyKey);
    }
    const workspace = await transaction
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirst(databaseOperationOptions());
    const membership = workspace
      ? await transaction
          .selectFrom("workspaceMemberships")
          .select(["role", "state"])
          .where("workspaceId", "=", input.workspaceId)
          .where("userId", "=", input.requestedBy)
          .executeTakeFirst(databaseOperationOptions())
      : undefined;
    if (!workspace || !membership || membership.state !== "active") {
      throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
    }
    if (membership.role !== "owner") {
      throw new OpensteerError({
        code: "forbidden",
        message: "Only a Workspace owner may change its icon",
      });
    }
    if (workspace.kind === "main") {
      throw new OpensteerError({ code: "bad_request", message: "Main's mark cannot be changed" });
    }
    if (workspace.status === "deleting" || workspace.status === "deleted") {
      throw new OpensteerError({ code: "conflict", message: "Workspace is being deleted" });
    }
    if (existing) return workspaceFromRow(workspace);
    const row = await transaction
      .updateTable("workspaces")
      .set({ icon: input.icon, updatedAt: new Date() })
      .where("id", "=", input.workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow(databaseOperationOptions());
    await transaction
      .insertInto("commands")
      .values({
        actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
        authoritySource: jsonValue({ kind: "user-session", userId: input.requestedBy }),
        dispatcherId: null,
        environmentId: null,
        id: createId("command"),
        idempotencyKey: input.idempotencyKey,
        lastError: null,
        payload: jsonValue({ request, type: "workspace.icon.set" }),
        requestedBy: input.requestedBy,
        runId: null,
        status: "succeeded",
        threadId: null,
        type: "workspace.icon.set",
      })
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return workspaceFromRow(row);
  });
}

export async function setWorkspaceColor(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly color: MarkColor;
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<Workspace> {
  const color = MarkColorSchema.parse(input.color);
  return withDatabaseTransaction(database, async (transaction) => {
    await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
    const request = { color, workspaceId: input.workspaceId };
    const existing = await findCommandByIdempotency(
      transaction,
      input.requestedBy,
      input.idempotencyKey,
    );
    if (
      existing &&
      (existing.type !== "workspace.color.set" ||
        !isDeepStrictEqual(workspaceIconCommandRequest(existing.payload), request))
    ) {
      throw idempotencyConflict(input.idempotencyKey);
    }
    const workspace = await transaction
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirst(databaseOperationOptions());
    const membership = workspace
      ? await transaction
          .selectFrom("workspaceMemberships")
          .select(["role", "state"])
          .where("workspaceId", "=", input.workspaceId)
          .where("userId", "=", input.requestedBy)
          .executeTakeFirst(databaseOperationOptions())
      : undefined;
    if (!workspace || !membership || membership.state !== "active") {
      throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
    }
    if (membership.role !== "owner") {
      throw new OpensteerError({
        code: "forbidden",
        message: "Only a Workspace owner may change its colour",
      });
    }
    if (workspace.kind === "main") {
      throw new OpensteerError({ code: "bad_request", message: "Main's mark cannot be changed" });
    }
    if (workspace.status === "deleting" || workspace.status === "deleted") {
      throw new OpensteerError({ code: "conflict", message: "Workspace is being deleted" });
    }
    if (existing) return workspaceFromRow(workspace);
    const row = await transaction
      .updateTable("workspaces")
      .set({ color, updatedAt: new Date() })
      .where("id", "=", input.workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow(databaseOperationOptions());
    await transaction
      .insertInto("commands")
      .values({
        actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
        authoritySource: jsonValue({ kind: "user-session", userId: input.requestedBy }),
        dispatcherId: null,
        environmentId: null,
        id: createId("command"),
        idempotencyKey: input.idempotencyKey,
        lastError: null,
        payload: jsonValue({ request, type: "workspace.color.set" }),
        requestedBy: input.requestedBy,
        runId: null,
        status: "succeeded",
        threadId: null,
        type: "workspace.color.set",
      })
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return workspaceFromRow(row);
  });
}

export async function requestWorkspaceDeletion(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly purgeAfter: Date;
    readonly requestedBy: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<{
  readonly requestEvents: readonly AgentEvent[];
  readonly workspace: Workspace;
}> {
  if (!Number.isFinite(input.purgeAfter.getTime())) {
    throw new OpensteerError({ code: "bad_request", message: "Invalid Workspace purge time" });
  }
  return withRequestWorkspaceLocks(
    database,
    async (transaction) => [
      input.workspaceId,
      ...(await discoverRequestWorkspaces(transaction, {
        workspaceId: input.workspaceId,
        pending: true,
      })),
    ],
    async (transaction) => {
      const workspace = await transaction
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", input.workspaceId)
        .forNoKeyUpdate()
        .executeTakeFirst(databaseOperationOptions());
      if (!workspace) {
        throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
      }
      const membership = await transaction
        .selectFrom("workspaceMemberships")
        .select(["role", "state"])
        .where("workspaceId", "=", input.workspaceId)
        .where("userId", "=", input.requestedBy)
        .executeTakeFirst(databaseOperationOptions());
      if (!membership || membership.state !== "active" || membership.role !== "owner") {
        throw new OpensteerError({
          code: "forbidden",
          message: "Only an active Workspace owner may delete this Workspace",
        });
      }
      if (workspace.status === "deleting") {
        if (workspace.deletionRequestedBy === input.requestedBy) {
          return { requestEvents: [], workspace: workspaceFromRow(workspace) };
        }
        throw new OpensteerError({
          code: "conflict",
          message: "Workspace deletion was requested by another owner",
        });
      }
      if (workspace.status === "deleted") {
        throw new OpensteerError({ code: "conflict", message: "Workspace is already deleted" });
      }
      if (
        !["ready", "unavailable", "failed", "archiving", "archived", "provisioning"].includes(
          workspace.status,
        )
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Workspace cannot enter deletion retention from its current state",
        });
      }
      const requestedAt = new Date();
      const row = await transaction
        .updateTable("workspaces")
        .set({
          deletedAt: null,
          deletionRequestedAt: requestedAt,
          deletionRequestedBy: input.requestedBy,
          purgeAfter: input.purgeAfter,
          status: "deleting",
          updatedAt: requestedAt,
        })
        .where("id", "=", input.workspaceId)
        .returningAll()
        .executeTakeFirstOrThrow(databaseOperationOptions());
      const requestEvents = await cancelPending(transaction, {
        reason: "workspace-deleted",
        resolvedAt: requestedAt,
        workspaceId: input.workspaceId,
      });
      await transaction
        .insertInto("securityAudit")
        .values({
          action: "workspace.deletion_requested",
          actorSessionId: null,
          actorUserId: input.requestedBy,
          id: createId("securityAudit"),
          metadata: jsonValue({ purgeAfter: input.purgeAfter.toISOString() }),
          requestId: null,
          targetId: input.workspaceId,
          targetType: "workspace",
          workspaceId: input.workspaceId,
        })
        .executeTakeFirstOrThrow(databaseOperationOptions());
      return { requestEvents, workspace: workspaceFromRow(row) };
    },
  );
}

export async function recoverWorkspaceDeletion(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly requestedBy: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<Workspace> {
  return withDatabaseTransaction(database, async (transaction) => {
    const workspace = await transaction
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirst(databaseOperationOptions());
    if (!workspace) {
      throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
    }
    const membership = await transaction
      .selectFrom("workspaceMemberships")
      .select(["role", "state"])
      .where("workspaceId", "=", input.workspaceId)
      .where("userId", "=", input.requestedBy)
      .executeTakeFirst(databaseOperationOptions());
    if (!membership || membership.state !== "active" || membership.role !== "owner") {
      throw new OpensteerError({
        code: "forbidden",
        message: "Only an active Workspace owner may recover this Workspace",
      });
    }
    if (workspace.status !== "deleting" || !workspace.purgeAfter) {
      throw new OpensteerError({
        code: "conflict",
        message: "Workspace is not awaiting deletion",
      });
    }
    const recoveredAt = new Date();
    if (workspace.purgeAfter <= recoveredAt) {
      throw new OpensteerError({
        code: "conflict",
        message: "Workspace deletion retention has expired",
      });
    }
    const row = await transaction
      .updateTable("workspaces")
      .set({
        deletedAt: null,
        deletionRequestedAt: null,
        deletionRequestedBy: null,
        purgeAfter: null,
        status: "unavailable",
        updatedAt: recoveredAt,
      })
      .where("id", "=", input.workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow(databaseOperationOptions());
    await transaction
      .insertInto("securityAudit")
      .values({
        action: "workspace.deletion_recovered",
        actorSessionId: null,
        actorUserId: input.requestedBy,
        id: createId("securityAudit"),
        metadata: jsonValue({}),
        requestId: null,
        targetId: input.workspaceId,
        targetType: "workspace",
        workspaceId: input.workspaceId,
      })
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return workspaceFromRow(row);
  });
}

export async function listWorkspacesDuePurge(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly after?: WorkspaceId;
    readonly limit: number;
    readonly now: Date;
  },
): Promise<readonly Workspace[]> {
  if (!Number.isFinite(input.now.getTime())) {
    throw new OpensteerError({ code: "bad_request", message: "Invalid Workspace purge time" });
  }
  let query = database
    .selectFrom("workspaces")
    .selectAll()
    .where("status", "=", "deleting")
    .where("purgeAfter", "<=", input.now);
  if (input.after) query = query.where("id", ">", input.after);
  const rows = await query
    .orderBy("id", "asc")
    .limit(boundedLimit(input.limit, 500))
    .execute(databaseOperationOptions());
  return rows.map(workspaceFromRow);
}

export async function markWorkspaceDeleted(
  database: Kysely<DatabaseSchema>,
  input: { readonly workspaceId: WorkspaceId },
): Promise<Workspace> {
  return withDatabaseTransaction(database, async (transaction) => {
    const workspace = await transaction
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirst(databaseOperationOptions());
    if (!workspace) {
      throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
    }
    if (workspace.status !== "deleting") {
      throw new OpensteerError({
        code: "conflict",
        message: "Only a Workspace awaiting deletion may be marked deleted",
      });
    }
    const tabIds = await transaction
      .selectFrom("workspaceTabs")
      .select("workspaceTabs.id")
      .where(
        "groupId",
        "in",
        transaction
          .selectFrom("browserSessions")
          .select("id")
          .where("workspaceId", "=", input.workspaceId),
      )
      .orderBy("workspaceTabs.id")
      // FOR UPDATE: Deletion removes the tabs and cascades their personal group memberships.
      .forUpdate()
      .execute(databaseOperationOptions());
    if (tabIds.length) {
      await lockBrowserTabGroupMembersForTabs(
        transaction,
        tabIds.map((tab) => tab.id),
      );
      await transaction
        .deleteFrom("workspaceTabs")
        .where(
          "id",
          "in",
          tabIds.map((tab) => tab.id),
        )
        .execute(databaseOperationOptions());
    }
    const deletedAt = new Date();
    const row = await transaction
      .updateTable("workspaces")
      .set({ deletedAt, status: "deleted", updatedAt: deletedAt })
      .where("id", "=", input.workspaceId)
      .where("status", "=", "deleting")
      .returningAll()
      .executeTakeFirstOrThrow(databaseOperationOptions());
    await transaction
      .insertInto("securityAudit")
      .values({
        action: "workspace.deleted",
        actorSessionId: null,
        actorUserId: workspace.deletionRequestedBy,
        id: createId("securityAudit"),
        metadata: jsonValue({}),
        requestId: null,
        targetId: input.workspaceId,
        targetType: "workspace",
        workspaceId: input.workspaceId,
      })
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return workspaceFromRow(row);
  });
}

export async function listWorkspaces(
  database: Kysely<DatabaseSchema>,
): Promise<readonly Workspace[]> {
  const rows = await database
    .selectFrom("workspaces")
    .selectAll()
    .orderBy("workspaces.updatedAt", "desc")
    .execute(databaseOperationOptions());
  return rows.map(workspaceFromRow);
}

/**
 * The caller's own Main Workspace, if it exists.
 *
 * Scoped by creator rather than membership: Main is personal, and being
 * invited into somebody else's Workspace must never be mistaken for having
 * one of your own.
 */
export async function findMainWorkspaceForOwner(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
): Promise<Workspace | undefined> {
  const row = await database
    .selectFrom("workspaces")
    .selectAll()
    .where("createdBy", "=", ownerId)
    .where("kind", "=", "main")
    .orderBy("createdAt", "asc")
    .executeTakeFirst(databaseOperationOptions());
  return row ? workspaceFromRow(row) : undefined;
}

export async function workspacePageForOwner(
  database: Kysely<DatabaseSchema>,
  notificationState: NotificationStateStore,
  input: {
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly ownerId: UserId;
  },
): Promise<WorkspaceCatalogPage> {
  const maxItems = boundedWindowLimit(input.maxItems, workspacePageMaxItems);
  const maxBytes = boundedWindowBytes(input.maxBytes, 256 * 1_024);
  const anchor = input.before ? decodeWindowCursor(input.before, "workspace", input.ownerId) : null;
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      let query = transaction
        .selectFrom("workspaces")
        .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
        .selectAll("workspaces")
        .where("workspaceMemberships.userId", "=", input.ownerId)
        .where("workspaceMemberships.state", "=", "active")
        .where("workspaces.status", "!=", "deleted");
      if (anchor) {
        query = query.where((expressions) =>
          expressions.or([
            expressions("updatedAt", "<", anchor.timestamp),
            expressions.and([
              expressions("updatedAt", "=", anchor.timestamp),
              expressions("id", "<", WorkspaceIdSchema.parse(anchor.id)),
            ]),
          ]),
        );
      }
      const [rows, countRow] = await Promise.all([
        query
          .orderBy("updatedAt", "desc")
          .orderBy("id", "desc")
          .limit(maxItems + 1)
          .execute(databaseOperationOptions()),
        transaction
          .selectFrom("workspaces")
          .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("workspaceMemberships.userId", "=", input.ownerId)
          .where("workspaceMemberships.state", "=", "active")
          .where("workspaces.status", "!=", "deleted")
          .executeTakeFirstOrThrow(databaseOperationOptions()),
      ]);
      const window = boundedSerializedPrefix(
        rows
          .slice(0, maxItems)
          .map(workspaceFromRow)
          .map((workspace) => workspaceViewFromWorkspace(workspace)),
        maxItems,
        maxBytes,
      );
      const hasMore = rows.length > window.items.length;
      const oldest = window.items.at(-1);
      return {
        notificationPreferences: [
          ...(await notificationState.listWorkspacePreferences({
            database: transaction,
            userId: input.ownerId,
            workspaceIds: window.items.map(({ id }) => id),
          })),
        ],
        window: {
          byteCount: window.byteCount,
          hasMore,
          itemCount: window.items.length,
          nextBefore:
            hasMore && oldest
              ? encodeWindowCursor("workspace", input.ownerId, oldest.updatedAt, oldest.id)
              : null,
          totalItems: safeCount(countRow.count),
        },
        workspaces: [...window.items],
      };
    },
    "repeatable read",
  );
}

export async function listWorkspacesForOwner(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  limit = 1_000,
): Promise<readonly Workspace[]> {
  const rows = await database
    .selectFrom("workspaces")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
    .selectAll("workspaces")
    .where("workspaceMemberships.userId", "=", ownerId)
    .where("workspaceMemberships.state", "=", "active")
    .where("workspaces.status", "!=", "deleted")
    .orderBy("updatedAt", "desc")
    .limit(boundedLimit(limit, 1_000))
    .execute(databaseOperationOptions());
  return rows.map(workspaceFromRow);
}

export async function getWorkspace(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<Workspace | null> {
  const row = await database
    .selectFrom("workspaces")
    .selectAll()
    .where("workspaces.id", "=", workspaceId)
    .executeTakeFirst(databaseOperationOptions());
  return row ? workspaceFromRow(row) : null;
}

export async function noteWorkspaceActivity(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  at: Date,
): Promise<void> {
  if (!Number.isFinite(at.getTime())) {
    throw new OpensteerError({ code: "bad_request", message: "Invalid Workspace activity time" });
  }
  await database
    .updateTable("workspaces")
    // Activity is reported from several demand paths that can land out of
    // order, so the column only ever moves forward. `last_activity_at` is
    // NOT NULL with a default, so GREATEST never sees a NULL operand.
    .set({ lastActivityAt: sql<Date>`greatest(last_activity_at, ${at}::timestamptz)` })
    .where("id", "=", workspaceId)
    .executeTakeFirst(databaseOperationOptions());
}

/**
 * Finds archive candidates. This is a snapshot, not an admission: every
 * Workspace it returns must still pass `claimPortableFsWorkspaceForArchive`
 * before anything acts on it.
 */
export async function listArchiveEligibleWorkspaces(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly after?: WorkspaceId;
    readonly idleBefore: Date;
    readonly limit: number;
  },
): Promise<readonly Workspace[]> {
  if (!Number.isFinite(input.idleBefore.getTime())) {
    throw new OpensteerError({ code: "bad_request", message: "Invalid Workspace idle cutoff" });
  }
  let query = database
    .selectFrom("workspaces")
    .selectAll()
    .where("workspaces.status", "=", "ready")
    .where("workspaces.lastActivityAt", "<", input.idleBefore)
    .where(sql<boolean>`workspaces.backing ->> 'kind' = 'portablefs'`)
    .where(workspaceHasNoActiveRuns);
  if (input.after) query = query.where("workspaces.id", ">", input.after);
  const rows = await query
    .orderBy("workspaces.id", "asc")
    .limit(boundedLimit(input.limit, 500))
    .execute(databaseOperationOptions());
  return rows.map(workspaceFromRow);
}

export async function getWorkspaceForOwner(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  ownerId: UserId,
): Promise<Workspace | null> {
  const row = await database
    .selectFrom("workspaces")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
    .selectAll("workspaces")
    .where("workspaces.id", "=", workspaceId)
    .where("workspaceMemberships.userId", "=", ownerId)
    .where("workspaceMemberships.state", "=", "active")
    .executeTakeFirst(databaseOperationOptions());
  return row ? workspaceFromRow(row) : null;
}

/**
 * Admits one Files operation against the exact active membership generation
 * observed in the same database statement as the Workspace backing.
 */
export async function admitWorkspaceFiles(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
  userId: UserId,
): Promise<WorkspaceFilesAdmission | null> {
  const row = await database
    .selectFrom("workspaces")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
    .selectAll("workspaces")
    .select("workspaceMemberships.generation as membershipGeneration")
    .where("workspaces.id", "=", workspaceId)
    .where("workspaceMemberships.userId", "=", userId)
    .where("workspaceMemberships.state", "=", "active")
    .executeTakeFirst(databaseOperationOptions());
  if (!row) return null;
  if (row.status === "deleted") return null;
  if (row.status === "deleting") {
    throw new OpensteerError({
      code: "workspace_unavailable",
      message: "Workspace is awaiting deletion",
    });
  }
  return {
    membershipGeneration: safeGeneration(row.membershipGeneration),
    userId,
    workspace: workspaceFromRow(row),
  };
}

export async function setWorkspaceStorageState(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly issue: Workspace["storageIssue"];
    readonly status: Workspace["status"];
    readonly workspaceId: WorkspaceId;
  },
): Promise<Workspace> {
  const row = await database
    .updateTable("workspaces")
    .set({
      status: input.status,
      storageErrorAt: input.issue ? new Date(input.issue.occurredAt) : null,
      storageErrorCode: input.issue?.code ?? null,
      storageErrorMessage: input.issue?.message ?? null,
      storageErrorRetryable: input.issue?.retryable ?? false,
      updatedAt: new Date(),
    })
    .where("id", "=", input.workspaceId)
    .where("status", "not in", ["deleting", "deleted"])
    .returningAll()
    .executeTakeFirst(databaseOperationOptions());
  if (!row) throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
  return workspaceFromRow(row);
}

export async function setWorkspaceProvisioningResult(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly backing: WorkspaceBacking;
    readonly expectedBacking: WorkspaceBacking;
    readonly status: Workspace["status"];
    readonly workspaceId: WorkspaceId;
  },
): Promise<Workspace> {
  if (
    input.backing.kind !== input.expectedBacking.kind ||
    input.backing.generation !== input.expectedBacking.generation ||
    (input.backing.kind === "local-directory" &&
      input.expectedBacking.kind === "local-directory" &&
      (input.backing.bindingId !== input.expectedBacking.bindingId ||
        input.backing.ownerEnvironmentId !== input.expectedBacking.ownerEnvironmentId)) ||
    (input.backing.kind === "portablefs" &&
      input.expectedBacking.kind === "portablefs" &&
      input.backing.serviceId !== input.expectedBacking.serviceId)
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "Workspace provisioning cannot change storage authority",
    });
  }
  const row = await database
    .updateTable("workspaces")
    .set({
      backing: jsonValue(input.backing),
      status: input.status,
      storageErrorAt: null,
      storageErrorCode: null,
      storageErrorMessage: null,
      storageErrorRetryable: false,
      updatedAt: new Date(),
    })
    .where("id", "=", input.workspaceId)
    .where("status", "not in", ["deleting", "deleted"])
    .where((expressions) =>
      expressions.or([
        expressions("backing", "=", jsonValue(input.expectedBacking)),
        expressions("backing", "=", jsonValue(input.backing)),
      ]),
    )
    .returningAll()
    .executeTakeFirst(databaseOperationOptions());
  if (row) return workspaceFromRow(row);
  const existing = await getWorkspace(database, input.workspaceId);
  if (!existing) {
    throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
  }
  throw new OpensteerError({
    code: "conflict",
    message: "Workspace backing changed while provisioning",
  });
}

/**
 * Claims one Workspace for archiving, atomically, in a single statement.
 *
 * This is the authority on archive admission; `listArchiveEligibleWorkspaces`
 * is only a cheap candidate finder, and a sweep can act on its snapshot
 * minutes later. The claim therefore re-tests every eligibility predicate the
 * listing used *and* compares the backing generation it observed, so a
 * Workspace that was used, woken, deleted, or claimed by another Host in the
 * meantime is rejected rather than having its live filesystem force-detached
 * by the storage authority's archive.
 *
 * The generation compare-and-swap is what makes two concurrent claims of the
 * same row resolve to exactly one winner: PostgreSQL re-evaluates a blocked
 * UPDATE's predicate against the *updated* row, where the state predicates
 * still hold but the generation no longer matches.
 *
 * Advancing the generation is also the Files fence, which is why the claim
 * carries it: the gateway records the post-claim generation as a volume's
 * session floor when the archive quiesce evicts a read session, and every
 * session install carries the generation it was signed under. A grant signed
 * during generation G installs at fence G and is rejected by a floor of G+1,
 * while anything signed after the claim carries G+1 and still installs (the
 * gateway's floor test is strictly greater).
 *
 * A crash between the claim and the authority's archive call self-heals: the
 * Workspace is still idle and still `ready`, so the next sweep re-lists it
 * and claims it at the new generation. The burned generation costs nothing —
 * it is a monotonic counter, never a coordinate.
 *
 * A Run that starts *after* a successful claim is not resolved here and
 * cannot be: it is resolved at the storage authority, whose wake cancels a
 * quiescing archive and returns the volume to service.
 */
export async function claimPortableFsWorkspaceForArchive(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly backingGeneration: number;
    readonly idleBefore: Date;
    readonly workspaceId: WorkspaceId;
  },
): Promise<Workspace> {
  if (!Number.isFinite(input.idleBefore.getTime())) {
    throw new OpensteerError({ code: "bad_request", message: "Invalid Workspace idle cutoff" });
  }
  const row = await database
    .updateTable("workspaces")
    .set({
      // to_jsonb of an integer keeps `generation` a JSON number; a text
      // assignment would silently turn the whole backing invalid.
      backing: sql<WorkspaceBacking>`jsonb_set(
          backing,
          '{generation}',
          to_jsonb(((backing ->> 'generation')::bigint + 1))
        )`,
      updatedAt: new Date(),
    })
    .where("workspaces.id", "=", input.workspaceId)
    .where("workspaces.status", "=", "ready")
    .where("workspaces.lastActivityAt", "<", input.idleBefore)
    .where(sql<boolean>`workspaces.backing ->> 'kind' = 'portablefs'`)
    .where(
      sql<boolean>`(workspaces.backing ->> 'generation')::numeric = ${input.backingGeneration}`,
    )
    .where(workspaceHasNoLiveExecution)
    .returningAll()
    .executeTakeFirst(databaseOperationOptions());
  if (!row) {
    throw new OpensteerError({
      code: "conflict",
      message: "Workspace is no longer eligible for archiving",
    });
  }
  return workspaceFromRow(row);
}

export async function assertCurrentPortableFsWorkspaceBacking(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly generation: number;
    readonly volumeId: string;
    readonly workspaceId: WorkspaceId;
  },
): Promise<void> {
  const row = await database
    .selectFrom("workspaces")
    .select("id")
    .where("id", "=", input.workspaceId)
    .where("status", "=", "ready")
    .where(sql<boolean>`backing ->> 'kind' = 'portablefs'`)
    .where(sql<boolean>`backing ->> 'volumeId' = ${input.volumeId}`)
    .where(sql<boolean>`(backing ->> 'generation')::numeric = ${input.generation}`)
    .executeTakeFirst(databaseOperationOptions());
  if (!row) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Workspace storage binding is no longer current",
    });
  }
}

export async function hasWorkspaceMountHistory(
  database: Kysely<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<boolean> {
  const row = await database
    .selectFrom("workspaceMounts")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .limit(1)
    .executeTakeFirst(databaseOperationOptions());
  return row !== undefined;
}

/**
 * How many live Threads are placed on each of these Environments. Archived
 * Threads are excluded: they are not work a person would lose.
 */
export async function countLiveThreadsByEnvironment(
  database: Kysely<DatabaseSchema>,
  environmentIds: readonly EnvironmentId[],
): Promise<ReadonlyMap<EnvironmentId, number>> {
  if (environmentIds.length === 0) return new Map();
  const rows = await database
    .selectFrom("threads")
    .select(({ fn }) => ["environmentId", fn.countAll<string>().as("count")] as const)
    .where("environmentId", "in", environmentIds)
    .where("status", "!=", "archived")
    .groupBy("environmentId")
    .execute(databaseOperationOptions());
  return new Map(rows.map((row) => [row.environmentId, Number(row.count)]));
}

/**
 * Every live Workspace whose files sit on one of these machines. The owning
 * environment is a generated column off the backing, so only local-directory
 * rows can match and the lookup rides the existing index rather than
 * scanning backing JSON.
 */
export async function listLocalWorkspacesForEnvironments(
  database: Kysely<DatabaseSchema>,
  environmentIds: readonly EnvironmentId[],
  limit = 1_000,
): Promise<readonly Workspace[]> {
  if (environmentIds.length === 0) return [];
  const rows = await database
    .selectFrom("workspaces")
    .selectAll()
    .where("ownerEnvironmentId", "in", environmentIds)
    .where("status", "!=", "deleted")
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .limit(boundedLimit(limit, 1_000))
    .execute(databaseOperationOptions());
  return rows.map(workspaceFromRow);
}

export async function listWorkspacesByStatus(
  database: Kysely<DatabaseSchema>,
  status: Workspace["status"],
  options: {
    readonly after?: { readonly createdAt: string; readonly id: WorkspaceId };
    readonly limit?: number;
  } = {},
): Promise<readonly Workspace[]> {
  const limit = boundedLimit(options.limit ?? 100, 500);
  let query = database.selectFrom("workspaces").selectAll().where("status", "=", status);
  if (options.after) {
    const createdAt = new Date(IsoDateTimeSchema.parse(options.after.createdAt));
    query = query.where((expressions) =>
      expressions.or([
        expressions("createdAt", ">", createdAt),
        expressions.and([
          expressions("createdAt", "=", createdAt),
          expressions("id", ">", options.after!.id),
        ]),
      ]),
    );
  }
  const rows = await query
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .limit(limit)
    .execute(databaseOperationOptions());
  return rows.map(workspaceFromRow);
}

export async function listPortableFsWorkspacesByServiceMismatch(
  database: Kysely<DatabaseSchema>,
  serviceId: string,
  options: {
    readonly after?: { readonly createdAt: string; readonly id: WorkspaceId };
    readonly limit?: number;
  } = {},
): Promise<readonly Workspace[]> {
  const limit = boundedLimit(options.limit ?? 100, 500);
  let query = database
    .selectFrom("workspaces")
    .selectAll()
    .where(sql<boolean>`backing ->> 'kind' = 'portablefs'`)
    .where(sql<boolean>`backing ->> 'serviceId' <> ${serviceId}`);
  if (options.after) {
    const createdAt = new Date(IsoDateTimeSchema.parse(options.after.createdAt));
    query = query.where((expressions) =>
      expressions.or([
        expressions("createdAt", ">", createdAt),
        expressions.and([
          expressions("createdAt", "=", createdAt),
          expressions("id", ">", options.after!.id),
        ]),
      ]),
    );
  }
  const rows = await query
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .limit(limit)
    .execute(databaseOperationOptions());
  return rows.map(workspaceFromRow);
}
