import { OpensteerError, type AuthSessionId, type UserId } from "@opensteer/core";
import type { Kysely, Selectable } from "kysely";
import { withDatabaseTransaction } from "./connection.js";
import { accountSubjectsForUsers } from "./notification-store.js";
import type { DatabaseSchema, NotificationPreviewKeyTable } from "./schema.js";

export type NotificationPreviewKeyRecord = Selectable<NotificationPreviewKeyTable>;

export class NotificationPreviewKeyStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly now: () => Date;
  constructor(database: Kysely<DatabaseSchema>, now: () => Date = () => new Date()) {
    this.database = database;
    this.now = now;
  }

  async register(input: {
    readonly userId: UserId;
    readonly authSessionId: AuthSessionId;
    readonly installationId: string;
    readonly accountId: string;
    readonly issuer: string;
    readonly keyId: string;
    readonly encryptedKey: Buffer;
    readonly encryptionKeyVersion: number;
    readonly matchesExisting: (row: NotificationPreviewKeyRecord) => Promise<boolean>;
  }): Promise<void> {
    await withDatabaseTransaction(this.database, async (transaction) => {
      const now = this.now();
      const user = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", input.userId)
        .where("disabledAt", "is", null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!user) throw forbidden();
      const session = await transaction
        .selectFrom("authSessions")
        .select("id")
        .where("id", "=", input.authSessionId)
        .where("userId", "=", input.userId)
        .where("expiresAt", ">", now)
        .where("absoluteExpiresAt", ">", now)
        .forShare()
        .executeTakeFirst();
      if (!session) throw forbidden();
      const subjects = await accountSubjectsForUsers(transaction, [input.userId], input.issuer);
      if (!subjects.includes(input.accountId)) throw forbidden();
      const rows = await transaction
        .selectFrom("notificationPreviewKeys")
        .selectAll()
        .where("userId", "=", input.userId)
        .orderBy("installationId", "asc")
        // Expired registrations are removed before enforcing the installation bound.
        .forUpdate()
        .execute();
      const validSessions = await transaction
        .selectFrom("authSessions")
        .select("id")
        .where("userId", "=", input.userId)
        .where("expiresAt", ">", now)
        .where("absoluteExpiresAt", ">", now)
        .execute();
      const active = new Set(validSessions.map((row) => row.id));
      for (const row of rows)
        if (!active.has(row.authSessionId)) {
          await transaction
            .deleteFrom("notificationPreviewKeys")
            .where("userId", "=", row.userId)
            .where("installationId", "=", row.installationId)
            .execute();
        }
      const retained = rows.filter((row) => active.has(row.authSessionId));
      const existing = retained.find((row) => row.installationId === input.installationId);
      if (existing?.keyId === input.keyId) {
        if (
          existing.authSessionId !== input.authSessionId ||
          existing.accountId !== input.accountId ||
          !(await input.matchesExisting(existing))
        ) {
          throw new OpensteerError({
            code: "conflict",
            reason: "notification-preview-key-conflict",
            message: "Notification preview key conflicts with its registration",
          });
        }
        return;
      }
      if (!existing && retained.length >= 16)
        throw new OpensteerError({
          code: "conflict",
          reason: "notification-preview-device-limit",
          message: "Notification preview device limit reached",
        });
      await transaction
        .insertInto("notificationPreviewKeys")
        .values({
          userId: input.userId,
          authSessionId: input.authSessionId,
          installationId: input.installationId,
          accountId: input.accountId,
          keyId: input.keyId,
          encryptedKey: input.encryptedKey,
          encryptionKeyVersion: input.encryptionKeyVersion,
          createdAt: now,
          updatedAt: now,
        })
        .onConflict((conflict) =>
          conflict.columns(["userId", "installationId"]).doUpdateSet({
            authSessionId: input.authSessionId,
            accountId: input.accountId,
            keyId: input.keyId,
            encryptedKey: input.encryptedKey,
            encryptionKeyVersion: input.encryptionKeyVersion,
            updatedAt: now,
          }),
        )
        .execute();
    });
  }

  async unregister(input: {
    readonly userId: UserId;
    readonly authSessionId: AuthSessionId;
    readonly installationId: string;
    readonly keyId: string;
  }): Promise<void> {
    await this.database
      .deleteFrom("notificationPreviewKeys")
      .where("userId", "=", input.userId)
      .where("authSessionId", "=", input.authSessionId)
      .where("installationId", "=", input.installationId)
      .where("keyId", "=", input.keyId)
      .execute();
  }

  async eligible(
    userId: UserId,
    accountIds: readonly string[],
  ): Promise<readonly NotificationPreviewKeyRecord[]> {
    if (!accountIds.length) return [];
    const now = this.now();
    return this.database
      .selectFrom("notificationPreviewKeys")
      .innerJoin("authSessions", "authSessions.id", "notificationPreviewKeys.authSessionId")
      .innerJoin("users", "users.id", "notificationPreviewKeys.userId")
      .selectAll("notificationPreviewKeys")
      .where("notificationPreviewKeys.userId", "=", userId)
      .where("notificationPreviewKeys.accountId", "in", [...accountIds])
      .whereRef("authSessions.userId", "=", "notificationPreviewKeys.userId")
      .where("authSessions.expiresAt", ">", now)
      .where("authSessions.absoluteExpiresAt", ">", now)
      .where("users.disabledAt", "is", null)
      .orderBy("notificationPreviewKeys.installationId", "asc")
      .execute();
  }
}

function forbidden(): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    message: "Notification preview registration is not authorized",
  });
}
