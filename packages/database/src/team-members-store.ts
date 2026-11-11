import { uniqueTeamHandle, type TeamActor, type UserId } from "@opensteer/core";
import { TeamMemberSchema } from "@opensteer/protocol";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { TeamAccessStore, emptyTeamAccessEffects, requireTeam } from "./team-access-store.js";
import { appendTeamAudit } from "./team-audit-store.js";

export async function publishTeamMember(transaction: Transaction<DatabaseSchema>, userId: UserId) {
  await sql`insert into account_directory_projections(provider_id,account_id,user_id,present,generation,published_generation)
    select p.provider_id,a.account_id,m.user_id,m.state='active',1,0 from team_members m
    join auth_accounts a on a.user_id=m.user_id join account_directory_provider p on p.provider_id=a.provider_id
    where m.user_id=${userId}
    on conflict(provider_id,account_id) do update set present=excluded.present,
    generation=account_directory_projections.generation+1,next_attempt_at=now(),lease_token=null,lease_expires_at=null,updated_at=now()`.execute(
    transaction,
  );
}

export async function admitTeamMember(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
  role: "owner" | "member",
) {
  const user = await transaction
    .selectFrom("users")
    .selectAll()
    .where("id", "=", userId)
    .where("disabledAt", "is", null)
    .executeTakeFirstOrThrow();
  const existing = await transaction
    .selectFrom("teamMembers")
    .selectAll()
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (existing?.state === "active") return existing;
  if (existing)
    await transaction
      .updateTable("teamMembers")
      .set({ state: "active", role, generation: sql`generation+1`, changedAt: new Date() })
      .where("userId", "=", userId)
      .execute();
  else {
    const occupied = await transaction.selectFrom("teamMembers").select("handle").execute();
    await transaction
      .insertInto("teamMembers")
      .values({
        userId,
        handle: uniqueTeamHandle(user.displayName, new Set(occupied.map((r) => r.handle))),
        role,
        state: "active",
        joinedAt: new Date(),
        changedAt: new Date(),
        changedBy: null,
      })
      .execute();
  }
  await publishTeamMember(transaction, userId);
  return transaction
    .selectFrom("teamMembers")
    .selectAll()
    .where("userId", "=", userId)
    .executeTakeFirstOrThrow();
}

export class TeamMembersStore {
  readonly access: TeamAccessStore;
  constructor(access: TeamAccessStore) {
    this.access = access;
  }
  async page(actor: TeamActor, after?: UserId) {
    return this.access.database.transaction().execute(async (transaction) => {
      await this.access.member(transaction, actor.userId);
      let query = transaction
        .selectFrom("teamMembers as m")
        .innerJoin("users as u", "u.id", "m.userId")
        .selectAll("m")
        .select(["u.displayName", "u.image"]);
      if (after) query = query.where("m.userId", ">", after);
      const rows = await query.orderBy("m.userId").limit(51).execute();
      return {
        members: rows
          .slice(0, 50)
          .map((row) =>
            TeamMemberSchema.strip().parse({ ...row, joinedAt: row.joinedAt.toISOString() }),
          ),
        hasMore: rows.length > 50,
      };
    });
  }
  async change(actor: TeamActor, userId: UserId, change: "remove" | "owner" | "admin" | "member") {
    return this.access.mutateAs(actor, `member.${change}`, async (transaction) => {
      const caller = await this.access.admin(transaction, actor);
      const rows = await transaction
        .selectFrom("teamMembers")
        .selectAll()
        .where((e) => e.or([e("role", "=", "owner"), e("userId", "in", [actor.userId, userId])]))
        .orderBy("userId")
        .forUpdate()
        .execute();
      const target = rows.find((r) => r.userId === userId);
      requireTeam(target?.state === "active");
      requireTeam(
        caller.role === "owner" || target.role === "member",
        "Only an owner can change administrators",
      );
      if (change === "owner")
        requireTeam(caller.role === "owner", "Only an owner can transfer ownership");
      if (target.role === "owner" && change !== "owner")
        requireTeam(
          rows.filter((r) => r.role === "owner" && r.state === "active").length > 1,
          "The last owner cannot leave",
        );
      if (change === "owner" && target.userId !== actor.userId)
        await transaction
          .updateTable("teamMembers")
          .set({ role: "admin", changedAt: new Date(), changedBy: actor.userId })
          .where("userId", "=", actor.userId)
          .execute();
      const changed = change === "remove" || target.role !== change;
      if (changed) {
        await transaction
          .updateTable("teamMembers")
          .set(
            change === "remove"
              ? {
                  state: "removed",
                  generation: sql`generation+1`,
                  changedAt: new Date(),
                  changedBy: actor.userId,
                }
              : { role: change, changedAt: new Date(), changedBy: actor.userId },
          )
          .where("userId", "=", userId)
          .execute();
        if (change === "remove") {
          await transaction.deleteFrom("teamGroupPeople").where("userId", "=", userId).execute();
          await transaction
            .deleteFrom("teamChannelMembers")
            .where("subjectKind", "=", "person")
            .where("subjectId", "=", userId)
            .execute();
          await transaction
            .deleteFrom("teamTopicGrants")
            .where("subjectKind", "=", "person")
            .where("subjectId", "=", userId)
            .execute();
        }
        await publishTeamMember(transaction, userId);
        await appendTeamAudit(transaction, {
          actor,
          action: `member.${change}`,
          resourceKind: "member",
          resourceId: userId,
        });
      }
      return { value: undefined, effects: { ...emptyTeamAccessEffects, users: [userId] } };
    });
  }
}
