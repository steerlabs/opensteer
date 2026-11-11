import { randomBytes } from "node:crypto";
import { digestSecret, equalSecretDigests } from "@opensteer/shared/secretDigest";
import { type TeamActor, type TeamInviteId, type UserId } from "@opensteer/core";
import { TeamInviteSchema } from "@opensteer/protocol";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import {
  TeamAccessStore,
  emptyTeamAccessEffects,
  requireTeam,
  teamConflict,
} from "./team-access-store.js";
import { admitTeamMember, publishTeamMember } from "./team-members-store.js";
import { appendTeamAudit } from "./team-audit-store.js";

export class TeamInvitesStore {
  readonly access: TeamAccessStore;
  readonly origin: string;
  constructor(access: TeamAccessStore, origin: string) {
    this.access = access;
    this.origin = origin;
  }
  async create(
    actor: TeamActor,
    id: TeamInviteId,
    expiresAt = new Date(Date.now() + 7 * 86400000),
    maxUses = 1,
  ) {
    return this.access.mutateAs(actor, "invite.create", async (transaction) => {
      await this.access.admin(transaction, actor);
      requireTeam(maxUses === 1, "Invites admit one member");
      requireTeam(
        expiresAt > new Date() && expiresAt.getTime() <= Date.now() + 7 * 86400000,
        "Invite expiry must be within seven days",
      );
      const selector = randomBytes(24).toString("base64url"),
        verifier = randomBytes(32).toString("base64url");
      if (
        await transaction
          .selectFrom("teamInvites")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst()
      )
        teamConflict("The invite exists; create a new invite to obtain a new link");
      const row = await transaction
        .insertInto("teamInvites")
        .values({
          id,
          selector,
          verifierHash: digestSecret(verifier),
          maxUses: 1,
          expiresAt,
          revokedAt: null,
          createdBy: actor.userId,
          createdAt: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendTeamAudit(transaction, {
        actor,
        action: "invite.create",
        resourceKind: "team",
        resourceId: id,
      });
      return {
        value: {
          invite: TeamInviteSchema.strip().parse({
            ...row,
            expiresAt: row.expiresAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
            revokedAt: null,
          }),
          url: `${this.origin}/invite/${selector}#${verifier}`,
        },
        effects: emptyTeamAccessEffects,
      };
    });
  }
  async verify(selector: string, verifier: string) {
    const row = await this.access.database
      .selectFrom("teamInvites")
      .selectAll()
      .where("selector", "=", selector)
      .executeTakeFirst();
    requireTeam(
      row &&
        equalSecretDigests(row.verifierHash, digestSecret(verifier)) &&
        !row.revokedAt &&
        row.expiresAt > new Date(),
      "Invite unavailable",
    );
    return row;
  }
  async acceptInTransaction(
    transaction: Transaction<DatabaseSchema>,
    userId: UserId,
    selector: string,
  ) {
    const invite = await transaction
      .selectFrom("teamInvites")
      .selectAll()
      .where("selector", "=", selector)
      .forNoKeyUpdate()
      .executeTakeFirst();
    requireTeam(invite, "Invite unavailable");
    const receipt = await transaction
      .selectFrom("teamInviteUses")
      .selectAll()
      .where("inviteId", "=", invite.id)
      .where("userId", "=", userId)
      .executeTakeFirst();
    if (receipt) {
      const member = await this.access.member(transaction, userId);
      requireTeam(
        member.generation === receipt.memberGeneration,
        "This admission belongs to an earlier membership",
      );
      return member;
    }
    requireTeam(
      !invite.revokedAt && invite.expiresAt > new Date() && invite.usedCount < invite.maxUses,
      "Invite unavailable",
    );
    const member = await admitTeamMember(transaction, userId, "member");
    await transaction
      .insertInto("teamInviteUses")
      .values({
        inviteId: invite.id,
        userId,
        acceptedAt: new Date(),
        memberGeneration: member.generation,
      })
      .execute();
    await transaction
      .updateTable("teamInvites")
      .set({ usedCount: sql`used_count+1` })
      .where("id", "=", invite.id)
      .execute();
    await appendTeamAudit(transaction, {
      actor: { kind: "human", userId },
      action: "invite.accept",
      resourceKind: "member",
      resourceId: userId,
    });
    return member;
  }
  async accept(userId: UserId, selector: string, verifier: string) {
    await this.verify(selector, verifier);
    return this.access.mutate(
      async (transaction) => ({
        value: await this.acceptInTransaction(transaction, userId, selector),
        effects: emptyTeamAccessEffects,
      }),
      (transaction) => publishTeamMember(transaction, userId),
    );
  }
  async revoke(actor: TeamActor, id: TeamInviteId) {
    return this.access.mutateAs(actor, "invite.revoke", async (transaction) => {
      await this.access.admin(transaction, actor);
      const changed = await transaction
        .updateTable("teamInvites")
        .set({ revokedAt: new Date() })
        .where("id", "=", id)
        .where("revokedAt", "is", null)
        .returning("id")
        .execute();
      if (changed.length)
        await appendTeamAudit(transaction, {
          actor,
          action: "invite.revoke",
          resourceKind: "team",
          resourceId: id,
        });
      return { value: undefined, effects: emptyTeamAccessEffects };
    });
  }
  async page(actor: TeamActor, after?: TeamInviteId) {
    return this.access.database.transaction().execute(async (transaction) => {
      await this.access.admin(transaction, actor);
      let query = transaction.selectFrom("teamInvites").selectAll();
      if (after) query = query.where("id", ">", after);
      const rows = await query.orderBy("id").limit(51).execute();
      return {
        invites: rows.slice(0, 50).map((r) =>
          TeamInviteSchema.strip().parse({
            ...r,
            expiresAt: r.expiresAt.toISOString(),
            createdAt: r.createdAt.toISOString(),
            revokedAt: r.revokedAt?.toISOString() ?? null,
          }),
        ),
        hasMore: rows.length > 50,
      };
    });
  }
}
