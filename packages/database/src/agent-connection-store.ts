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
import { lineageOutstanding } from "./connection-disconnect.js";
import { jsonValue } from "./store-primitives.js";

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
    // Derived from the durable cleanup record and what its lineage still holds.
    const states = await Promise.all(
      rows.map(async (row): Promise<AgentConnectionState> => {
        if (row.revokedAt === null && row.expiresAt > now) return "active";
        if (row.cleanupCompletedAt) return "stopped";
        const outstanding = await lineageOutstanding(this.database, row.id);
        if (outstanding.handedOff) return "stopping";
        return row.revokedAt === null ? "expired" : "revoked";
      }),
    );
    return rows.map((row, index) => view(row, states[index]!));
  }
  /** Clears "last action uncertain" once the person has checked. */
  async acknowledgeUncertain(userId: UserId, id: string): Promise<void> {
    await requirePersonalOwner(this.database, userId);
    await this.database
      .updateTable("agentConnections")
      .set({ lastActionUncertainAt: null, lastActionUncertain: null })
      .where("id", "=", id)
      .where("userId", "=", userId)
      .execute();
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
        .set({
          revokedAt: this.now(),
          tokenHash: null,
          grantRevision: row.grantRevision + 1,
          // One durable record: the Home drives cleanup to completion from here, even after a
          // restart, and its state is read from what is still outstanding.
          cleanupReason: "revoked",
          cleanupRequestedAt: this.now(),
        })
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
      .select(["revokedAt", "expiresAt", "cleanupCompletedAt"])
      .where("id", "=", id)
      .where("userId", "=", userId)
      .executeTakeFirst();
    if (!row) return;
    if (row.revokedAt === null && row.expiresAt > this.now())
      throw new OpensteerError({
        code: "conflict",
        message: "Disconnect this agent before removing it.",
      });
    // A connection whose work has not finished stopping stays visible until it has.
    if (row.cleanupCompletedAt === null)
      throw new OpensteerError({
        code: "conflict",
        reason: "cleanup-outstanding",
        message: "This agent's work is still stopping. Remove it once it has stopped.",
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
    lastActionUncertainDetail: row.lastActionUncertainAt
      ? {
          at: row.lastActionUncertainAt.toISOString(),
          device: detailText(row.lastActionUncertain, "device"),
          task: detailText(row.lastActionUncertain, "task"),
          taskId: detailText(row.lastActionUncertain, "taskId"),
          tool: detailText(row.lastActionUncertain, "tool"),
          reason: detailText(row.lastActionUncertain, "reason"),
        }
      : null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function detailText(detail: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" ? value : null;
}
