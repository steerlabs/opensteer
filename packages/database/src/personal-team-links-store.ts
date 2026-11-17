import { createId, type DeploymentId, type TeamTaskOrigin, type ThreadId } from "@opensteer/core";
import { PersonalTeamLinkSchema, type PersonalTeamLink } from "@opensteer/protocol";
import type { Insertable, Kysely, Selectable } from "kysely";
import { commitPersonalMutation, type PersonalMutation } from "./personal-mutation.js";
import { updateAttentionLinkContribution } from "./personal-attention-store.js";
import type { DatabaseSchema } from "./schema.js";

export type StoredPersonalTeamLink = Selectable<DatabaseSchema["personalTeamLinks"]>;
export type PersonalTeamCredential = Insertable<DatabaseSchema["credentials"]>;

function linkChanged(
  mutation: PersonalMutation,
  before: StoredPersonalTeamLink | undefined,
  after: StoredPersonalTeamLink["state"],
) {
  if (before)
    updateAttentionLinkContribution(mutation, {
      before: before.state,
      after,
      bucket: before.approvalAttentionCount,
    });
  mutation.change(
    {
      scopeKey: "shell",
      entityKind: "collection",
      entityId: "team-links",
      operation: "invalidate",
    },
    () => ({ revision: mutation.sequence }),
  );
}

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

  get(teamId: DeploymentId, database = this.database) {
    return database
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
    input: Omit<
      Insertable<DatabaseSchema["personalTeamLinks"]>,
      "id" | "createdAt" | "approvalAttentionCount"
    >,
    credential: PersonalTeamCredential,
  ): Promise<void> {
    await commitPersonalMutation(this.database, async (tx, mutation) => {
      const before = await this.get(input.teamDeploymentId, tx);
      await tx.insertInto("credentials").values(credential).execute();
      const id = createId("credential");
      await tx
        .insertInto("personalTeamLinks")
        .values({
          ...input,
          id,
          createdAt: new Date().toISOString(),
        })
        .onConflict((conflict) =>
          conflict.column("teamDeploymentId").doUpdateSet({
            ...input,
            id,
          }),
        )
        .execute();
      await tx
        .deleteFrom("personalTeamPosts")
        .where("teamDeploymentId", "=", input.teamDeploymentId)
        .execute();
      linkChanged(mutation, before, input.state);
    });
  }

  async state(teamId: DeploymentId, state: StoredPersonalTeamLink["state"]): Promise<void> {
    await commitPersonalMutation(this.database, async (tx, mutation) => {
      const before = await this.get(teamId, tx);
      if (!before || before.state === state) return;
      await tx
        .updateTable("personalTeamLinks")
        .set({ state })
        .where("teamDeploymentId", "=", teamId)
        .execute();
      linkChanged(mutation, before, state);
    });
  }

  async versionMismatch(teamId: DeploymentId, behind: "personal" | "team"): Promise<void> {
    await commitPersonalMutation(this.database, async (tx, mutation) => {
      const link = await this.get(teamId, tx);
      if (
        !link ||
        link.state === "leaving" ||
        link.state === "revoked" ||
        (link.state === "needs_update" && link.authorityEnvelope.updateRequiredBy === behind)
      )
        return;
      await tx
        .updateTable("personalTeamLinks")
        .set({
          state: "needs_update",
          authorityEnvelope: { ...link.authorityEnvelope, updateRequiredBy: behind },
        })
        .where("teamDeploymentId", "=", teamId)
        .execute();
      linkChanged(mutation, link, "needs_update");
    });
  }

  async observeName(teamId: DeploymentId, teamName: string): Promise<void> {
    await commitPersonalMutation(this.database, async (tx, mutation) => {
      const link = await this.get(teamId, tx);
      if (!link || link.authorityEnvelope.teamName === teamName) return;
      await tx
        .updateTable("personalTeamLinks")
        .set({ authorityEnvelope: { ...link.authorityEnvelope, teamName } })
        .where("teamDeploymentId", "=", teamId)
        .execute();
      linkChanged(mutation, link, link.state);
    });
  }

  async active(
    teamId: DeploymentId,
    link: {
      readonly id: NonNullable<PersonalTeamLink["remoteLinkId"]>;
      readonly ownerUserId: NonNullable<PersonalTeamLink["ownerUserId"]>;
    },
  ): Promise<void> {
    await commitPersonalMutation(this.database, async (tx, mutation) => {
      const before = await this.get(teamId, tx);
      if (!before || before.state === "leaving" || before.state === "revoked") return;
      await tx
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
      linkChanged(mutation, before, "active");
    });
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
