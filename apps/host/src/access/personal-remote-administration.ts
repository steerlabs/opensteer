import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { OpensteerError, type AuthenticatedSession } from "@opensteer/core";
import {
  requestSettlementActor,
  requirePersonalOwner,
  type DatabaseSchema,
} from "@opensteer/database";
import {
  PersonalRemoteAdministrationIntentSchema,
  PersonalRemoteAdministrationOperationSchema,
  personalRemoteAdministrationChangedReason,
  type PersonalRemoteAccessStatus,
  type PersonalRemoteAdministrationIntent,
  type PersonalRemoteAdministrationOperation,
  type PersonalRemoteAdministrationStatus,
  type PersonalRemoteExecutorProgressSchema,
} from "@opensteer/protocol";
import type { Kysely } from "kysely";
import type { z } from "zod";

export class PersonalRemoteAdministration {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #resumeAccountOperation: (intent: PersonalRemoteAdministrationIntent) => Promise<void>;
  readonly #readAccess: () => Promise<PersonalRemoteAccessStatus>;
  readonly #accountIssuer: string | null;
  readonly #authorityEnvelope: import("@opensteer/deployment-authority").HostDiscoveryEnvelope;
  readonly #listeners = new Set<() => void>();
  readonly #held = new Set<string>();
  #closed = false;
  #executor: object | null = null;
  #revision = 0;

  constructor(options: {
    database: Kysely<DatabaseSchema>;
    readAccess: () => Promise<PersonalRemoteAccessStatus>;
    resumeAccountOperation: (intent: PersonalRemoteAdministrationIntent) => Promise<void>;
    accountIssuer: string | null;
    authorityEnvelope: import("@opensteer/deployment-authority").HostDiscoveryEnvelope;
  }) {
    this.#database = options.database;
    this.#resumeAccountOperation = options.resumeAccountOperation;
    this.#readAccess = options.readAccess;
    this.#accountIssuer = options.accountIssuer;
    this.#authorityEnvelope = options.authorityEnvelope;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#executor = null;
    this.changed();
    this.#listeners.clear();
  }

  changed(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }

