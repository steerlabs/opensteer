import { effectiveMembershipPredicate } from "./effective-membership.js";
import { OpensteerError, type UserId } from "@opensteer/core";
import type { AgentConnection, AgentConnectionReach } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { AgentConnectionTable, DatabaseSchema } from "./schema.js";
import { withDatabaseTransaction } from "./connection.js";

export class AgentConnectionStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly now: () => Date;
  constructor(database: Kysely<DatabaseSchema>, now: () => Date = () => new Date()) {
    this.database = database;
    this.now = now;
  }

  async workspaces(userId: UserId) {
    return this.database
      .selectFrom("workspaces")
      .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
      .select(["workspaces.id", "workspaces.name"])
      .where("workspaceMemberships.userId", "=", userId)
      .where(effectiveMembershipPredicate(this.database))
      .where("workspaceMemberships.role", "=", "owner")
      .where("workspaces.deletedAt", "is", null)
      .execute();
  }

  async create(input: {
    userId: UserId;
    label: string;
    clientName: string;
    accessMode: AgentConnection["accessMode"];
    reach: AgentConnectionReach;
    resource: string;
    expiresAt: Date;
  }): Promise<AgentConnection> {
    return withDatabaseTransaction(this.database, async (tx) => {
      if (input.reach.kind === "workspace") {
        const workspace = await tx
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", input.reach.workspaceId)
          .where("deletedAt", "is", null)
          .forShare()
          .executeTakeFirst();
        if (!workspace)
          throw new OpensteerError({ code: "forbidden", message: "The Workspace is unavailable." });
        const membership = await tx
          .selectFrom("workspaceMemberships")
          .select("id")
          .where("workspaceMemberships.workspaceId", "=", input.reach.workspaceId)
          .where("workspaceMemberships.userId", "=", input.userId)
          .where("workspaceMemberships.role", "=", "owner")
          .where(effectiveMembershipPredicate(tx))
          .forShare()
          .executeTakeFirst();
        if (!membership)
          throw new OpensteerError({
            code: "forbidden",
            message: "Only a Workspace owner can connect an agent to it.",
          });
      }
      const owner = await tx
        .selectFrom("users")
        .select("id")
        .where("id", "=", input.userId)
        .where("disabledAt", "is", null)
        .forShare()
        .executeTakeFirst();
      if (!owner) throw unauthorized();
      const row = await tx
        .insertInto("agentConnections")
        .values({
          id: `mcn_${randomUUID()}`,
          userId: input.userId,
          label: input.label,
          clientName: input.clientName,
          accessMode: input.accessMode,
          workspaceId: input.reach.kind === "workspace" ? input.reach.workspaceId : null,
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
      .set({ tokenHash })
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
      .set({ lastUsedAt: now })
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
      .where(({ eb, or, exists, selectFrom }) =>
        or([
          eb("agentConnections.workspaceId", "is", null),
          exists(
            selectFrom("workspaceMemberships")
              .innerJoin("workspaces", "workspaces.id", "workspaceMemberships.workspaceId")
              .select("workspaceMemberships.id")
              .whereRef("workspaceMemberships.workspaceId", "=", "agentConnections.workspaceId")
              .whereRef("workspaceMemberships.userId", "=", "agentConnections.userId")
              .where(effectiveMembershipPredicate(this.database))
              .where("workspaceMemberships.role", "=", "owner")
              .where("workspaces.deletedAt", "is", null),
          ),
        ]),
      );
    if (resource !== undefined) query = query.where("resource", "=", resource);
    const row = await query.returningAll().executeTakeFirst();
    return row ? view(row) : null;
  }

  async list(userId: UserId): Promise<AgentConnection[]> {
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
    // Idempotent and owner-filtered; a foreign ID discloses nothing.
    await this.database
      .updateTable("agentConnections")
      .set({ revokedAt: this.now(), tokenHash: null })
      .where("id", "=", id)
      .where("userId", "=", userId)
      .where("revokedAt", "is", null)
      .returning("id")
      .executeTakeFirst();
  }
}
function unauthorized() {
  return new OpensteerError({
    code: "unauthorized",
    message: "The connected agent is not authorized.",
  });
}
function view(row: Selectable<AgentConnectionTable>): AgentConnection {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    clientName: row.clientName,
    accessMode: row.accessMode,
    reach:
      row.workspaceId === null
        ? { kind: "user" }
        : { kind: "workspace", workspaceId: row.workspaceId },
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
