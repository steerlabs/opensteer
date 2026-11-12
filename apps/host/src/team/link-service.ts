import { createHash, randomBytes } from "node:crypto";
import { createId, type DeploymentId, type TeamActor, type TeamLinkId } from "@opensteer/core";
import { serializeTeamLinkOffer, TeamLinkViewSchema } from "@opensteer/protocol";
import {
  TeamAccessStore,
  emptyTeamAccessEffects,
  requireTeam,
} from "@opensteer/database/team-access";
import { appendTeamAudit } from "@opensteer/database/team-audit";
import type { DatabaseSchema } from "@opensteer/database";
import type { Selectable } from "kysely";

function linkView(row: Selectable<DatabaseSchema["teamLinks"]>, teamName: string) {
  return TeamLinkViewSchema.strip().parse({
    ...row,
    teamName,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  });
}
export class TeamLinkService {
  readonly access: TeamAccessStore;
  readonly identity: {
    teamName: string;
    teamId: DeploymentId;
    origin: string;
    hostKeyFingerprint: string;
  };
  constructor(access: TeamAccessStore, identity: TeamLinkService["identity"]) {
    this.access = access;
    this.identity = identity;
  }
  async createCode(actor: TeamActor) {
    requireTeam(actor.kind === "human");
    return this.access.mutate(async (t) => {
      await this.access.member(t, actor.userId);
      const previous = await t
        .selectFrom("teamLinks")
        .selectAll()
        .where("ownerUserId", "=", actor.userId)
        .where("state", "in", ["active", "pending"])
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      for (const row of previous)
        if (row.state === "pending")
          await t
            .updateTable("teamLinks")
            .set({ state: "revoked", revokedAt: new Date() })
            .where("id", "=", row.id)
            .execute();
      const code = randomBytes(32).toString("base64url"),
        id = createId("teamLink");
      await t
        .insertInto("teamLinks")
        .values({
          id,
          ownerUserId: actor.userId,
          personalDeploymentId: null,
          state: "pending",
          codeHash: createHash("sha256").update(code).digest("hex"),
          codeExpiresAt: new Date(Date.now() + 10 * 60000),
          credentialHash: null,
          installationLabel: null,
          lastSeenAt: null,
          revokedAt: null,
        })
        .execute();
      await appendTeamAudit(t, {
        actor,
        action: "link.code.created",
        resourceKind: "link",
        resourceId: id,
        linkId: id,
      });
      const replacing = previous.find((row) => row.state === "active");
      return {
        value: {
          offer: serializeTeamLinkOffer({
            teamId: this.identity.teamId,
            origin: this.identity.origin,
            hostKeyFingerprint: this.identity.hostKeyFingerprint,
            code,
          }),
          replacing: replacing ? linkView(replacing, this.identity.teamName) : null,
        },
        effects: emptyTeamAccessEffects,
      };
    });
  }
  async list(actor: TeamActor) {
    requireTeam(actor.kind === "human");
    return this.access.database.transaction().execute(async (t) => {
      const member = await this.access.member(t, actor.userId);
      let query = t.selectFrom("teamLinks").selectAll().where("state", "in", ["active", "pending"]);
      if (member.role === "member") query = query.where("ownerUserId", "=", actor.userId);
      const links = await query.orderBy("id").limit(50).execute();
      return { links: links.map((row) => linkView(row, this.identity.teamName)) };
    });
  }
  async revoke(actor: TeamActor, id: TeamLinkId) {
    requireTeam(actor.kind === "human");
    await this.access.mutate(async (t) => {
      await this.access.member(t, actor.userId);
      const link = await t
        .selectFrom("teamLinks")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      requireTeam(link);
      if (link.ownerUserId !== actor.userId) await this.access.admin(t, actor);
      if (link.state === "revoked") return { value: undefined, effects: emptyTeamAccessEffects };
      await appendTeamAudit(t, {
        actor,
        action: "link.revoked",
        resourceKind: "link",
        resourceId: id,
        linkId: id,
      });
      return { value: undefined, effects: { ...emptyTeamAccessEffects, links: [id] } };
    });
  }
}
