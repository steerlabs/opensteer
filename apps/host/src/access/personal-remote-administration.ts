import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { OpensteerError, type AuthenticatedSession } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import {
  PersonalRemoteAdministrationIntentSchema,
  PersonalRemoteAdministrationOperationSchema,
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
    accountIssuer: string | null;
    authorityEnvelope: import("@opensteer/deployment-authority").HostDiscoveryEnvelope;
  }) {
    this.#database = options.database;
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
    requirePersonalAdministrator(session);
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
    requirePersonalAdministrator(session);
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
              detail: "Replaced by a request to turn remote access off",
              updatedAt: new Date(),
            })
            .where("id", "=", active.id)
            .execute();
        } else if (active)
          throw new OpensteerError({
            code: "conflict",
            message:
              "A remote access change is already pending. Wait for the executor or turn access Off to cancel.",
          });
        const previous =
          intent.action === "recover"
            ? await transaction
                .selectFrom("personalRemoteAdministration")
                .selectAll()
                .orderBy("position", "desc")
                .limit(1)
                .executeTakeFirst()
            : undefined;
        const recovering = previous?.state === "failed";
        return PersonalRemoteAdministrationOperationSchema.parse(
          await transaction
            .insertInto("personalRemoteAdministration")
            .values({
              id,
              executionId: recovering ? previous.executionId : id,
              requestedIntent: intent,
              requestedBy: session.user.id,
              idempotencyKey,
              intent: recovering ? previous.intent : intent,
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
    const row = await this.#latest();
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

export function requirePersonalAdministrator(session: AuthenticatedSession): void {
  if (session.user.instanceRole !== "administrator")
    throw new OpensteerError({ code: "forbidden", message: "Personal owner access required" });
}
