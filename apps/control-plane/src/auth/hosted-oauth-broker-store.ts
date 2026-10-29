import type {
  ControlPlaneAccountId,
  HostedOAuthAttemptId,
  HostedOAuthRefreshTransactionId,
  OAuthBrokerSealedEnvelope,
} from "@opensteer/control-plane-protocol";
import type { DeploymentId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";

const accountRateLimitPerMinute = 20;
const deploymentRateLimitPerMinute = 10;

export interface HostedOAuthAttemptDurableInput {
  readonly accountSubject: ControlPlaneAccountId;
  readonly attemptId: HostedOAuthAttemptId;
  readonly contextKeyVersion: number;
  readonly deploymentId: DeploymentId;
  readonly encryptedContext: Buffer;
  readonly expiresAt: Date;
  readonly hostPublicKey: string;
  readonly launchTicketHash: string;
  readonly provider: string;
  readonly providerApplicationRevision: number;
  readonly requestedScopeDigest: string;
  readonly stateHash: string;
}

export interface HostedOAuthRefreshDurableInput {
  readonly accountSubject: ControlPlaneAccountId;
  readonly deploymentId: DeploymentId;
  readonly expiresAt: Date;
  readonly hostPublicKey: string;
  readonly provider: string;
  readonly providerApplicationRevision: number;
  readonly transactionId: HostedOAuthRefreshTransactionId;
}

export class HostedOAuthBrokerStore {
  readonly #database: Kysely<ControlPlaneDatabaseSchema>;

  constructor(database: Kysely<ControlPlaneDatabaseSchema>) {
    this.#database = database;
  }

  async createAttempt(input: HostedOAuthAttemptDurableInput, now: Date) {
    assertHostedOAuthBrokerDurableRecord(input);
    await this.purgeExpired(now);
    return this.#database.transaction().execute(async (transaction) => {
      const deployment = await transaction
        .selectFrom("deployments")
        .select("id")
        .where("id", "=", input.deploymentId)
        .executeTakeFirst();
      if (!deployment) throw new ControlPlaneError("forbidden", "Hosted OAuth is unavailable");
      const existing = await transaction
        .selectFrom("hostedOAuthBrokerAttempts")
        .selectAll()
        .where("attemptId", "=", input.attemptId)
        .executeTakeFirst();
      if (existing) {
        if (
          existing.accountSubject !== input.accountSubject ||
          existing.deploymentId !== input.deploymentId ||
          existing.provider !== input.provider ||
          existing.requestedScopeDigest !== input.requestedScopeDigest ||
          existing.providerApplicationRevision !== input.providerApplicationRevision ||
          existing.hostPublicKey !== input.hostPublicKey ||
          existing.expiresAt.getTime() !== input.expiresAt.getTime()
        ) {
          throw new ControlPlaneError("conflict", "Hosted OAuth attempt ID was already used");
        }
        return existing;
      }
      const windowStart = new Date(now.getTime() - 60_000);
      const [deploymentCount, accountCount] = await Promise.all([
        transaction
          .selectFrom("hostedOAuthBrokerAttempts")
          .select((builder) => builder.fn.countAll<number>().as("count"))
          .where("deploymentId", "=", input.deploymentId)
          .where("createdAt", ">", windowStart)
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("hostedOAuthBrokerAttempts as attempt")
          .select((builder) => builder.fn.countAll<number>().as("count"))
          .where("attempt.accountSubject", "=", input.accountSubject)
          .where("attempt.createdAt", ">", windowStart)
          .executeTakeFirstOrThrow(),
      ]);
      if (
        Number(deploymentCount.count) >= deploymentRateLimitPerMinute ||
        Number(accountCount.count) >= accountRateLimitPerMinute
      ) {
        throw new ControlPlaneError("unavailable", "Hosted OAuth rate limit exceeded");
      }
      return transaction
        .insertInto("hostedOAuthBrokerAttempts")
        .values({
          accountSubject: input.accountSubject,
          attemptId: input.attemptId,
          contextKeyVersion: input.contextKeyVersion,
          createdAt: now,
          deploymentId: input.deploymentId,
          encryptedContext: input.encryptedContext,
          expiresAt: input.expiresAt,
          failureCode: null,
          hostPublicKey: input.hostPublicKey,
          launchTicketHash: input.launchTicketHash,
          provider: input.provider,
          providerApplicationRevision: input.providerApplicationRevision,
          requestedScopeDigest: input.requestedScopeDigest,
          sealedCiphertext: null,
          stateHash: input.stateHash,
          status: "pending",
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async launchAttempt(input: {
    readonly accountId: string;
    readonly attemptId: HostedOAuthAttemptId;
    readonly launchTicketHash: string;
    readonly now: Date;
  }) {
    return (
      (await this.#database
        .updateTable("hostedOAuthBrokerAttempts as attempt")
        .from("deployments as deployment")
        .set({ launchTicketHash: null, status: "launched", updatedAt: input.now })
        .whereRef("deployment.id", "=", "attempt.deploymentId")
        .where("attempt.accountSubject", "=", input.accountId as never)
        .where((builder) =>
          builder.or([
            builder("deployment.ownerAccountId", "=", input.accountId as never),
            builder.exists(
              builder
                .selectFrom("deploymentDirectoryEntries as member")
                .select("member.deploymentId")
                .whereRef("member.deploymentId", "=", "attempt.deploymentId")
                .where("member.accountId", "=", input.accountId as never)
                .where("member.present", "=", true),
            ),
          ]),
        )
        .where("attempt.attemptId", "=", input.attemptId)
        .where("attempt.expiresAt", ">", input.now)
        .where("attempt.launchTicketHash", "=", input.launchTicketHash)
        .where("attempt.status", "=", "pending")
        .returning([
          "attempt.contextKeyVersion as contextKeyVersion",
          "attempt.accountSubject as accountSubject",
          "attempt.deploymentId as deploymentId",
          "attempt.encryptedContext as encryptedContext",
          "attempt.expiresAt as expiresAt",
          "attempt.hostPublicKey as hostPublicKey",
          "attempt.provider as provider",
          "attempt.providerApplicationRevision as providerApplicationRevision",
          "attempt.requestedScopeDigest as requestedScopeDigest",
          "attempt.stateHash as stateHash",
        ])
        .executeTakeFirst()) ?? null
    );
  }

  async claimCallback(stateHash: string, now: Date) {
    return (
      (await this.#database
        .updateTable("hostedOAuthBrokerAttempts")
        .set({ status: "exchanging", updatedAt: now })
        .where("stateHash", "=", stateHash)
        .where("expiresAt", ">", now)
        .where("status", "=", "launched")
        .returningAll()
        .executeTakeFirst()) ?? null
    );
  }

  async sealAttempt(
    attemptId: HostedOAuthAttemptId,
    sealedCiphertext: OAuthBrokerSealedEnvelope,
    now: Date,
  ): Promise<void> {
    assertHostedOAuthBrokerDurableRecord({
      attemptId,
      deploymentId: "derived",
      expiresAt: now,
      hostPublicKey: "derived",
      provider: "derived",
      providerApplicationRevision: 1,
      requestedScopeDigest: "derived",
      sealedCiphertext,
    });
    await this.#database
      .updateTable("hostedOAuthBrokerAttempts")
      .set({
        contextKeyVersion: null,
        encryptedContext: null,
        launchTicketHash: null,
        sealedCiphertext,
        status: "sealed",
        updatedAt: now,
      })
      .where("attemptId", "=", attemptId)
      .where("status", "=", "exchanging")
      .executeTakeFirstOrThrow();
  }

  async failAttempt(
    attemptId: HostedOAuthAttemptId,
    status: "denied" | "failed",
    failureCode: string,
    now: Date,
  ): Promise<void> {
    await this.#database
      .updateTable("hostedOAuthBrokerAttempts")
      .set({
        contextKeyVersion: null,
        encryptedContext: null,
        failureCode,
        launchTicketHash: null,
        sealedCiphertext: null,
        status,
        updatedAt: now,
      })
      .where("attemptId", "=", attemptId)
      .where("status", "in", ["pending", "launched", "exchanging"])
      .execute();
  }

  async getAttemptForHost(deploymentId: DeploymentId, attemptId: HostedOAuthAttemptId, now: Date) {
    await this.purgeExpired(now);
    return (
      (await this.#database
        .selectFrom("hostedOAuthBrokerAttempts")
        .selectAll()
        .where("attemptId", "=", attemptId)
        .where("deploymentId", "=", deploymentId)
        .executeTakeFirst()) ?? null
    );
  }

  async acknowledgeAttempt(
    deploymentId: DeploymentId,
    attemptId: HostedOAuthAttemptId,
    now: Date,
  ): Promise<boolean> {
    const result = await this.#database
      .updateTable("hostedOAuthBrokerAttempts")
      .set({ sealedCiphertext: null, status: "acknowledged", updatedAt: now })
      .where("attemptId", "=", attemptId)
      .where("deploymentId", "=", deploymentId)
      .where("status", "=", "sealed")
      .executeTakeFirst();
    if (result.numUpdatedRows === 1n) return true;
    const existing = await this.#database
      .selectFrom("hostedOAuthBrokerAttempts")
      .select("status")
      .where("attemptId", "=", attemptId)
      .where("deploymentId", "=", deploymentId)
      .executeTakeFirst();
    return existing?.status === "acknowledged";
  }

  async pullAttemptResult(deploymentId: DeploymentId, attemptId: HostedOAuthAttemptId, now: Date) {
    await this.purgeExpired(now);
    return (
      (await this.#database
        .updateTable("hostedOAuthBrokerAttempts")
        .set({ retryGeneration: sql`retry_generation + 1`, updatedAt: now })
        .where("attemptId", "=", attemptId)
        .where("deploymentId", "=", deploymentId)
        .where("status", "=", "sealed")
        .returningAll()
        .executeTakeFirst()) ?? null
    );
  }

  async claimRefresh(input: HostedOAuthRefreshDurableInput, now: Date) {
    assertHostedOAuthBrokerDurableRecord(input);
    await this.purgeExpired(now);
    return this.#database.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`hosted-oauth-refresh-id:${input.transactionId}`}, 0))`.execute(
        transaction,
      );
      const existing = await transaction
        .selectFrom("hostedOAuthBrokerRefreshes")
        .selectAll()
        .where("transactionId", "=", input.transactionId)
        .executeTakeFirst();
      if (existing) {
        assertSameRefreshClaim(existing, input);
        return { claimed: false as const, row: existing };
      }
      const deployment = await transaction
        .selectFrom("deployments")
        .select("id")
        .where("id", "=", input.deploymentId)
        .executeTakeFirst();
      if (!deployment) throw new ControlPlaneError("forbidden", "Hosted OAuth is unavailable");
      await sql`select pg_advisory_xact_lock(hashtextextended(${`hosted-oauth-refresh-account:${input.accountSubject}`}, 0))`.execute(
        transaction,
      );
      const windowStart = new Date(now.getTime() - 60_000);
      const [deploymentCount, accountCount] = await Promise.all([
        transaction
          .selectFrom("hostedOAuthBrokerRefreshes")
          .select((builder) => builder.fn.countAll<number>().as("count"))
          .where("deploymentId", "=", input.deploymentId)
          .where("createdAt", ">", windowStart)
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("hostedOAuthBrokerRefreshes as refresh")
          .select((builder) => builder.fn.countAll<number>().as("count"))
          .where("refresh.accountSubject", "=", input.accountSubject)
          .where("refresh.createdAt", ">", windowStart)
          .executeTakeFirstOrThrow(),
      ]);
      if (
        Number(deploymentCount.count) >= deploymentRateLimitPerMinute ||
        Number(accountCount.count) >= accountRateLimitPerMinute
      ) {
        throw new ControlPlaneError("unavailable", "Hosted OAuth rate limit exceeded");
      }
      await transaction
        .insertInto("hostedOAuthBrokerRefreshes")
        .values({
          ...input,
          createdAt: now,
          failureCode: null,
          providerError: null,
          sealedCiphertext: null,
          status: "pending",
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      const row = await transaction
        .selectFrom("hostedOAuthBrokerRefreshes")
        .selectAll()
        .where("transactionId", "=", input.transactionId)
        .executeTakeFirstOrThrow();
      return { claimed: true as const, row };
    });
  }

  async sealRefresh(
    transactionId: HostedOAuthRefreshTransactionId,
    sealedCiphertext: OAuthBrokerSealedEnvelope,
    now: Date,
  ): Promise<void> {
    assertHostedOAuthBrokerDurableRecord({ sealedCiphertext, transactionId });
    const result = await this.#database
      .updateTable("hostedOAuthBrokerRefreshes")
      .set({ sealedCiphertext, status: "sealed", updatedAt: now })
      .where("transactionId", "=", transactionId)
      .where("status", "=", "pending")
      .where("expiresAt", ">", now)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new ControlPlaneError("conflict", "Hosted OAuth refresh claim is no longer pending");
    }
  }

  async failRefresh(
    transactionId: HostedOAuthRefreshTransactionId,
    failureCode: string,
    providerError: string | null,
    now: Date,
  ): Promise<void> {
    await this.#database
      .updateTable("hostedOAuthBrokerRefreshes")
      .set({ failureCode, providerError, sealedCiphertext: null, status: "failed", updatedAt: now })
      .where("transactionId", "=", transactionId)
      .where("status", "=", "pending")
      .execute();
  }

  async getRefreshForHost(
    deploymentId: DeploymentId,
    transactionId: HostedOAuthRefreshTransactionId,
    now: Date,
  ) {
    await this.purgeExpired(now);
    return (
      (await this.#database
        .selectFrom("hostedOAuthBrokerRefreshes")
        .selectAll()
        .where("deploymentId", "=", deploymentId)
        .where("transactionId", "=", transactionId)
        .executeTakeFirst()) ?? null
    );
  }

  async acknowledgeRefresh(
    deploymentId: DeploymentId,
    transactionId: HostedOAuthRefreshTransactionId,
    now: Date,
  ): Promise<boolean> {
    const result = await this.#database
      .updateTable("hostedOAuthBrokerRefreshes")
      .set({ sealedCiphertext: null, status: "acknowledged", updatedAt: now })
      .where("deploymentId", "=", deploymentId)
      .where("transactionId", "=", transactionId)
      .where("status", "=", "sealed")
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async deploymentBinding(deploymentId: DeploymentId) {
    return (
      (await this.#database
        .selectFrom("deployments")
        .select([
          "activeHostInstanceId",
          "canonicalOrigin",
          "hostKeyFingerprint",
          "id",
          "ownerAccountId",
          "reachability",
        ])
        .where("id", "=", deploymentId)
        .executeTakeFirst()) ?? null
    );
  }

  async hasDeploymentAccess(
    deploymentId: DeploymentId,
    accountId: ControlPlaneAccountId,
  ): Promise<boolean> {
    const access = await this.#database
      .selectFrom("deployments as deployment")
      .leftJoin("deploymentDirectoryEntries as member", (join) =>
        join
          .onRef("member.deploymentId", "=", "deployment.id")
          .on("member.accountId", "=", accountId),
      )
      .select(["deployment.ownerAccountId", "member.present"])
      .where("deployment.id", "=", deploymentId)
      .executeTakeFirst();
    return access?.ownerAccountId === accountId || access?.present === true;
  }

  async purgeExpired(now: Date): Promise<void> {
    await Promise.all([
      this.#database
        .updateTable("hostedOAuthBrokerAttempts")
        .set({
          contextKeyVersion: null,
          encryptedContext: null,
          launchTicketHash: null,
          sealedCiphertext: null,
          status: "expired",
          updatedAt: now,
        })
        .where("expiresAt", "<=", now)
        .where("status", "not in", ["acknowledged", "denied", "failed", "expired"])
        .execute(),
      this.#database
        .updateTable("hostedOAuthBrokerRefreshes")
        .set({ sealedCiphertext: null, status: "expired", updatedAt: now })
        .where("expiresAt", "<=", now)
        .where("status", "not in", ["acknowledged", "failed", "expired"])
        .execute(),
    ]);
  }
}

function assertSameRefreshClaim(
  existing: {
    readonly accountSubject: ControlPlaneAccountId;
    readonly deploymentId: DeploymentId;
    readonly expiresAt: Date;
    readonly hostPublicKey: string;
    readonly provider: string;
    readonly providerApplicationRevision: number;
  },
  input: HostedOAuthRefreshDurableInput,
): void {
  if (
    existing.accountSubject !== input.accountSubject ||
    existing.deploymentId !== input.deploymentId ||
    existing.expiresAt.getTime() !== input.expiresAt.getTime() ||
    existing.hostPublicKey !== input.hostPublicKey ||
    existing.provider !== input.provider ||
    existing.providerApplicationRevision !== input.providerApplicationRevision
  ) {
    throw new ControlPlaneError("conflict", "Hosted OAuth refresh ID was already used");
  }
}

/** The store accepts only the plan's safe metadata plus Host-sealed ciphertext. */
export function assertHostedOAuthBrokerDurableRecord(value: object): void {
  const allowed = new Set([
    "accountSubject",
    "attemptId",
    "contextKeyVersion",
    "deploymentId",
    "encryptedContext",
    "expiresAt",
    "hostPublicKey",
    "launchTicketHash",
    "provider",
    "providerApplicationRevision",
    "requestedScopeDigest",
    "sealedCiphertext",
    "stateHash",
    "transactionId",
  ]);
  const unexpectedKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpectedKey) {
    throw new TypeError(`Hosted OAuth broker cannot durably store ${unexpectedKey}`);
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > 512 * 1_024) {
    throw new TypeError("Hosted OAuth broker durable record is too large");
  }
}
