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

function linkView(row: Selectable<DatabaseSchema["teamLinks"]>) {
  return TeamLinkViewSchema.strip().parse({
    ...row,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  });
}
export class TeamLinkService {
  readonly access: TeamAccessStore;
  readonly identity: { teamId: DeploymentId; origin: string; hostKeyFingerprint: string };
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
          offer: serializeTeamLinkOffer({ ...this.identity, code }),
          replacing: replacing ? linkView(replacing) : null,
        },
        effects: emptyTeamAccessEffects,
      };
    });
  }
  async list(actor: TeamActor) {
    requireTeam(actor.kind === "human");
    return this.access.database.transaction().execute(async (t) => {
      await this.access.member(t, actor.userId);
      const links = await t
        .selectFrom("teamLinks")
        .selectAll()
        .where("ownerUserId", "=", actor.userId)
        .where("state", "in", ["active", "pending"])
        .orderBy("id")
        .limit(50)
        .execute();
      return { links: links.map(linkView) };
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
        .where("ownerUserId", "=", actor.userId)
        .executeTakeFirst();
      requireTeam(link);
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
