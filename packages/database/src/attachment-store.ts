import { withDatabaseTransaction } from "./connection.js";
import { createHash, randomUUID } from "node:crypto";
import {
  attachmentMaxBytes,
  attachmentMessageMaxBytes,
  attachmentMessageMaxCount,
  attachmentPendingMaxBytes,
  attachmentUploadLifetimeMs,
  AttachmentNameSchema,
  AttachmentMediaTypeSchema,
  OpensteerError,
  type ContentPart,
  type MessageId,
  type RunId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { AttachmentTable, DatabaseSchema } from "./schema.js";
import { requireActiveWorkspaceMembership } from "./store-primitives.js";

export type AttachmentRow = Selectable<AttachmentTable>;
export const attachmentWorkspaceRetainedMaxBytes = 2 * 1024 * 1024 * 1024;

const conflict = (message: string) => new OpensteerError({ code: "conflict", message });
const missing = () => new OpensteerError({ code: "not_found", message: "Attachment not found" });

export class AttachmentStore {
  private readonly database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  async reserve(input: {
    readonly workspaceId: WorkspaceId;
    readonly uploaderId: UserId;
    readonly name: string;
    readonly mediaType: string;
    readonly sizeBytes: number;
    readonly idempotencyKey: string;
  }): Promise<AttachmentRow> {
    const name = AttachmentNameSchema.parse(input.name);
    const mediaType = AttachmentMediaTypeSchema.parse(input.mediaType);
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > attachmentMaxBytes
    )
      throw conflict("Attachment size exceeds the file limit");
    if (!input.idempotencyKey || input.idempotencyKey.length > 255)
      throw conflict("Invalid upload key");
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          workspaceId: input.workspaceId,
          name,
          mediaType,
          sizeBytes: input.sizeBytes,
        }),
      )
      .digest("hex");
    return withDatabaseTransaction(this.database, async (transaction) => {
      const reservationKey = JSON.stringify([
        "attachment-upload",
        input.uploaderId,
        input.idempotencyKey,
      ]);
      await sql`select pg_advisory_xact_lock(hashtextextended(${reservationKey}, 0))`.execute(
        transaction,
      );
      // Workspace locking serializes the quota check and all reservations in it.
      const workspace = await transaction
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", input.workspaceId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!workspace) throw missing();
      await requireActiveWorkspaceMembership(transaction, input.workspaceId, input.uploaderId);
      const existing = await transaction
        .selectFrom("attachments")
        .selectAll()
        .where("uploaderId", "=", input.uploaderId)
        .where("idempotencyKey", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint)
          throw conflict("Upload key was used for different attachment metadata");
        return existing;
      }
      const aggregate = await transaction
        .selectFrom("attachments")
        .select(({ fn }) => fn.sum<number>("sizeBytes").as("bytes"))
        .where("workspaceId", "=", input.workspaceId)
        .where("state", "in", ["uploading", "ready"])
        .where("messageId", "is", null)
        .executeTakeFirstOrThrow();
      if (Number(aggregate.bytes ?? 0) + input.sizeBytes > attachmentPendingMaxBytes)
        throw conflict("Workspace pending attachment quota exceeded");
      const retained = await transaction
        .selectFrom("attachments")
        .select(({ fn }) => fn.sum<number>("sizeBytes").as("bytes"))
        .where("workspaceId", "=", input.workspaceId)
        .where("state", "!=", "deleting")
        .executeTakeFirstOrThrow();
      if (Number(retained.bytes ?? 0) + input.sizeBytes > attachmentWorkspaceRetainedMaxBytes)
        throw conflict("Workspace attachment storage quota exceeded");
      return transaction
        .insertInto("attachments")
        .values({
          id: `att_${randomUUID()}`,
          workspaceId: input.workspaceId,
          uploaderId: input.uploaderId,
          name,
          mediaType,
          sizeBytes: input.sizeBytes,
          sha256: null,
          kind: null,
          width: null,
          height: null,
          state: "uploading",
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          messageId: null,
          threadId: null,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + attachmentUploadLifetimeMs),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  get(attachmentId: string): Promise<AttachmentRow | undefined> {
    return this.database
      .selectFrom("attachments")
      .selectAll()
      .where("id", "=", attachmentId)
      .executeTakeFirst();
  }

  async getForUser(attachmentId: string, userId: UserId): Promise<AttachmentRow> {
    return withDatabaseTransaction(this.database, async (transaction) => {
      const row = await transaction
        .selectFrom("attachments")
        .selectAll()
        .where("id", "=", attachmentId)
        .executeTakeFirst();
      if (!row) throw missing();
      await requireActiveWorkspaceMembership(transaction, row.workspaceId, userId);
      if (row.uploaderId !== userId && !row.messageId) throw missing();
      return row;
    });
  }

  async complete(input: {
    readonly attachmentId: string;
    readonly uploaderId: UserId;
    readonly sha256: string;
    readonly kind?: "image" | "file";
    readonly width?: number | null;
    readonly height?: number | null;
    readonly install: () => Promise<void>;
  }): Promise<AttachmentRow> {
    if (!/^[0-9a-f]{64}$/u.test(input.sha256)) throw conflict("Invalid attachment checksum");
    // Non-retrying: install publishes attachment bytes while this row fence is held.
    return this.database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("attachments")
        .selectAll()
        .where("id", "=", input.attachmentId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || row.uploaderId !== input.uploaderId) throw missing();
      await requireActiveWorkspaceMembership(transaction, row.workspaceId, input.uploaderId);
      if (row.state === "ready") {
        if (row.sha256 !== input.sha256) throw conflict("Finalized attachment bytes cannot change");
        return row;
      }
      if (row.state !== "uploading" || row.expiresAt <= new Date())
        throw conflict("Upload is no longer active");
      await input.install();
      return transaction
        .updateTable("attachments")
        .set({
          sha256: input.sha256,
          state: "ready",
          kind: input.kind ?? "file",
          width: input.width ?? null,
          height: input.height ?? null,
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async discard(input: {
    readonly attachmentId: string;
    readonly uploaderId: UserId;
  }): Promise<AttachmentRow> {
    return withDatabaseTransaction(this.database, async (transaction) => {
      const row = await transaction
        .selectFrom("attachments")
        .selectAll()
        .where("id", "=", input.attachmentId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || row.uploaderId !== input.uploaderId) throw missing();
      await requireActiveWorkspaceMembership(transaction, row.workspaceId, input.uploaderId);
      if (row.messageId) throw conflict("An accepted message owns this attachment");
      if (row.state === "deleting") return row;
      return transaction
        .updateTable("attachments")
        .set({ state: "deleting" })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async removeDeleting(attachmentId: string): Promise<void> {
    await this.database
      .deleteFrom("attachments")
      .where("id", "=", attachmentId)
      .where("state", "=", "deleting")
      .execute();
  }

  async expireUnbound(limit: number): Promise<AttachmentRow[]> {
    return withDatabaseTransaction(this.database, async (transaction) => {
      const rows = await transaction
        .selectFrom("attachments")
        .selectAll()
        .where("messageId", "is", null)
        .where("state", "in", ["uploading", "ready"])
        .where("expiresAt", "<=", new Date())
        .orderBy("expiresAt")
        .limit(limit)
        .forNoKeyUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) return [];
      return transaction
        .updateTable("attachments")
        .set({ state: "deleting" })
        .where(
          "id",
          "in",
          rows.map((row) => row.id),
        )
        .returningAll()
        .execute();
    });
  }

  listDeleting(limit: number): Promise<AttachmentRow[]> {
    return this.database
      .selectFrom("attachments")
      .selectAll()
      .where("state", "=", "deleting")
      .orderBy("createdAt")
      .limit(limit)
      .execute();
  }

  async listForRun(input: {
    readonly after: string | null;
    readonly limit: number;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  }): Promise<AttachmentRow[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw conflict("Invalid attachment page size");
    let query = this.database
      .selectFrom("attachments")
      .innerJoin("threadInputs", "threadInputs.messageId", "attachments.messageId")
      .selectAll("attachments")
      .where("attachments.threadId", "=", input.threadId)
      .where("attachments.state", "=", "ready")
      .where((eb) =>
        eb.or([
          eb("threadInputs.state", "=", "delivered"),
          eb.and([
            eb("threadInputs.runId", "=", input.runId),
            eb("threadInputs.state", "in", ["claimed", "unknown"]),
          ]),
        ]),
      )
      .orderBy("attachments.id")
      .limit(input.limit);
    if (input.after) query = query.where("attachments.id", ">", input.after);
    return query.execute();
  }

  async getForRun(input: {
    readonly attachmentId: string;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  }): Promise<AttachmentRow> {
    const row = await this.database
      .selectFrom("attachments")
      .innerJoin("threadInputs", "threadInputs.messageId", "attachments.messageId")
      .selectAll("attachments")
      .where("attachments.id", "=", input.attachmentId)
      .where("attachments.threadId", "=", input.threadId)
      .where("attachments.state", "=", "ready")
      .where((eb) =>
        eb.or([
          eb("threadInputs.state", "=", "delivered"),
          eb.and([
            eb("threadInputs.runId", "=", input.runId),
            eb("threadInputs.state", "in", ["claimed", "unknown"]),
          ]),
        ]),
      )
      .executeTakeFirst();
    if (!row) throw missing();
    return row;
  }
}

export async function claimMessageAttachments(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly content: readonly ContentPart[];
    readonly messageId: MessageId;
    readonly requestedBy: UserId;
    readonly sourceKind: string;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<void> {
  const parts = input.content.filter((part) => part.type === "artifact");
  if (parts.length === 0) return;
  if (input.sourceKind !== "human")
    throw new OpensteerError({ code: "forbidden", message: "Attachments require a human upload" });
  if (parts.length > attachmentMessageMaxCount)
    throw conflict("Too many attachments in one message");
  const ids = parts.map((part) => part.artifactId);
  if (new Set(ids).size !== ids.length)
    throw conflict("An attachment can appear only once in a message");
  const rows = await transaction
    .selectFrom("attachments")
    .selectAll()
    .where("id", "in", ids)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const previousMessageIds = rows.flatMap((row) => (row.messageId ? [row.messageId] : []));
  const previousInputs = previousMessageIds.length
    ? await transaction
        .selectFrom("threadInputs")
        .select([
          "messageId",
          "threadId",
          "requestedBy",
          "policy",
          "state",
          "cancelReason",
          "deliveredAt",
          "runId",
          "steerCommandId",
        ])
        .where("messageId", "in", previousMessageIds)
        .orderBy("messageId")
        .forNoKeyUpdate()
        .execute()
    : [];
  const previousByMessage = new Map(previousInputs.map((row) => [row.messageId, row]));
  for (const part of parts) {
    const row = byId.get(part.artifactId);
    if (!row || row.uploaderId !== input.requestedBy || row.workspaceId !== input.workspaceId)
      throw conflict("Attachment is not available for this send");
    if (row.state !== "ready") throw conflict("Attachment is not ready for this send");
    if (row.messageId) {
      const previous = previousByMessage.get(row.messageId);
      if (
        row.threadId !== input.threadId ||
        !previous ||
        previous.threadId !== input.threadId ||
        previous.requestedBy !== input.requestedBy ||
        previous.policy !== "queue" ||
        previous.state !== "cancelled" ||
        previous.cancelReason !== "withdrawn" ||
        previous.deliveredAt !== null ||
        previous.runId !== null ||
        previous.steerCommandId !== null
      ) {
        throw conflict("Attachment belongs to an accepted message");
      }
    } else if (row.expiresAt <= new Date()) {
      throw conflict("Attachment reservation expired");
    }
    if (
      row.name !== part.name ||
      row.mediaType !== part.mediaType ||
      ("sizeBytes" in part && part.sizeBytes !== row.sizeBytes)
    )
      throw conflict("Attachment metadata changed");
  }
  if (rows.reduce((total, row) => total + row.sizeBytes, 0) > attachmentMessageMaxBytes)
    throw conflict("Message attachments exceed the size limit");
  await transaction
    .updateTable("attachments")
    .set({ messageId: input.messageId, threadId: input.threadId })
    .where("id", "in", ids)
    .execute();
}
