import type {
  ClaimedIntegrationAuthAttempt,
  IntegrationAuthAttemptFailureReason,
  IntegrationAuthAttemptId,
  IntegrationAuthAttemptRecord,
  IntegrationAuthAttemptStore as IntegrationAuthAttemptStorePort,
  IntegrationAuthAttemptFlow,
  IntegrationAuthAttemptSurface,
  LaunchableIntegrationAuthAttempt,
} from "@opensteer/integration-core/ports";
import type { UserId } from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/**
 * The auth-attempt payload column is `bytea NOT NULL` with a non-empty length check, so a terminal
 * attempt cannot store SQL NULL. Erasure overwrites the encrypted context with this sentinel and
 * readers treat a row carrying it as having no payload at all.
 */
export const erasedIntegrationAuthAttemptPayload: Buffer = Buffer.from("erased", "utf8");

export function isErasedIntegrationAuthAttemptPayload(payload: Buffer): boolean {
  return payload.equals(erasedIntegrationAuthAttemptPayload);
}

export class IntegrationAuthAttemptStore implements IntegrationAuthAttemptStorePort {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  async claimHostedAuthAttempt(input: {
    readonly id: import("@opensteer/integration-core").IntegrationOAuthAttemptId;
    readonly now: Date;
    readonly ownerUserId: UserId;
  }): Promise<ClaimedIntegrationAuthAttempt | null> {
    const claimed = await this.#database
      .updateTable("integrationAuthAttempts")
      .set({ claimedAt: input.now, status: "claimed" })
      .where("expiresAt", ">", input.now)
      .where("flow", "=", "provider-oauth")
      .where("id", "=", input.id)
      .where("ownerUserId", "=", input.ownerUserId)
      .where("status", "=", "launched")
      .returning(["encryptedPayload", "encryptionKeyVersion", "id", "ownerUserId", "surface"])
      .executeTakeFirst();
    if (claimed) return claimed;
    return (
      (await this.#database
        .selectFrom("integrationAuthAttempts")
        .select(["encryptedPayload", "encryptionKeyVersion", "id", "ownerUserId", "surface"])
        .where("expiresAt", ">", input.now)
        .where("flow", "=", "provider-oauth")
        .where("id", "=", input.id)
        .where("ownerUserId", "=", input.ownerUserId)
        .where("status", "=", "claimed")
        .executeTakeFirst()) ?? null
    );
  }

  async claimAuthAttempt(input: {
    readonly browserBindingHash: string;
    readonly flow: IntegrationAuthAttemptFlow;
    readonly id: IntegrationAuthAttemptId;
    readonly now: Date;
    readonly stateHash: string;
  }): Promise<ClaimedIntegrationAuthAttempt | null> {
    return (
      (await this.#database
        .updateTable("integrationAuthAttempts")
        .set({ claimedAt: input.now, status: "claimed" })
        .where("expiresAt", ">", input.now)
        .where("flow", "=", input.flow)
        .where("id", "=", input.id)
        .where("browserBindingHash", "=", input.browserBindingHash)
        .where("stateHash", "=", input.stateHash)
        .where("status", "=", "launched")
        .returning(["encryptedPayload", "encryptionKeyVersion", "id", "ownerUserId", "surface"])
        .executeTakeFirst()) ?? null
    );
  }

  async cancelAuthAttempt(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<boolean> {
    const result = await this.#database
      .updateTable("integrationAuthAttempts")
      .set({
        encryptedPayload: erasedIntegrationAuthAttemptPayload,
        failureReason: "cancelled",
        status: "failed",
      })
      .where("id", "=", input.id)
      .where("ownerUserId", "=", input.ownerUserId)
      .where("status", "in", ["pending", "launched"])
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async createAuthAttempt(input: {
    readonly encryptedPayload: Buffer;
    readonly encryptionKeyVersion: number;
    readonly expiresAt: Date;
    readonly flow: IntegrationAuthAttemptFlow;
    readonly id: IntegrationAuthAttemptId;
    readonly launchTicketHash: string;
    readonly ownerUserId: UserId;
    readonly stateHash: string;
    readonly surface: IntegrationAuthAttemptSurface;
  }): Promise<void> {
    await this.#database
      .insertInto("integrationAuthAttempts")
      .values({
        encryptedPayload: input.encryptedPayload,
        encryptionKeyVersion: input.encryptionKeyVersion,
        expiresAt: input.expiresAt,
        flow: input.flow,
        id: input.id,
        launchTicketHash: input.launchTicketHash,
        ownerUserId: input.ownerUserId,
        stateHash: input.stateHash,
        status: "pending",
        surface: input.surface,
      })
      .executeTakeFirstOrThrow();
  }

  async deleteExpiredAuthAttempts(now: Date): Promise<void> {
    await this.#database
      .deleteFrom("integrationAuthAttempts")
      .where("expiresAt", "<=", now)
      .execute();
  }

  async failAuthAttempt(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly reason: Exclude<IntegrationAuthAttemptFailureReason, "cancelled">;
  }): Promise<void> {
    await this.#database
      .updateTable("integrationAuthAttempts")
      .set({
        encryptedPayload: erasedIntegrationAuthAttemptPayload,
        failureReason: input.reason,
        status: "failed",
      })
      .where("id", "=", input.id)
      .where("status", "in", ["pending", "launched", "claimed"])
      .execute();
  }

  async findAuthAttemptForCallback(input: {
    readonly flow: IntegrationAuthAttemptFlow;
    readonly now: Date;
    readonly stateHash: string;
  }): Promise<{ readonly id: IntegrationAuthAttemptId } | null> {
    return (
      (await this.#database
        .selectFrom("integrationAuthAttempts")
        .select("id")
        .where("expiresAt", ">", input.now)
        .where("flow", "=", input.flow)
        .where("stateHash", "=", input.stateHash)
        .where("status", "=", "launched")
        .executeTakeFirst()) ?? null
    );
  }

  async getAuthAttempt(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<IntegrationAuthAttemptRecord | null> {
    return (
      (await this.#database
        .selectFrom("integrationAuthAttempts")
        .select([
          "expiresAt",
          "failureReason",
          "id",
          "ownerUserId",
          "resultConnectionId",
          "status",
          "surface",
        ])
        .where("id", "=", input.id)
        .where("ownerUserId", "=", input.ownerUserId)
        .executeTakeFirst()) ?? null
    );
  }

  async readAuthAttemptPayload(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<ClaimedIntegrationAuthAttempt | null> {
    return (
      (await this.#database
        .selectFrom("integrationAuthAttempts")
        .select(["encryptedPayload", "encryptionKeyVersion", "id", "ownerUserId", "surface"])
        .where("id", "=", input.id)
        .where("ownerUserId", "=", input.ownerUserId)
        .executeTakeFirst()) ?? null
    );
  }

  async launchAuthAttempt(input: {
    readonly browserBindingHash: string;
    readonly id: IntegrationAuthAttemptId;
    readonly launchTicketHash: string;
    readonly now: Date;
  }): Promise<LaunchableIntegrationAuthAttempt | null> {
    return (
      (await this.#database
        .updateTable("integrationAuthAttempts")
        .set({
          browserBindingHash: input.browserBindingHash,
          launchedAt: input.now,
          status: "launched",
        })
        .where("expiresAt", ">", input.now)
        .where("id", "=", input.id)
        .where("launchTicketHash", "=", input.launchTicketHash)
        .where("status", "=", "pending")
        .returning([
          "encryptedPayload",
          "encryptionKeyVersion",
          "flow",
          "id",
          "ownerUserId",
          "surface",
        ])
        .executeTakeFirst()) ?? null
    );
  }
}
