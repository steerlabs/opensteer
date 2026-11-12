import { createId, type DeploymentId, type TeamTaskOrigin, type ThreadId } from "@opensteer/core";
import { PersonalTeamLinkSchema, type PersonalTeamLink } from "@opensteer/protocol";
import type { Insertable, Kysely, Selectable } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export type StoredPersonalTeamLink = Selectable<DatabaseSchema["personalTeamLinks"]>;
export type PersonalTeamCredential = Insertable<DatabaseSchema["credentials"]>;

export class PersonalTeamLinksStore {
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  /** The local task a team thread is bound to, if it has one yet. */
  async task(origin: TeamTaskOrigin): Promise<ThreadId | null> {
    const row = await this.database
      .selectFrom("threads")
      .select("id")
      .where("teamId", "=", origin.teamId)
      .where("channelId", "=", origin.channelId)
      .where("threadRootId", "=", origin.threadRootId)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  get(teamId: DeploymentId) {
    return this.database
      .selectFrom("personalTeamLinks")
      .selectAll()
      .where("teamDeploymentId", "=", teamId)
      .executeTakeFirst();
  }

  list() {
    return this.database
      .selectFrom("personalTeamLinks")
      .selectAll()
      .orderBy("createdAt")
      .orderBy("teamDeploymentId")
      .execute();
  }

  async begin(
    input: Omit<Insertable<DatabaseSchema["personalTeamLinks"]>, "id" | "createdAt">,
    credential: PersonalTeamCredential,
  ): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      await tx.insertInto("credentials").values(credential).execute();
      await tx
        .insertInto("personalTeamLinks")
        .values({
          ...input,
          id: createId("credential"),
          createdAt: new Date().toISOString(),
        })
        .onConflict((conflict) =>
          conflict.column("teamDeploymentId").doUpdateSet({
            ...input,
          }),
        )
        .execute();
    });
  }

  async state(teamId: DeploymentId, state: StoredPersonalTeamLink["state"]): Promise<void> {
    await this.database
      .updateTable("personalTeamLinks")
      .set({ state })
      .where("teamDeploymentId", "=", teamId)
      .execute();
  }

  async versionMismatch(teamId: DeploymentId, behind: "personal" | "team"): Promise<void> {
    const link = await this.get(teamId);
    if (!link || ["leaving", "revoked"].includes(link.state)) return;
    await this.database
      .updateTable("personalTeamLinks")
      .set({
        state: "needs_update",
        authorityEnvelope: { ...link.authorityEnvelope, updateRequiredBy: behind },
      })
      .where("teamDeploymentId", "=", teamId)
      .where("state", "not in", ["leaving", "revoked"])
      .execute();
  }

  async observeName(teamId: DeploymentId, teamName: string): Promise<void> {
    const link = await this.get(teamId);
    if (!link || link.authorityEnvelope.teamName === teamName) return;
    await this.database
      .updateTable("personalTeamLinks")
      .set({ authorityEnvelope: { ...link.authorityEnvelope, teamName } })
      .where("teamDeploymentId", "=", teamId)
      .execute();
  }

  async active(
    teamId: DeploymentId,
    link: {
      readonly id: NonNullable<PersonalTeamLink["remoteLinkId"]>;
      readonly ownerUserId: NonNullable<PersonalTeamLink["ownerUserId"]>;
    },
  ): Promise<void> {
    await this.database
      .updateTable("personalTeamLinks")
      .set({
        state: "active",
        remoteLinkId: link.id,
        remoteOwnerUserId: link.ownerUserId,
        lastContactAt: new Date().toISOString(),
      })
      .where("teamDeploymentId", "=", teamId)
      .where("state", "not in", ["leaving", "revoked"])
      .execute();
  }

  view(link: StoredPersonalTeamLink): PersonalTeamLink {
    return PersonalTeamLinkSchema.parse({
      teamId: link.teamDeploymentId,
      hostInstanceId: link.teamHostInstanceId,
      origin: link.approvedOrigin,
      teamName: link.authorityEnvelope.teamName,
      remoteLinkId: link.remoteLinkId,
      ownerUserId: link.remoteOwnerUserId,
      state: link.state,
      updateRequiredBy:
        link.state === "needs_update" &&
        ["personal", "team"].includes(String(link.authorityEnvelope.updateRequiredBy))
          ? link.authorityEnvelope.updateRequiredBy
          : null,
      lastContactAt:
        link.lastContactAt === null ? null : new Date(link.lastContactAt).toISOString(),
    });
  }
}
