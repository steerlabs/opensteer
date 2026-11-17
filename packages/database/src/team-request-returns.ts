import { createId, type TeamAgentReturnOutcome, type TeamMessageId } from "@opensteer/core";
import { sql, type Selectable, type Transaction } from "kysely";
import type { DatabaseSchema, TeamAgentRequestTable } from "./schema.js";
import { appendTeamAudit } from "./team-audit-store.js";
import { teamPrincipalProfiles } from "./team-principals-store.js";

export async function teamAttachmentRefs(
  transaction: Transaction<DatabaseSchema>,
  messageId: TeamMessageId,
) {
  const refs = await transaction
    .selectFrom("teamMessageAttachments as a")
    .innerJoin("teamBlobs as b", "b.id", "a.blobId")
    .select(["b.id", "b.filename", "b.verifiedType as mediaType", "b.sizeBytes"])
    .where("a.messageId", "=", messageId)
    .orderBy("a.position")
    .execute();
  return refs.map((ref) => ({
    ...ref,
    sizeBytes: Number(ref.sizeBytes),
    mediaType: ref.mediaType ?? "application/octet-stream",
  }));
}

export async function createTeamAskReturn(
  transaction: Transaction<DatabaseSchema>,
  ask: Pick<
    Selectable<TeamAgentRequestTable>,
    | "id"
    | "kind"
    | "ownerUserId"
    | "targetAgentHandle"
    | "channelId"
    | "threadRootId"
    | "triggerMessageId"
    | "replyMessageId"
  >,
  outcome: TeamAgentReturnOutcome,
  changeSeq: string,
  replyMessageId?: TeamMessageId,
) {
  if (ask.kind !== "ask" || (ask.replyMessageId && !replyMessageId)) return;
  await transaction
    .updateTable("teamShareAsks")
    .set({ outcome })
    .where("localRequestId", "=", ask.id)
    .where("outcome", "is", null)
    .execute();
  const trigger = await transaction
    .selectFrom("teamMessages")
    .selectAll()
    .where("id", "=", ask.triggerMessageId)
    .executeTakeFirstOrThrow();
  if (
    trigger.authorKind !== "agent" ||
    !trigger.agentLinkId ||
    !trigger.personalDeploymentId ||
    !trigger.callerRunId
  )
    return;
  const link = await transaction
    .selectFrom("teamLinks as l")
    .innerJoin("teamMembers as m", "m.userId", "l.ownerUserId")
    .select(["l.id", "l.state", "m.state as memberState"])
    .where("l.id", "=", trigger.agentLinkId)
    .where("l.personalDeploymentId", "=", trigger.personalDeploymentId)
    .where("l.ownerUserId", "=", trigger.authorUserId)
    .executeTakeFirst();
  if (!link) return;
  const answer = replyMessageId
    ? await transaction
        .selectFrom("teamMessages")
        .select("bodyMarkdown")
        .where("id", "=", replyMessageId)
        .executeTakeFirstOrThrow()
    : null;
  const owner = await teamPrincipalProfiles(transaction)
    .where("p.id", "=", ask.ownerUserId)
    .executeTakeFirstOrThrow();
  const payload = {
    author: {
      teamUserId: ask.ownerUserId,
      displayName: owner.displayName,
      handle: ask.targetAgentHandle ?? owner.handle,
      actor: "agent" as const,
    },
    originAskId: ask.id,
    triggerClientMessageId: trigger.clientMessageId,
    resumeRunId: trigger.callerRunId,
    outcome,
    bodyMarkdown: answer?.bodyMarkdown ?? null,
    attachments: replyMessageId ? await teamAttachmentRefs(transaction, replyMessageId) : [],
  };
  const created = await transaction
    .insertInto("teamAgentRequests")
    .values({
      id: createId("teamAgentRequest"),
      kind: "return",
      ownerUserId: trigger.authorUserId,
      channelId: ask.channelId,
      threadRootId: ask.threadRootId,
      triggerMessageId: ask.triggerMessageId,
      linkId: link.id,
      state: link.state === "active" && link.memberState === "active" ? "queued" : "cancelled",
      steps: sql`'[]'::jsonb`,
      returnPayload: payload,
      createdAt: new Date(),
      acceptedAt: null,
      expiresAt: null,
      finishedAt: link.state === "active" && link.memberState === "active" ? null : new Date(),
      replyMessageId: null,
      failureCode: null,
      changeSeq,
    })
    .onConflict((c) => c.doNothing())
    .returning(["id", "linkId"])
    .executeTakeFirst();
  if (created)
    await appendTeamAudit(transaction, {
      actor: null,
      action: "request.return.create",
      resourceKind: "request",
      resourceId: created.id,
      requestId: created.id,
      linkId: created.linkId,
      channelId: ask.channelId,
      metadata: { originAskId: ask.id, outcome },
    });
  return created;
}
