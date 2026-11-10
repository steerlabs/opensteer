import { revokeTeamConnection } from "./team-connection-store.js";
import type { AccessWorkRevocationPort } from "./access-store.js";
import { OpensteerError, type UserId } from "@opensteer/core";
import type { AgentConnection, AgentConnectionReach } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { AgentConnectionTable, DatabaseSchema } from "./schema.js";
import { readDeploymentAuthority } from "./deployment-execution-authority.js";
import { withDatabaseTransaction } from "./connection.js";

export class AgentConnectionStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly now: () => Date;
  readonly #work: AccessWorkRevocationPort | undefined;
  #authority: ReturnType<typeof readDeploymentAuthority> | undefined;

  async #isTeam(): Promise<boolean> {
    const authority = await (this.#authority ??= readDeploymentAuthority(this.database));
    return authority.kind === "server" && authority.model === 2;
  }
  constructor(
    database: Kysely<DatabaseSchema>,
    now: () => Date = () => new Date(),
    work?: AccessWorkRevocationPort,
  ) {
    this.database = database;
    this.now = now;
    this.#work = work;
  }

  async workspaces(userId: UserId) {
    const team = await this.#isTeam();
    return this.database
      .selectFrom("workspaces")
      .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
      .select(["workspaces.id", "workspaces.name"])
      .where("workspaceMemberships.userId", "=", userId)
      .where("workspaceMemberships.state", "=", "active")
      .$if(!team, (query) => query.where("workspaceMemberships.role", "=", "owner"))
      .$if(team, (query) => query.where("workspaces.kind", "=", "project"))
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
    const team = await this.#isTeam();
    if (team && input.reach.kind !== "workspace") throw unauthorized();
    return withDatabaseTransaction(this.database, async (tx) => {
      let membershipGeneration: string | null = null;
      if (team && input.reach.kind === "workspace") {
        const admitted = await tx
          .selectFrom("users")
          .innerJoin("workspaceMemberships", "workspaceMemberships.userId", "users.id")
          .select("users.id")
          .where("users.id", "=", input.userId)
          .where("users.admittedAt", "is not", null)
          .where("users.memberState", "=", "active")
          .where("users.disabledAt", "is", null)
          .where("workspaceMemberships.workspaceId", "=", input.reach.workspaceId)
          .where("workspaceMemberships.state", "=", "active")
          .executeTakeFirst();
        if (!admitted) throw unauthorized();
      }
      if (input.reach.kind === "workspace") {
        const workspace = await tx
          .selectFrom("workspaces")
          .select(["id", "kind"])
          .where("id", "=", input.reach.workspaceId)
          .where("deletedAt", "is", null)
          .forShare()
          .executeTakeFirst();
        if (!workspace || (team && workspace.kind !== "project"))
          throw new OpensteerError({ code: "forbidden", message: "The Workspace is unavailable." });
        const membership = await tx
          .selectFrom("workspaceMemberships")
          .select(["id", "generation"])
          .where("workspaceMemberships.workspaceId", "=", input.reach.workspaceId)
          .where("workspaceMemberships.userId", "=", input.userId)
          .$if(!team, (query) => query.where("workspaceMemberships.role", "=", "owner"))
          .where("workspaceMemberships.state", "=", "active")
          .forShare()
          .executeTakeFirst();
        if (!membership)
          throw new OpensteerError({
            code: "forbidden",
            message: "Only a Workspace owner can connect an agent to it.",
          });
        membershipGeneration = team ? String(membership.generation) : null;
      }
      const owner = await tx
        .selectFrom("users")
        .select(["id", "admittedAt", "memberState", "authorityGeneration"])
        .where("id", "=", input.userId)
        .where("disabledAt", "is", null)
        .forShare()
        .executeTakeFirst();
      if (!owner || (team && (!owner.admittedAt || owner.memberState !== "active")))
        throw unauthorized();
      const row = await tx
        .insertInto("agentConnections")
        .values({
          id: `mcn_${randomUUID()}`,
          ...(team
            ? { memberGeneration: String(owner.authorityGeneration), membershipGeneration }
            : {}),
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
    const team = await this.#isTeam();
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
            .where("disabledAt", "is", null)
            .$if(team, (query) =>
              query
                .where("users.admittedAt", "is not", null)
                .where("users.memberState", "=", "active")
                .whereRef("users.authorityGeneration", "=", "agentConnections.memberGeneration"),
            ),
        ),
      )
      .where(({ eb, or, exists, selectFrom }) =>
        or([
          ...(team ? [] : [eb("agentConnections.workspaceId", "is", null)]),
          exists(
            selectFrom("workspaceMemberships")
              .innerJoin("workspaces", "workspaces.id", "workspaceMemberships.workspaceId")
              .select("workspaceMemberships.id")
              .whereRef("workspaceMemberships.workspaceId", "=", "agentConnections.workspaceId")
              .whereRef("workspaceMemberships.userId", "=", "agentConnections.userId")
              .where("workspaceMemberships.state", "=", "active")
              .$if(!team, (query) => query.where("workspaceMemberships.role", "=", "owner"))
              .$if(team, (query) =>
                query
                  .where("workspaces.kind", "=", "project")
                  .whereRef(
                    "workspaceMemberships.generation",
                    "=",
                    "agentConnections.membershipGeneration",
                  ),
              )
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
    if (await this.#isTeam()) {
      const owned = await this.database
        .selectFrom("agentConnections")
        .select("id")
        .where("id", "=", id)
        .where("userId", "=", userId)
        .executeTakeFirst();
      if (!owned) return;
      const state = await this.database
        .selectFrom("accessState")
        .select("revision")
        .where("singletonKey", "=", "primary")
        .executeTakeFirstOrThrow();
      await revokeTeamConnection(
        this.database,
        { userId },
        {
          connectionId: id,
          expectedRevision: Number(state.revision),
          idempotencyKey: `connection-revoke:${id}`,
        },
        this.#work,
      );
      return;
    }
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
