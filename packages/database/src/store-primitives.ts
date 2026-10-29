import { assignmentActivityEventsForRun } from "./assignment-store.js";
import { lockThreadChannelAuthorities } from "./channel-execution.js";
import { assertRequestWorkspacesLocked } from "./request-workspace-locks.js";
import { type ExpressionBuilder } from "kysely";
import {
  type RunRow,
  type CommandRow,
  type LegacyLiveEventType,
  legacyLiveEventTypes,
  type WorkspaceEventRow,
} from "./schema.js";
import { type AgentEvent, AgentEventSchema, IsoDateTimeSchema } from "@opensteer/core";
import { projectThreadState } from "./thread-status.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { durableWindowCursorMaxCharacters } from "@opensteer/protocol";
import {
  WorkspaceSchema,
  type Workspace,
  type WorkspaceBacking,
  type WorkspaceCapacityPolicy,
  OpensteerError,
  type EnvironmentId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { PrincipalIdSchema, type PrincipalId } from "@opensteer/channel-core";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  admitThreadExecution,
  executionEnvironmentIsAvailableToUser,
} from "./execution-authority.js";
import type { DatabaseSchema } from "./schema.js";

export const systemPrincipalId = PrincipalIdSchema.parse(
  "pri_00000000-0000-4000-8000-000000000001",
);

export function jsonValue<T>(value: T) {
  return sql<T>`${JSON.stringify(value)}::jsonb`;
}

/**
 * How the Host names its own web pages, injected because a store holds durable
 * rows and not the Deployment's canonical origin. A status delivery sent into
 * a chat product has to carry a URL a person can open, so the Host — the one
 * process that knows that origin — supplies this.
 */
export interface ChannelLinks {
  threadUrl(threadId: ThreadId): string;
}

/**
 * What a store built outside the Host answers with: the Host-relative path.
 * Maintenance tools and tests never post to a provider, and a path is all a
 * caller that does not know the origin can honestly produce.
 */
export const threadPathLinks: ChannelLinks = {
  threadUrl: (threadId) => `/threads/${threadId}`,
};

export function safeGeneration(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new OpensteerError({ code: "internal", message: "Invalid durable generation" });
  }
  return parsed;
}

export function safeCount(value: string | number | bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new OpensteerError({ code: "internal", message: "Durable item count is out of range" });
  }
  return count;
}

export function requireBoundedIdentity(value: string, label: string, maximum: number): void {
  if (
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /\p{Control}/u.test(value)
  ) {
    throw new OpensteerError({ code: "bad_request", message: `Invalid ${label}` });
  }
}

export function idempotencyConflict(key: string): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    details: { idempotencyKey: key },
    message: "The idempotency key was already used for a different command",
  });
}

export async function lockCommandIdempotency(
  transaction: Transaction<DatabaseSchema>,
  requestedBy: UserId,
  idempotencyKey: string,
): Promise<void> {
  const lockKey = JSON.stringify(["command-idempotency", requestedBy, idempotencyKey]);
  await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(transaction);
}