  async status(session: AuthenticatedSession): Promise<PersonalRemoteAdministrationStatus> {
    await requirePersonalAdministrator(this.#database, session);
    const revision = this.#revision;
    const [access, row] = await Promise.all([this.#readAccess(), this.#latest()]);
    const operation = row ? PersonalRemoteAdministrationOperationSchema.parse(row) : null;
    if (
      operation &&
      (operation.state === "pending" || operation.state === "running") &&
      !this.#executor
    ) {
      operation.state = "pending";
      operation.detail = "Waiting for the Opensteer desktop app to run on this computer.";
    }
    return {
      access,
      authorityEnvelope: this.#authorityEnvelope,
      accountIssuer: this.#accountIssuer,
      executorConnected: this.#executor !== null,
      operation,
      revision,
    };
  }

  async request(
    session: AuthenticatedSession,
    intentInput: PersonalRemoteAdministrationIntent,
    idempotencyKey: string,
  ): Promise<PersonalRemoteAdministrationOperation> {
    await requirePersonalAdministrator(this.#database, session);
    const intent = PersonalRemoteAdministrationIntentSchema.parse(intentInput);
    if (
      (intent.action === "rotate" ||
        (intent.action === "configure" && intent.mode === "connect")) &&
      !this.#accountIssuer
    ) {
      throw new OpensteerError({
        code: "not_found",
        message: "Opensteer Connect is unavailable in this build",
      });
    }
    const id = randomUUID();
    this.#held.add(id);
    try {
      const operation = await this.#database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("personalRemoteAccess")
          .select("singletonKey")
          .where("singletonKey", "=", "personal")
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        await requestSettlementActor(transaction, session.user.id, session.id);
        const replay = await transaction
          .selectFrom("personalRemoteAdministration")
          .selectAll()
          .where("requestedBy", "=", session.user.id)
          .where("idempotencyKey", "=", idempotencyKey)
          .executeTakeFirst();
        if (replay) {
          if (!isDeepStrictEqual(replay.requestedIntent, intent))
            throw new OpensteerError({
              code: "conflict",
              message: "This operation key was already used for another action",
            });
          return PersonalRemoteAdministrationOperationSchema.parse(replay);
        }
        const latest = await transaction
          .selectFrom("personalRemoteAdministration")
          .selectAll()
          .orderBy("position", "desc")
          .limit(1)
          .executeTakeFirst();
        // Recover replays the failure the caller saw, never one another device left since.
        if (
          intent.action === "recover" &&
          (latest?.id !== intent.operationId || latest.state !== "failed")
        )
          throw new OpensteerError({
            code: "conflict",
            reason: personalRemoteAdministrationChangedReason,
            message: "This changed on another device. Check it and try again.",
          });
        const active = await transaction
          .selectFrom("personalRemoteAdministration")
          .select("id")
          .where("state", "in", ["pending", "running"])
          .executeTakeFirst();
        if (active && intent.action === "configure" && intent.mode === "off") {
          await transaction
            .updateTable("personalRemoteAdministration")
            .set({
              state: "failed",
              detail: "Replaced by turning remote access off.",
              updatedAt: new Date(),
            })
            .where("id", "=", active.id)
            .execute();
        } else if (active)
          throw new OpensteerError({
            code: "conflict",
            message:
              "Another change is still in progress. Wait for it to finish, or turn this off.",
          });
        const previous = intent.action === "recover" ? latest : undefined;
        const effective = previous ? previous.intent : intent;
        if (
          effective.action === "rotate" ||
          (effective.action === "configure" && effective.mode === "connect")
        ) {
          // The same rule PersonalRemoteAccessService.configure applies, under its
          // own lock, when the intent runs. A plain read: locking the link here,
          // after the session row, would invert the Account-operation lock order.
          const account = await transaction
            .selectFrom("personalRemoteAccountLink")
            .select(["state", "accountOperation"])
            .where("singletonKey", "=", "opensteer-account")
            .executeTakeFirst();
          if (account?.state !== "active" || account.accountOperation?.kind === "unlink")
            throw new OpensteerError({
              code: "conflict",
              message: "Add this computer to your Opensteer account first.",
            });
        }
        return PersonalRemoteAdministrationOperationSchema.parse(
          await transaction
            .insertInto("personalRemoteAdministration")
            .values({
              id,
              executionId: previous ? previous.executionId : id,
              requestedIntent: intent,
              requestedBy: session.user.id,
              idempotencyKey,
              intent: effective,
              state: "pending",
              detail: null,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      });
      if (operation.id !== id) this.#held.delete(id);
      return operation;
    } catch (error) {
      this.#held.delete(id);
      throw error;
    }
  }

  release(operationId: string): void {
    this.#held.delete(operationId);
    this.changed();
  }

  attachExecutor(executor: object): () => void {
    if (this.#executor)
      throw new OpensteerError({
        code: "conflict",
        message: "A desktop executor is already connected",
      });
    this.#executor = executor;
    this.changed();
    return () => {
      if (this.#executor !== executor) return;
      this.#executor = null;
      this.changed();
    };
  }

  async next(executor: object): Promise<PersonalRemoteAdministrationOperation | null> {
    if (this.#closed || executor !== this.#executor) return null;
    let row = await this.#latest();
    if (!row || this.#held.has(row.id) || (row.state !== "pending" && row.state !== "running"))
      return null;
    // Recover finishes the prior Account step before replaying its coordinator.
    // A fresh Off or unlink intent must still reach the executor while Account is down.
    if (row.requestedIntent.action === "recover" || row.executionId !== row.id) {
      try {
        await this.#resumeAccountOperation(row.intent);
      } catch {
        const updated = await this.#database
          .updateTable("personalRemoteAdministration")
          .set({
            state: "failed",
            detail: "Couldn't finish the earlier change with your Opensteer account. Try again.",
            updatedAt: new Date(),
          })
          .where("id", "=", row.id)
          .where("state", "in", ["pending", "running"])
          .executeTakeFirst();
        if (updated.numUpdatedRows > 0n) this.changed();
        return null;
      }
    }
    if (this.#closed || executor !== this.#executor) return null;
    row = await this.#latest();
    return row && !this.#held.has(row.id) && (row.state === "pending" || row.state === "running")
      ? PersonalRemoteAdministrationOperationSchema.parse(row)
      : null;
  }

  async progress(
    executor: object,
    progress: z.infer<typeof PersonalRemoteExecutorProgressSchema>,
  ): Promise<void> {
    if (executor !== this.#executor)
      throw new OpensteerError({ code: "forbidden", message: "Executor connection has ended" });
    const updated = await this.#database
      .updateTable("personalRemoteAdministration")
      .set({ state: progress.state, detail: progress.detail, updatedAt: new Date() })
      .where("id", "=", progress.operationId)
      .where("state", "in", ["pending", "running"])
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) return;
    this.changed();
  }

  #latest() {
    return this.#database
      .selectFrom("personalRemoteAdministration")
      .selectAll()
      .orderBy("position", "desc")
      .limit(1)
      .executeTakeFirst();
  }
}

export async function requirePersonalAdministrator(
  database: Kysely<DatabaseSchema>,
  session: AuthenticatedSession,
): Promise<void> {
  await requirePersonalOwner(database, session.user.id);
}
