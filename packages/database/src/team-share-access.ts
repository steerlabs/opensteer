import { OpensteerError, type TeamActor, type TeamChannelId } from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export interface TeamPartnerWriteContext {
  shareId: string;
  partnerLinkId: string;
  generation: number;
  attachments?: readonly import("@opensteer/protocol").TeamShareFile[];
}
export function shareNotFound(): never {
  throw new OpensteerError({ code: "not_found", message: "Shared channel not found" });
}
export function channelShare(t: Transaction<DatabaseSchema>, channelId: TeamChannelId) {
  return t
    .selectFrom("teamShares")
    .selectAll()
    .where("channelId", "=", channelId)
    .orderBy(sql`case when state='ended' then 1 else 0 end`)
    .orderBy("createdAt", "desc")
    .executeTakeFirst();
}
export async function authorizePartnerWrite(
  t: Transaction<DatabaseSchema>,
  actor: TeamActor,
  channelId: TeamChannelId,
  context: TeamPartnerWriteContext,
) {
  const row = await t
    .selectFrom("teamShares as s")
    .innerJoin("teamPartnerLinks as l", "l.id", "s.partnerLinkId")
    .innerJoin("teamChannels as c", "c.id", "s.channelId")
    .innerJoin("teamShareParticipants as a", "a.shareId", "s.id")
    .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
    .select(["s.id", "c.peopleOnly"])
    .where("s.id", "=", context.shareId)
    .where("s.partnerLinkId", "=", context.partnerLinkId)
    .where("s.channelId", "=", channelId)
    .where("s.generation", "=", context.generation)
    .where("s.role", "=", "owner")
    .where("s.state", "=", "active")
    .where("c.archivedAt", "is", null)
    .where("l.state", "=", "active")
    .whereRef("p.homeTeamId", "=", "l.partnerTeamId")
    .where("a.principalId", "=", actor.userId)
    .where("a.state", "=", "active")
    .where("a.blocked", "=", false)
    .where("a.level", "=", "post")
    .where((eb) =>
      eb.exists(
        eb.selectFrom("teamSharingSettings").select("singletonKey").where("policy", "!=", "off"),
      ),
    )
    .executeTakeFirst();
  if (!row || (row.peopleOnly && actor.kind === "agent")) shareNotFound();
}
export async function requireOwnerChannel(
  t: Transaction<DatabaseSchema>,
  channelId: TeamChannelId,
) {
  const share = await channelShare(t, channelId);
  if (share?.role === "follower")
    throw new OpensteerError({
      code: "conflict",
      reason: "shared-channel-relay-required",
      message:
        share.state === "ended"
          ? "This shared channel is disconnected"
          : "Shared channel writes require the owner relay",
    });
  return share?.state === "active" ? share : undefined;
}