// See ./lock-order.ts. Request callers reserve their complete Workspace set.
export async function lockWorkspaceRow(
  transaction: Transaction<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<void> {
  assertRequestWorkspacesLocked(transaction, [workspaceId]);
  await transaction
    .selectFrom("workspaces")
    .select("id")
    .where("id", "=", workspaceId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
}

/**
 * Channel messages still pending on a Thread are authorized again under its
 * lock, and their binding, account, connections and grants rank before
 * Threads, so they are share-fenced first. A Thread with none pays one indexed
 * read.
 */
export async function lockThreadRow(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<void> {
  await lockThreadChannelAuthorities(transaction, [threadId]);
  await transaction
    .selectFrom("threads")
    .select("id")
    .where("id", "=", threadId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
}

export async function requireExecutionEnvironmentAccess(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  environmentId: EnvironmentId,
  userId: UserId,
  message: string,
): Promise<void> {
  if (await executionEnvironmentIsAvailableToUser(database, environmentId, userId)) return;
  throw new OpensteerError({ code: "forbidden", message });
}

export async function threadExecutionIsAvailableToUser(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  threadId: ThreadId,
  userId: UserId,
  membershipGeneration?: number,
): Promise<boolean> {
  return (await admitThreadExecution(database, threadId, userId, membershipGeneration)) !== null;
}

export async function principalIdForUser(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
): Promise<PrincipalId> {
  const principal = await transaction
    .selectFrom("principals")
    .select("id")
    .where("kind", "=", "user")
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (!principal) {
    throw new OpensteerError({ code: "internal", message: "User principal is missing" });
  }
  return principal.id;
}

export async function requireActiveWorkspaceMembership(
  transaction: Transaction<DatabaseSchema>,
  workspaceId: WorkspaceId,
  userId: UserId,
  lock = false,
): Promise<{ readonly role: "owner" | "collaborator"; readonly generation: number }> {
  let query = transaction
    .selectFrom("workspaceMemberships")
    .select(["role", "state", "generation"])
    .where("workspaceId", "=", workspaceId)
    .where("userId", "=", userId);
  if (lock) query = query.forNoKeyUpdate();
  const membership = await query.executeTakeFirst();
  if (!membership || membership.state !== "active") {
    throw new OpensteerError({
      code: "forbidden",
      message: "Active Workspace membership is required",
    });
  }
  return { role: membership.role, generation: safeGeneration(membership.generation) };
}

/**
 * Puts a starting Run whose execute command was never confirmed back in its
 * Thread's queue. The caller holds the Run, Workspace and Thread locks and has already
 * returned the command to pending.
 */
export async function returnRunToQueue(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly run: Pick<RunRow, "environmentId" | "id" | "threadId">;
    readonly workspaceId: WorkspaceId;
  },
): Promise<readonly AgentEvent[]> {
  const queued = await transaction
    .updateTable("runs")
    .set({ bindingGeneration: null, status: "queued" })
    .where("id", "=", input.run.id)
    .where("status", "=", "starting")
    .executeTakeFirst();
  if (queued.numUpdatedRows !== 1n) {
    throw new OpensteerError({
      code: "conflict",
      message: "The Run could not return to queued atomically",
    });
  }
  const event = await appendHostWorkspaceEvent(transaction, {
    data: { status: "queued" },
    environmentId: input.run.environmentId,
    runId: input.run.id,
    threadId: input.run.threadId,
    type: "run.status",
    workspaceId: input.workspaceId,
  });
  return [
    event,
    ...(await projectThreadState(transaction, input.run.threadId)),
    ...(await assignmentActivityEventsForRun(transaction, input.run.id)),
  ];
}

export async function findCommandByIdempotency(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  requestedBy: UserId,
  idempotencyKey: string,
): Promise<CommandRow | undefined> {
  return database
    .selectFrom("commands")
    .selectAll()
    .where("requestedBy", "=", requestedBy)
    .where("idempotencyKey", "=", idempotencyKey)
    .executeTakeFirst();
}

/**
 * A withdrawn input keeps its Message row in the ledger, but its author took
 * it back before any Run heard it, so a conversation seeded from the snapshot
 * must not show it as sent. The per-Thread total uses the same filter so the
 * window's `hasMore` describes what the snapshot actually holds. The events
 * ledger stays complete; readers fold the withdrawal event themselves.
 */
export function messageWasNotWithdrawn(expression: ExpressionBuilder<DatabaseSchema, "messages">) {
  return expression.not(
    expression.exists(
      expression
        .selectFrom("threadInputs")
        .select("threadInputs.messageId")
        .whereRef("threadInputs.messageId", "=", "messages.id")
        .where("threadInputs.state", "=", "cancelled")
        .where("threadInputs.cancelReason", "=", "withdrawn"),
    ),
  );
}

export function isLegacyLiveEventType(type: AgentEvent["type"] | LegacyLiveEventType): boolean {
  return (legacyLiveEventTypes as readonly string[]).includes(type);
}

export function eventFromRow(row: WorkspaceEventRow): AgentEvent {
  return AgentEventSchema.parse({
    createdAt: row.createdAt.toISOString(),
    data: row.data,
    environmentId: row.environmentId,
    eventId: row.eventId,
    runId: row.runId,
    sequence: String(row.sequence),
    threadId: row.threadId,
    type: row.type,
    workspaceId: row.workspaceId,
  });
}

export function safeError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof OpensteerError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { message: error instanceof Error ? error.message : "Unknown error" };
}

type DurableCursorKind =
  | "agent-thread"
  | "assignment"
  | "delegated-workspace"
  | "message"
  | "owner-thread"
  | "task"
  | "thread"
  | "workspace";

export function encodeWindowCursor(
  kind: DurableCursorKind,
  scopeId: string,
  timestamp: string,
  id: string,
): string {
  const cursor = Buffer.from(
    JSON.stringify({ id, kind, scopeId, timestamp, version: 1 }),
    "utf8",
  ).toString("base64url");
  if (cursor.length > durableWindowCursorMaxCharacters) {
    throw new OpensteerError({ code: "internal", message: "Durable window cursor is too large" });
  }
  return cursor;
}

export function decodeWindowCursor(
  cursor: string,
  kind: DurableCursorKind,
  scopeId: string,
): { readonly id: string; readonly timestamp: Date } {
  if (
    cursor.length < 1 ||
    cursor.length > durableWindowCursorMaxCharacters ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw invalidWindowCursor();
  }
  let parsed: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw invalidWindowCursor();
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch (error) {
    if (error instanceof OpensteerError) throw error;
    throw invalidWindowCursor();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("kind" in parsed) ||
    parsed.kind !== kind ||
    !("scopeId" in parsed) ||
    parsed.scopeId !== scopeId ||
    !("id" in parsed) ||
    typeof parsed.id !== "string" ||
    !("timestamp" in parsed) ||
    typeof parsed.timestamp !== "string"
  ) {
    throw invalidWindowCursor();
  }
  const timestamp = IsoDateTimeSchema.safeParse(parsed.timestamp);
  if (!timestamp.success) throw invalidWindowCursor();
  return { id: parsed.id, timestamp: new Date(timestamp.data) };
}

export function invalidWindowCursor(): OpensteerError {
  return new OpensteerError({ code: "bad_request", message: "Invalid durable window cursor" });
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

export function boundedWindowLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 1) {
    throw new OpensteerError({ code: "bad_request", message: "Window limit must be positive" });
  }
  return Math.min(value, maximum);
}

export function boundedWindowBytes(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 1) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Window byte limit must be positive",
    });
  }
  return Math.min(value, maximum);
}

