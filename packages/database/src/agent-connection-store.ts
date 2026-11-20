import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import {
  AgentGrantSchema,
  OpensteerError,
  agentGrantNarrowed,
  everythingAgentGrant,
  threadAccessModeAtMost,
  type AgentGrant,
  type UserId,
} from "@opensteer/core";
import type { AgentConnection, AgentConnectionState } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { AgentConnectionTable, DatabaseSchema } from "./schema.js";
import { withDatabaseTransaction } from "./connection.js";
import { databaseOperation } from "./operation-budget.js";
import { jsonValue } from "./store-primitives.js";

/** Run states whose execution may already have left the Home. */
const handedOffRunStatuses = ["starting", "running", "waiting"] as const;

export class AgentConnectionStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly now: () => Date;
  constructor(database: Kysely<DatabaseSchema>, now: () => Date = () => new Date()) {
    this.database = database;
    this.now = now;
  }
  /** A client that sent a grant made its consent on the grant screen (`consentVersion` 2). */
  async create(input: {
    userId: UserId;
    label: string;
    clientName: string;
    accessMode: AgentConnection["accessMode"];
    resource: string;
    expiresAt: Date;
    grant?: AgentGrant;
    clientFingerprint?: string;
    redirectUri?: string;
  }): Promise<AgentConnection> {
    return withPersonalTransaction(this.database, async (tx) => {
      await requirePersonalOwner(tx, input.userId);
      const row = await tx
        .insertInto("agentConnections")
        .values({
          id: `mcn_${randomUUID()}`,
          userId: input.userId,
          label: input.label,
          clientName: input.clientName,
          accessMode: input.accessMode,
          resource: input.resource,
          createdAt: this.now(),
          expiresAt: input.expiresAt,
          tokenHash: null,
          lastUsedAt: null,
          revokedAt: null,
          grant: jsonValue(
            input.grant ? AgentGrantSchema.parse(input.grant) : everythingAgentGrant,
          ),
          consentVersion: input.grant ? 2 : 1,
          clientFingerprint: input.clientFingerprint ?? null,
          redirectUri: input.redirectUri ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return view(row, "active");
    });
  }
  async activate(id: string, tokenHash: string): Promise<boolean> {
    const result = await this.database
      .updateTable("agentConnections")
      .set({
        tokenHash,
      })
      .where("id", "=", id)
      .where("tokenHash", "is", null)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", this.now())
      .returning("id")
      .executeTakeFirst();
    return result !== undefined;
  }
  async authenticate(tokenHash: string, resource?: string): Promise<AgentConnection | null> {
    if (databaseOperation() && !this.database.isTransaction)
      return withDatabaseTransaction(this.database, (tx) =>
        new AgentConnectionStore(tx, this.now).authenticate(tokenHash, resource),
      );
    const now = this.now();
    let query = this.database
      .updateTable("agentConnections")
      .set({
        lastUsedAt: now,
      })
      .where("tokenHash", "=", tokenHash)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", now)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("users")
            .select("id")
            .whereRef("users.id", "=", "agentConnections.userId")
            .where("disabledAt", "is", null),
        ),
      )
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("personalSettings")
            .select("singletonKey")
            .whereRef("personalSettings.ownerId", "=", "agentConnections.userId"),
        ),
      );
    if (resource !== undefined) query = query.where("resource", "=", resource);
    const row = await query.returningAll().executeTakeFirst();
    return row ? view(row, "active") : null;
  }
  async list(
    userId: UserId,
    options: { readonly includeRevoked?: boolean } = {},
  ): Promise<AgentConnection[]> {
    await requirePersonalOwner(this.database, userId);
    const now = this.now();
    const rows = await this.database
      .selectFrom("agentConnections")
      .selectAll()
      .where("userId", "=", userId)
      .$if(!options.includeRevoked, (query) =>
        query.where("revokedAt", "is", null).where("expiresAt", ">", now),
      )
      .$if(options.includeRevoked === true, (query) => query.where("removedAt", "is", null))
      .orderBy("createdAt", "desc")
      .execute();
    const ended = rows.filter((row) => row.revokedAt !== null || row.expiresAt <= now);
    const stopping = new Set(
      ended.length
        ? (
            await this.database
              .selectFrom("runs")
              .select("connectionId")
              .distinct()
              .where(
                "connectionId",
                "in",
                ended.map((row) => row.id),
              )
              .where("status", "in", handedOffRunStatuses)
              .execute()
          ).map((row) => row.connectionId)
        : [],
    );
    return rows.map((row) =>
      view(
        row,
        row.revokedAt === null && row.expiresAt > now
          ? "active"
          : stopping.has(row.id)
            ? "stopping"
            : row.revokedAt === null
              ? "expired"
              : "stopped",
      ),
    );
  }
  /** Revision-checked; returns whether the edit withdrew authority that live work may hold. */
  async update(
    userId: UserId,
    input: {
      readonly connectionId: string;
      readonly expectedRevision: number;
      readonly label?: string;
      readonly accessMode?: AgentConnection["accessMode"];
      readonly grant?: AgentGrant;
    },
  ): Promise<{ readonly connection: AgentConnection; readonly narrowed: boolean }> {
    return withPersonalTransaction(this.database, async (tx) => {
      await requirePersonalOwner(tx, userId);
      const current = await tx
        .selectFrom("agentConnections")
        .selectAll()
        .where("id", "=", input.connectionId)
        .where("userId", "=", userId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current || current.revokedAt !== null || current.expiresAt <= this.now())
        throw new OpensteerError({
          code: "not_found",
          message: "This connected agent is no longer connected.",
        });
      if (current.grantRevision !== input.expectedRevision)
        throw new OpensteerError({
          code: "conflict",
          reason: "revision-changed",
          message: "This connected agent changed since you opened it. Review it and try again.",
        });
      const grant = input.grant ? AgentGrantSchema.parse(input.grant) : current.grant;
      const accessMode = input.accessMode ?? current.accessMode;
      const narrowed =
        agentGrantNarrowed(current.grant, grant) ||
        !threadAccessModeAtMost(current.accessMode, accessMode);
      const row = await tx
        .updateTable("agentConnections")
        .set({
          label: input.label ?? current.label,
          accessMode,
          grant: jsonValue(grant),
          grantRevision: current.grantRevision + 1,
        })
        .where("id", "=", current.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { connection: view(row, "active"), narrowed };
    });
  }
  /**
   * Disconnect's durable decision. Inside the personal fence the owner-filtered row is locked
   * `FOR NO KEY UPDATE`, which every admission of lineaged work holds `FOR SHARE` (or re-reads
   * under a row this sweep later locks), so once this commits no new work in the lineage starts.
   * Idempotent and owner-filtered; a foreign ID discloses nothing. Returns whether it was live.
   */
  async revoke(userId: UserId, id: string): Promise<boolean> {
    return commitPersonalMutation(this.database, async (tx) => {
      await requirePersonalOwner(tx, userId);
      const row = await tx
        .selectFrom("agentConnections")
        .select(["id", "revokedAt", "grantRevision"])
        .where("id", "=", id)
        .where("userId", "=", userId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || row.revokedAt !== null) return false;
      await tx
        .updateTable("agentConnections")
        .set({ revokedAt: this.now(), tokenHash: null, grantRevision: row.grantRevision + 1 })
        .where("id", "=", row.id)
        .execute();
      return true;
    });
  }
  /** Takes an ended connection off the list; an active one must be disconnected first. */
  async remove(userId: UserId, id: string): Promise<void> {
    await requirePersonalOwner(this.database, userId);
    const row = await this.database
      .selectFrom("agentConnections")
      .select(["revokedAt", "expiresAt"])
      .where("id", "=", id)
      .where("userId", "=", userId)
      .executeTakeFirst();
    if (!row) return;
    if (row.revokedAt === null && row.expiresAt > this.now())
      throw new OpensteerError({
        code: "conflict",
        message: "Disconnect this agent before removing it.",
      });
    await this.database
      .updateTable("agentConnections")
      .set({ removedAt: this.now() })
      .where("id", "=", id)
      .where("userId", "=", userId)
      .where("removedAt", "is", null)
      .execute();
  }
}
function view(row: Selectable<AgentConnectionTable>, state: AgentConnectionState): AgentConnection {
  let redirectOrigin: string | null = null;
  try {
    redirectOrigin = row.redirectUri ? new URL(row.redirectUri).origin : null;
  } catch {
    redirectOrigin = null;
  }
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    clientName: row.clientName,
    accessMode: row.accessMode,
    grant: AgentGrantSchema.parse(row.grant),
    grantRevision: row.grantRevision,
    consentVersion: row.consentVersion,
    client: { fingerprint: row.clientFingerprint, redirectOrigin },
    state,
    lastActionUncertain: row.lastActionUncertainAt !== null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
