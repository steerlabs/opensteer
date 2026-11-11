import type { TeamActor, TeamGroupId, UserId } from "@opensteer/core";
import { TeamGroupSchema } from "@opensteer/protocol";
import { sql } from "kysely";
import {
  TeamAccessStore,
  emptyTeamAccessEffects,
  requireTeam,
  teamConflict,
} from "./team-access-store.js";
import { appendTeamAudit } from "./team-audit-store.js";

export class TeamGroupsStore {
  readonly access: TeamAccessStore;
  constructor(access: TeamAccessStore) {
    this.access = access;
  }
  async get(actor: TeamActor, groupId: TeamGroupId) {
    return this.access.database.transaction().execute(async (transaction) => {
      await this.access.member(transaction, actor.userId);
      const group = await transaction
        .selectFrom("teamGroups")
        .selectAll()
        .where("id", "=", groupId)
        .where("deletedAt", "is", null)
        .executeTakeFirstOrThrow();
      const people = await transaction
        .selectFrom("teamGroupPeople")
        .select("userId")
        .where("groupId", "=", groupId)
        .orderBy("userId")
        .limit(1000)
        .execute();
      const children = await transaction
        .selectFrom("teamGroupEdges")
        .select("childGroupId")
        .where("parentGroupId", "=", groupId)
        .orderBy("childGroupId")
        .limit(1000)
        .execute();
      return TeamGroupSchema.strip().parse({
        ...group,
        people: people.map((r) => r.userId),
        children: children.map((r) => r.childGroupId),
        updatedAt: group.updatedAt.toISOString(),
      });
    });
  }
  async page(actor: TeamActor, after?: TeamGroupId) {
    const ids = await this.access.database.transaction().execute(async (transaction) => {
      await this.access.member(transaction, actor.userId);
      let query = transaction.selectFrom("teamGroups").select("id").where("deletedAt", "is", null);
      if (after) query = query.where("id", ">", after);
      return query.orderBy("id").limit(51).execute();
    });
    return {
      groups: await Promise.all(ids.slice(0, 50).map(({ id }) => this.get(actor, id))),
      hasMore: ids.length > 50,
    };
  }
  async create(actor: TeamActor, id: TeamGroupId, name: string) {
    return this.access.mutateAs(actor, "group.create", async (transaction) => {
      await this.access.admin(transaction, actor);
      const inserted = await transaction
        .insertInto("teamGroups")
        .values({
          id,
          name,
          normalizedName: name.normalize("NFKC").toLowerCase(),
          createdBy: actor.userId,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        })
        .onConflict((c) => c.column("id").doNothing())
        .returning("createdBy")
        .executeTakeFirst();
      if (!inserted)
        requireTeam(
          (
            await transaction
              .selectFrom("teamGroups")
              .select("createdBy")
              .where("id", "=", id)
              .executeTakeFirstOrThrow()
          ).createdBy === actor.userId,
        );
      if (inserted)
        await appendTeamAudit(transaction, {
          actor,
          action: "group.create",
          resourceKind: "group",
          resourceId: id,
        });
      return { value: undefined, effects: emptyTeamAccessEffects };
    });
  }
  async renameOrDelete(actor: TeamActor, id: TeamGroupId, name: string | null) {
    return this.access.mutateAs(
      actor,
      name === null ? "group.delete" : "group.rename",
      async (transaction) => {
        await this.access.admin(transaction, actor);
        const row = await transaction
          .selectFrom("teamGroups")
          .selectAll()
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if ((name === null && !row.deletedAt) || (name !== null && row.name !== name)) {
          await transaction
            .updateTable("teamGroups")
            .set(
              name === null
                ? { deletedAt: new Date(), updatedAt: new Date() }
                : {
                    name,
                    normalizedName: name.normalize("NFKC").toLowerCase(),
                    updatedAt: new Date(),
                  },
            )
            .where("id", "=", id)
            .execute();
          await appendTeamAudit(transaction, {
            actor,
            action: name === null ? "group.delete" : "group.rename",
            resourceKind: "group",
            resourceId: id,
          });
        }
        return { value: undefined, effects: emptyTeamAccessEffects };
      },
    );
  }
  async person(actor: TeamActor, groupId: TeamGroupId, userId: UserId, add: boolean) {
    return this.access.mutateAs(
      actor,
      `group.person.${add ? "add" : "remove"}`,
      async (transaction) => {
        await this.access.admin(transaction, actor);
        await this.access.member(transaction, userId);
        requireTeam(
          await transaction
            .selectFrom("teamGroups")
            .select("id")
            .where("id", "=", groupId)
            .where("deletedAt", "is", null)
            .executeTakeFirst(),
        );
        const result = add
          ? await transaction
              .insertInto("teamGroupPeople")
              .values({ groupId, userId, addedBy: actor.userId, addedAt: new Date() })
              .onConflict((c) => c.columns(["groupId", "userId"]).doNothing())
              .returning("userId")
              .execute()
          : await transaction
              .deleteFrom("teamGroupPeople")
              .where("groupId", "=", groupId)
              .where("userId", "=", userId)
              .returning("userId")
              .execute();
        if (result.length)
          await appendTeamAudit(transaction, {
            actor,
            action: `group.person.${add ? "add" : "remove"}`,
            resourceKind: "group",
            resourceId: groupId,
            metadata: { userId },
          });
        return { value: undefined, effects: emptyTeamAccessEffects };
      },
    );
  }
  async child(actor: TeamActor, parent: TeamGroupId, child: TeamGroupId, add: boolean) {
    return this.access.mutateAs(
      actor,
      `group.child.${add ? "add" : "remove"}`,
      async (transaction) => {
        await this.access.admin(transaction, actor);
        const groups = await transaction
          .selectFrom("teamGroups")
          .select("id")
          .where("id", "in", [parent, child].sort())
          .where("deletedAt", "is", null)
          .orderBy("id")
          .forUpdate()
          .execute();
        requireTeam(groups.length === 2, "Both groups must exist and differ");
        const result = add
          ? await transaction
              .insertInto("teamGroupEdges")
              .values({
                parentGroupId: parent,
                childGroupId: child,
                addedBy: actor.userId,
                addedAt: new Date(),
              })
              .onConflict((c) => c.columns(["parentGroupId", "childGroupId"]).doNothing())
              .returning("parentGroupId")
              .execute()
          : await transaction
              .deleteFrom("teamGroupEdges")
              .where("parentGroupId", "=", parent)
              .where("childGroupId", "=", child)
              .returning("parentGroupId")
              .execute();
        if (add) {
          const invalid = (
            await sql<{ invalid: boolean }>`with recursive paths(id,path,cycle) as (
          select id,array[id],false from team_groups where deleted_at is null union all
          select e.child_group_id,p.path||e.child_group_id,e.child_group_id=any(p.path) from paths p
          join team_group_edges e on e.parent_group_id=p.id join team_groups g on g.id=e.child_group_id and g.deleted_at is null
          where not p.cycle and cardinality(p.path)<=16)
          select exists(select 1 from paths where cycle or cardinality(path)>16) as invalid`.execute(
              transaction,
            )
          ).rows[0]?.invalid;
          if (invalid) teamConflict("Groups must be acyclic and at most 16 levels deep");
        }
        if (result.length)
          await appendTeamAudit(transaction, {
            actor,
            action: `group.child.${add ? "add" : "remove"}`,
            resourceKind: "group",
            resourceId: parent,
            metadata: { childGroupId: child },
          });
        return { value: undefined, effects: emptyTeamAccessEffects };
      },
    );
  }
}