export function boundedLimit(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new OpensteerError({ code: "bad_request", message: "Query limit must be positive" });
  }
  return Math.min(value, maximum);
}

export function requirePositiveSafeGeneration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OpensteerError({ code: "bad_request", message: `Invalid ${label}` });
  }
}

export function workspaceFromRow(row: {
  readonly backing: WorkspaceBacking;
  readonly capacityPolicy: WorkspaceCapacityPolicy;
  readonly homeThreadId: ThreadId | null;
  readonly icon: string | null;
  readonly color: NonNullable<Workspace["color"]>;
  readonly id: WorkspaceId;
  readonly kind: "main" | "specialized";
  readonly name: string;
  readonly status: string;
  readonly storageErrorAt: Date | null;
  readonly storageErrorCode: string | null;
  readonly storageErrorMessage: string | null;
  readonly storageErrorRetryable: boolean;
  readonly createdBy: UserId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): Workspace {
  return WorkspaceSchema.parse({
    ...row,
    homeThreadId: row.homeThreadId ?? null,
    createdAt: row.createdAt.toISOString(),
    storageIssue:
      row.storageErrorCode && row.storageErrorMessage && row.storageErrorAt
        ? {
            code: row.storageErrorCode,
            message: row.storageErrorMessage,
            occurredAt: row.storageErrorAt.toISOString(),
            retryable: row.storageErrorRetryable,
          }
        : null,
    updatedAt: row.updatedAt.toISOString(),
  });
}
