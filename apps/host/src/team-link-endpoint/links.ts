import { createHash } from "node:crypto";
import { type TeamLinkId } from "@opensteer/core";
import {
  TeamLinkCredentialSchema,
  TeamLinkRedeemSchema,
  TeamLinkViewSchema,
} from "@opensteer/protocol";
import type { DatabaseSchema } from "@opensteer/database";
import { sql, type Kysely, type Transaction } from "kysely";
import type { TeamAccessLockPort } from "../team/access-port.js";
import { linkError } from "./contracts.js";

export class TeamEndpointLinks {
  readonly database: Kysely<DatabaseSchema>;
  readonly access: TeamAccessLockPort;
  constructor(database: Kysely<DatabaseSchema>, access: TeamAccessLockPort) {
    this.database = database;
    this.access = access;
  }

  async authenticate(credential: string) {
    if (!TeamLinkCredentialSchema.safeParse(credential).success) throw linkError("unauthorized");
    const link = await this.database
      .selectFrom("teamLinks")
      .innerJoin("teamMembers", "teamMembers.userId", "teamLinks.ownerUserId")
      .selectAll("teamLinks")
      .where("credentialHash", "=", createHash("sha256").update(credential).digest("hex"))
      .where("teamLinks.state", "=", "active")
      .where("teamMembers.state", "=", "active")
      .executeTakeFirst();
    if (!link) throw linkError("unauthorized");
    return link;
  }

  async assertActive(linkId: TeamLinkId) {
    const link = await this.database
      .selectFrom("teamLinks")
      .innerJoin("teamMembers", "teamMembers.userId", "teamLinks.ownerUserId")
      .selectAll("teamLinks")
      .where("teamLinks.id", "=", linkId)
      .where("teamLinks.state", "=", "active")
      .where("teamMembers.state", "=", "active")
      .executeTakeFirst();
    if (!link) throw linkError("unauthorized");
    return link;
  }

  async seen(linkId: TeamLinkId): Promise<void> {
    await this.database
      .updateTable("teamLinks")
      .set({ lastSeenAt: new Date().toISOString() })
      .where("id", "=", linkId)
      .where("state", "=", "active")
      .execute();
  }

  async redeem(value: unknown) {
    const input = TeamLinkRedeemSchema.parse(value);
    return this.access.mutate(async (tx) => {
      const link = await tx
        .selectFrom("teamLinks")
        .selectAll()
        .where("codeHash", "=", createHash("sha256").update(input.code).digest("hex"))
        .executeTakeFirst();
      if (!link) throw linkError("unauthorized");
      const member = await tx
        .selectFrom("teamMembers")
        .select("state")
        .where("userId", "=", link.ownerUserId)
        .executeTakeFirst();
      if (member?.state !== "active") throw linkError("unauthorized");
      if (
        link.state === "active" &&
        link.credentialHash === input.credentialHash &&
        link.personalDeploymentId === input.personalDeploymentId
      ) {
        return {
          value: this.view(link),
          effects: { users: [], channels: [], topics: [], links: [], requests: [] },
        };
      }
      if (link.state !== "pending" || new Date(link.codeExpiresAt).getTime() <= Date.now())
        throw linkError("unauthorized");
      const previous = await tx
        .selectFrom("teamLinks")
        .select("id")
        .where("ownerUserId", "=", link.ownerUserId)
        .where("state", "=", "active")
        .orderBy("id")
        .execute();
      const effects = await this.#revoke(
        tx,
        previous.map((row) => row.id),
        [link.id],
      );
      const active = await tx
        .updateTable("teamLinks")
        .set({
          credentialHash: input.credentialHash,
          personalDeploymentId: input.personalDeploymentId,
          installationLabel: input.installationLabel,
          state: "active",
          revokedAt: null,
        })
        .where("id", "=", link.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("teamAudit")
        .values({
          actorUserId: link.ownerUserId,
          actorKind: "human",
          linkId: link.id,
          agentRequestId: null,
          action: "link.redeem",
          resourceKind: "link",
          resourceId: link.id,
          channelId: null,
          outcome: "allowed",
          metadata: {},
          occurredAt: new Date().toISOString(),
        })
        .execute();
      return { value: this.view(active), effects };
    });
  }

