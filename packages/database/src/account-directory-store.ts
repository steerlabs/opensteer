import { withDatabaseTransaction } from "./connection.js";
import { randomBytes } from "node:crypto";
import { OpensteerError, type UserId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

// The projection carries membership only — which Account subjects this Host
// currently exposes. The Host's signed identity document is not part of this
// payload: the Host publishes it separately on every start, so nothing here has
// to be versioned or requeued when the discovery document format changes.

export interface AccountDirectoryProjection {
  readonly accountId: string;
  readonly attempts: number;
  readonly generation: number;
  readonly leaseToken: string;
  readonly observedAt: string;
  readonly present: boolean;
  readonly providerId: string;
  readonly userId: UserId;
}

export class AccountDirectoryStore {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  async configureProvider(input: {
    readonly issuer: string;
    readonly providerId: string;
  }): Promise<void> {
    const issuer = normalizedIssuer(input.issuer);
    const providerId = input.providerId.trim();
    if (!providerId || providerId.length > 512) {
      throw new TypeError("Account directory provider ID is invalid");
    }
    await withDatabaseTransaction(this.#database, async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtextextended('opensteer:account-directory-provider', 0))`.execute(
        transaction,
      );
      const existing = await transaction
        .selectFrom("accountDirectoryProvider")
        .select(["issuer", "providerId"])
        .where("singletonKey", "=", "opensteer-account")
        .executeTakeFirst();
      if (existing && (existing.providerId !== providerId || existing.issuer !== issuer)) {
        throw new OpensteerError({
          code: "conflict",
          message: "Opensteer Account provider identity does not match durable Host state",
        });
      }
      if (existing) return;
      await transaction
        .insertInto("accountDirectoryProvider")
        .values({
          createdAt: new Date(),
          issuer,
          providerId,
          singletonKey: "opensteer-account",
          updatedAt: new Date(),
        })
        .execute();
      await sql`
        select opensteer_refresh_account_directory_user(id)
        from users
      `.execute(transaction);
    });
  }

  async refreshUser(userId: UserId): Promise<void> {
    await sql`select opensteer_refresh_account_directory_user(${userId})`.execute(this.#database);
  }

  async claimPending(
    input: {
      readonly limit?: number;
      readonly now?: Date;
    } = {},
  ): Promise<readonly AccountDirectoryProjection[]> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Account directory claim limit must be between 1 and 100");
    }
    return withDatabaseTransaction(this.#database, async (transaction) => {
      // `nextAttemptAt` is written by PostgreSQL triggers. Compare it with the
      // database clock as well, avoiding a process/DB clock skew window in
      // which newly committed projections appear not to be ready.
      const now =
        input.now ??
        (
          await transaction
            .selectNoFrom(sql<Date>`clock_timestamp()`.as("now"))
            .executeTakeFirstOrThrow()
        ).now;
      // Keep the readiness comparison inside PostgreSQL. Round-tripping its
      // clock through Date truncates microseconds and can miss a projection
      // committed earlier in the same millisecond.
      const readyAt = input.now ?? sql<Date>`clock_timestamp()`;
      const rows = await transaction
        .selectFrom("accountDirectoryProjections")
        .select([
          "accountId",
          "attempts",
          "generation",
          "present",
          "providerId",
          "updatedAt",
          "userId",
        ])
        .whereRef("publishedGeneration", "<", "generation")
        .where("nextAttemptAt", "<=", readyAt)
        .where((expression) =>
          expression.or([
            expression("leaseToken", "is", null),
            expression("leaseExpiresAt", "<=", readyAt),
          ]),
        )
        .orderBy("nextAttemptAt", "asc")
        .orderBy("updatedAt", "asc")
        .limit(limit)
        .forNoKeyUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) return [];
      const leaseExpiresAt = new Date(now.getTime() + 60_000);
      const claimed: AccountDirectoryProjection[] = [];
      for (const row of rows) {
        const leaseToken = randomBytes(32).toString("base64url");
        const updated = await transaction
          .updateTable("accountDirectoryProjections")
          .set({
            attempts: sql`attempts + 1`,
            leaseExpiresAt,
            leaseToken,
            nextAttemptAt: leaseExpiresAt,
          })
          .where("providerId", "=", row.providerId)
          .where("accountId", "=", row.accountId)
          .where("generation", "=", row.generation)
          .returning([
            "accountId",
            "attempts",
            "generation",
            "present",
            "providerId",
            "updatedAt",
            "userId",
          ])
          .executeTakeFirstOrThrow();
        claimed.push(projectionFromRow({ ...updated, leaseToken }));
      }
      return claimed;
    });
  }

  async complete(input: {
    readonly accountId: string;
    readonly generation: number;
    readonly leaseToken: string;
    readonly providerId: string;
  }): Promise<boolean> {
    const result = await this.#database
      .updateTable("accountDirectoryProjections")
      .set({
        lastError: null,
        leaseExpiresAt: null,
        leaseToken: null,
        publishedGeneration: input.generation,
        updatedAt: new Date(),
      })
      .where("providerId", "=", input.providerId)
      .where("accountId", "=", input.accountId)
      .where("generation", "=", String(input.generation))
      .where("leaseToken", "=", input.leaseToken)
      .where("publishedGeneration", "<", String(input.generation))
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async fail(input: {
    readonly accountId: string;
    readonly error: string;
    readonly generation: number;
    readonly leaseToken: string;
    readonly nextAttemptAt: Date;
    readonly providerId: string;
  }): Promise<boolean> {
    const message = input.error.trim().slice(0, 2_000);
    if (!message) throw new TypeError("Account directory publication error is required");
    const result = await this.#database
      .updateTable("accountDirectoryProjections")
      .set({
        lastError: message,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: input.nextAttemptAt,
      })
      .where("providerId", "=", input.providerId)
      .where("accountId", "=", input.accountId)
      .where("generation", "=", String(input.generation))
      .where("leaseToken", "=", input.leaseToken)
      .where("publishedGeneration", "<", String(input.generation))
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}

function normalizedIssuer(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Account directory issuer must be an uncredentialed HTTP(S) URL");
  }
  return url.toString().replace(/\/$/u, "");
}

function projectionFromRow(row: {
  readonly accountId: string;
  readonly attempts: number;
  readonly generation: string;
  readonly leaseToken: string;
  readonly present: boolean;
  readonly providerId: string;
  readonly updatedAt: Date;
  readonly userId: UserId;
}): AccountDirectoryProjection {
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new OpensteerError({ code: "internal", message: "Directory generation is invalid" });
  }
  if (!Number.isSafeInteger(row.attempts) || row.attempts < 1) {
    throw new OpensteerError({ code: "internal", message: "Directory attempts are invalid" });
  }
  const { updatedAt, ...projection } = row;
  return { ...projection, generation, observedAt: updatedAt.toISOString() };
}
