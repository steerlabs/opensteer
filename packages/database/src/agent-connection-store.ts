import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { type UserId } from "@opensteer/core";
import type { AgentConnection } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { AgentConnectionTable, DatabaseSchema } from "./schema.js";
import "./connection.js";
export class AgentConnectionStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly now: () => Date;
  constructor(database: Kysely<DatabaseSchema>, now: () => Date = () => new Date()) {
    this.database = database;
    this.now = now;
  }
  async create(input: {
    userId: UserId;
    label: string;
    clientName: string;
    accessMode: AgentConnection["accessMode"];
    resource: string;
    expiresAt: Date;
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
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return view(row);
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
    return row ? view(row) : null;
  }
  async list(userId: UserId): Promise<AgentConnection[]> {
    await requirePersonalOwner(this.database, userId);
    return (
      await this.database
        .selectFrom("agentConnections")
        .selectAll()
        .where("userId", "=", userId)
        .where("revokedAt", "is", null)
        .where("expiresAt", ">", this.now())
        .orderBy("createdAt", "desc")
        .execute()
    ).map(view);
  }
  async revoke(userId: UserId, id: string): Promise<void> {
    await requirePersonalOwner(this.database, userId);
    // Idempotent and owner-filtered; a foreign ID discloses nothing.
    await this.database
      .updateTable("agentConnections")
      .set({
        revokedAt: this.now(),
        tokenHash: null,
      })
      .where("id", "=", id)
      .where("userId", "=", userId)
      .where("revokedAt", "is", null)
      .returning("id")
      .executeTakeFirst();
  }
}
function view(row: Selectable<AgentConnectionTable>): AgentConnection {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    clientName: row.clientName,
    accessMode: row.accessMode,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