  async revoke(linkId: TeamLinkId): Promise<void> {
    await this.access.mutate(async (tx) => ({
      value: undefined,
      effects: await this.#revoke(tx, [linkId]),
    }));
  }

  async #revoke(
    tx: Transaction<DatabaseSchema>,
    links: readonly TeamLinkId[],
    reserved: readonly TeamLinkId[] = [],
  ) {
    const requests = links.length
      ? await tx
          .selectFrom("teamAgentRequests")
          .select(["id", "channelId", "threadRootId"])
          .where("linkId", "in", links)
          .where("state", "in", ["queued", "working", "needs_you"])
          .orderBy("id")
          .execute()
      : [];
    const channels = [...new Set(requests.map((r) => r.channelId))].sort();
    if (channels.length)
      await tx
        .selectFrom("teamChannels")
        .select("id")
        .where("id", "in", channels)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
    const linkLocks = [...new Set([...links, ...reserved])];
    if (linkLocks.length)
      await tx
        .selectFrom("teamLinks")
        .select("id")
        .where("id", "in", linkLocks)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
    const rootsToLock = [...new Set(requests.map((r) => r.threadRootId))];
    if (rootsToLock.length)
      await tx
        .selectFrom("teamMessages")
        .select("id")
        .where("id", "in", rootsToLock)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
    if (requests.length)
      await tx
        .selectFrom("teamAgentRequests")
        .select("id")
        .where(
          "id",
          "in",
          requests.map((r) => r.id),
        )
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
    for (const channelId of channels) {
      const channel = await tx
        .updateTable("teamChannels")
        .set({ changeSeq: sql`change_seq + 1` })
        .where("id", "=", channelId)
        .returning("changeSeq")
        .executeTakeFirstOrThrow();
      const roots = [
        ...new Set(requests.filter((r) => r.channelId === channelId).map((r) => r.threadRootId)),
      ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      if (roots.length) {
        await tx
          .updateTable("teamMessages")
          .set({ changeSeq: channel.changeSeq })
          .where("channelId", "=", channelId)
          .where("id", "in", roots)
          .execute();
      }
      await tx
        .updateTable("teamAgentRequests")
        .set({
          state: "cancelled",
          failureCode: "link_revoked",
          finishedAt: new Date().toISOString(),
          changeSeq: channel.changeSeq,
        })
        .where(
          "id",
          "in",
          requests.filter((r) => r.channelId === channelId).map((r) => r.id),
        )
        .execute();
    }
    if (links.length) {
      const active = await tx
        .updateTable("teamLinks")
        .set({ state: "revoked", revokedAt: new Date().toISOString() })
        .where("id", "in", links)
        .where("state", "!=", "revoked")
        .returningAll()
        .execute();
      for (const link of active)
        await tx
          .insertInto("teamAudit")
          .values({
            actorUserId: link.ownerUserId,
            actorKind: "human",
            linkId: link.id,
            agentRequestId: null,
            action: "link.revoke",
            resourceKind: "link",
            resourceId: link.id,
            channelId: null,
            outcome: "allowed",
            metadata: {},
            occurredAt: new Date().toISOString(),
          })
          .execute();
    }
    return { users: [], channels: [], topics: [], links, requests: requests.map((r) => r.id) };
  }

  view(link: {
    readonly id: TeamLinkId;
    readonly ownerUserId: unknown;
    readonly personalDeploymentId: unknown;
    readonly installationLabel: unknown;
    readonly state: unknown;
    readonly lastSeenAt: Date | string | null;
  }) {
    return TeamLinkViewSchema.parse({
      id: link.id,
      ownerUserId: link.ownerUserId,
      personalDeploymentId: link.personalDeploymentId,
      installationLabel: link.installationLabel,
      state: link.state,
      lastSeenAt: link.lastSeenAt === null ? null : new Date(link.lastSeenAt).toISOString(),
    });
  }
}
