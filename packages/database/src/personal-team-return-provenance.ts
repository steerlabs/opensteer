import type {
  DeploymentId,
  TeamAgentReturnPayload,
  TeamMessageId,
  TeamSource,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function personalTeamReturnPost(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly teamId: DeploymentId;
    readonly triggerMessageId: TeamMessageId;
    readonly source: TeamSource;
    readonly returnPayload: TeamAgentReturnPayload | null;
  },
) {
  const payload = input.returnPayload;
  if (
    !payload?.author ||
    payload.author.actor !== "agent" ||
    !payload.author.handle ||
    !payload.triggerClientMessageId
  )
    return null;
  const author = payload.author;
  const link = await database
    .selectFrom("personalTeamLinks")
    .selectAll()
    .where("teamDeploymentId", "=", input.teamId)
    .where("state", "in", ["active", "unreachable"])
    .executeTakeFirst();
  if (!link || payload.author.teamUserId === link.remoteOwnerUserId) return null;
  const post = await database
    .selectFrom("personalTeamPosts")
    .selectAll()
    .where("teamDeploymentId", "=", input.teamId)
    .where("clientMessageId", "=", payload.triggerClientMessageId)
    .where("localLinkId", "=", link.id)
    .where("remoteLinkId", "=", link.remoteLinkId)
    .where("runId", "=", payload.resumeRunId)
    .where("channelId", "=", input.source.channelId)
    .where("createdAt", ">", new Date(Date.now() - 14 * 86400000))
    .executeTakeFirst();
  if (
    !post ||
    !post.mentionedAgentHandles.includes(`${payload.author.handle}-agent`) ||
    (post.threadRootId !== null && post.threadRootId !== input.source.threadRootId)
  )
    return null;
  if (post.messageId === null) return post;
  if (
    post.messageId !== input.triggerMessageId ||
    (post.threadRootId ?? post.messageId) !== input.source.threadRootId ||
    !post.targetBindings.some(
      (target) =>
        target.ownerUserId === author.teamUserId &&
        target.handle === author.handle &&
        target.requestId === payload.originAskId,
    )
  )
    return null;
  return post;
}
