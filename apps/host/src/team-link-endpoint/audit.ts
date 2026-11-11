import type { TeamAgentRequestId, TeamChannelId, TeamLinkId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import type { Kysely } from "kysely";

export async function auditTeamMachineCall(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly linkId: TeamLinkId;
    readonly requestId: TeamAgentRequestId;
    readonly action: string;
    readonly outcome: "allowed" | "denied";
    readonly channelId?: TeamChannelId;
  },
): Promise<void> {
  const link = await database
    .selectFrom("teamLinks")
    .select("ownerUserId")
    .where("id", "=", input.linkId)
    .executeTakeFirstOrThrow();
  const request = await database
    .selectFrom("teamAgentRequests")
    .select("id")
    .where("id", "=", input.requestId)
    .where("linkId", "=", input.linkId)
    .executeTakeFirst();
  const channel = input.channelId
    ? await database
        .selectFrom("teamChannels")
        .select("id")
        .where("id", "=", input.channelId)
        .executeTakeFirst()
    : undefined;
  await database
    .insertInto("teamAudit")
    .values({
      actorUserId: link.ownerUserId,
      actorKind: "agent",
      linkId: input.linkId,
      agentRequestId: request?.id ?? null,
      action: input.action,
      resourceKind: "request",
      resourceId: request?.id ?? null,
      channelId: channel?.id ?? null,
      outcome: input.outcome,
      metadata: {},
      occurredAt: new Date().toISOString(),
    })
    .execute();
}
