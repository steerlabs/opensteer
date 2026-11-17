import {
  createId,
  type DeploymentId,
  type TeamActor,
  type TeamAgentRequestId,
  type TeamAskOutcome,
  type TeamMessageId,
  type UserId,
} from "@opensteer/core";
import {
  TeamShareAskStatusSchema,
  type TeamShareAskStatus,
  type TeamShareRow,
} from "@opensteer/protocol";
import { sql, type Selectable, type Transaction } from "kysely";
import type { DatabaseSchema, TeamMessageTable, TeamShareTable } from "./schema.js";
import type { TeamAccessStore } from "./team-access-store.js";
import { appendTeamAudit } from "./team-audit-store.js";
import { createTeamAskReturn } from "./team-request-returns.js";

type Tx = Transaction<DatabaseSchema>;
type Message = Selectable<TeamMessageTable>;

export async function teamAskerChannels(
  t: Tx,
  access: TeamAccessStore,
  actor: TeamActor,
  channelIds: readonly Message["channelId"][],
) {
  const principal = await t
    .selectFrom("teamPrincipals")
    .select("memberUserId")
    .where("id", "=", actor.userId)
    .executeTakeFirst();
  if (principal?.memberUserId) {
    const rights = await access.channels(t, actor, channelIds);
    return new Set(channelIds.filter((id) => rights.get(id)?.read && rights.get(id)?.post));
  }
  const rows = await t
    .selectFrom("teamShareParticipants as p")
    .innerJoin("teamShares as s", "s.id", "p.shareId")
    .innerJoin("teamPartnerLinks as l", "l.id", "s.partnerLinkId")
    .innerJoin("teamChannels as c", "c.id", "s.channelId")
    .select("s.channelId")
    .where("s.channelId", "in", [...channelIds])
    .where("s.state", "=", "active")
    .where("l.state", "=", "active")
    .where("c.archivedAt", "is", null)
    .where("p.principalId", "=", actor.userId)
    .where("p.state", "=", "active")
    .where("p.blocked", "=", false)
    .where("p.level", "=", "post")
    .where((eb) =>
      eb.exists(
        eb.selectFrom("teamSharingSettings").select("singletonKey").where("policy", "!=", "off"),
      ),
    )
    .where((eb) =>
      actor.kind === "human"
        ? eb.val(true)
        : eb.and([
            eb("c.peopleOnly", "=", false),
            eb("s.agentsEnabled", "=", true),
            eb.or([eb("s.role", "=", "owner"), eb("s.peopleOnly", "=", false)]),
          ]),
    )
    .execute();
  return new Set(rows.map((row) => row.channelId!));
}

export async function teamAskerCanPost(
  t: Tx,
  access: TeamAccessStore,
  actor: TeamActor,
  channelId: Message["channelId"],
) {
  return (await teamAskerChannels(t, access, actor, [channelId])).has(channelId);
}

export async function recordSharedAsks(
  t: Tx,
  share: Selectable<TeamShareTable>,
  row: Message,
  mentions: readonly { kind: string; userId: UserId }[],
  ownTeamId: DeploymentId,
) {
  const targets = mentions
    .filter((m) => m.kind === "agent" && m.userId !== row.authorUserId)
    .map((m) => m.userId);
  if (!targets.length) return;
  const people = await t
    .selectFrom("teamShareParticipants as a")
    .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
    .select(["p.id", "p.homeTeamId", "a.handle"])
    .where("a.shareId", "=", share.id)
    .where("p.id", "in", [...targets, row.authorUserId])
    .execute();
  const author = people.find((p) => p.id === row.authorUserId);
  const foreign = people.filter(
    (p) =>
      targets.includes(p.id) && (p.homeTeamId !== ownTeamId || author?.homeTeamId !== ownTeamId),
  );
  if (!foreign.length) return;
  const inbound = await t
    .selectFrom("teamShareAsks")
    .select((e) => e.fn.countAll<string>().as("count"))
    .where("shareId", "=", share.id)
    .where("createdAt", ">", new Date(Date.now() - 60000))
    .executeTakeFirstOrThrow();
  for (const [index, target] of foreign.entries()) {
    const limited = Number(inbound.count) + index >= 60;
    await t
      .insertInto("teamShareAsks")
      .values({
        id: createId("teamAgentRequest"),
        shareId: share.id,
        channelId: row.channelId,
        triggerMessageId: row.id,
        threadRootId: row.threadRootId ?? row.id,
        targetPrincipalId: target.id,
        targetAgentHandle: target.handle,
        localRequestId: null,
        status: limited
          ? { ...failedSharedAsk(row.changeSeq, "execution_failed"), refusal: "rate-limited" }
          : null,
        outcome: limited ? "failed" : null,
        replyMessageId: null,
        createdAt: new Date(),
        changeSeq: row.changeSeq,
      })
      .onConflict((c) =>
        c.columns(["shareId", "triggerMessageId", "targetPrincipalId"]).doNothing(),
      )
      .execute();
  }
}

export function failedSharedAsk(
  revision: string,
  failureCode: TeamShareAskStatus["failureCode"] = "access_revoked",
): TeamShareAskStatus {
  return TeamShareAskStatusSchema.parse({
    revision,
    state: failureCode === "expired" || failureCode === "execution_failed" ? "failed" : "cancelled",
    consentExpiresAt: null,
    acceptedAt: null,
    expiresAt: null,
    finishedAt: new Date().toISOString(),
    failureCode,
    outcome:
      failureCode === "expired"
        ? "expired"
        : failureCode === "execution_failed"
          ? "failed"
          : "cancelled",
    replyPublicId: null,
  });
}

export async function sharedAskOutcomes(
  t: Tx,
  messageId: TeamMessageId,
): Promise<TeamAskOutcome[]> {
  const refs = await t
    .selectFrom("teamShareAsks")
    .selectAll()
    .where("triggerMessageId", "=", messageId)
    .where("localRequestId", "is", null)
    .execute();
  return refs.map((ref) => ({
    ownerUserId: ref.targetPrincipalId,
    handle: ref.targetAgentHandle as TeamAskOutcome["handle"],
    requestId: ref.id,
    outcome: "queued",
  }));
}

export async function sharedAskStates(
  t: Tx,
  shareId: string,
  messageIds?: readonly TeamMessageId[],
) {
  let query = t
    .selectFrom("teamShareAsks as a")
    .innerJoin("teamPrincipals as p", "p.id", "a.targetPrincipalId")
    .innerJoin("teamMessages as m", "m.id", "a.triggerMessageId")
    .leftJoin("teamAgentRequests as r", "r.id", "a.localRequestId")
    .leftJoin("teamMessages as reply", "reply.id", "r.replyMessageId")
    .selectAll("a")
    .select([
      "p.homeTeamId",
      "p.homeUserId",
      "p.memberUserId",
      "m.publicId as triggerPublicId",
      "r.state",
      "r.consentExpiresAt",
      "r.acceptedAt",
      "r.expiresAt",
      "r.finishedAt",
      "r.failureCode",
      "r.changeSeq as requestChangeSeq",
      "reply.publicId as replyPublicId",
    ])
    .where("a.shareId", "=", shareId);
  if (messageIds) {
    if (!messageIds.length) return [];
    query = query.where("a.triggerMessageId", "in", [...messageIds]);
  }
  return (await query.orderBy("a.id").execute()).map((ref) => ({
    ...ref,
    status: ref.localRequestId
      ? TeamShareAskStatusSchema.parse({
          revision: ref.requestChangeSeq,
          state: ref.state,
          consentExpiresAt: ref.consentExpiresAt?.toISOString() ?? null,
          acceptedAt: ref.acceptedAt?.toISOString() ?? null,
          expiresAt: ref.expiresAt?.toISOString() ?? null,
          finishedAt: ref.finishedAt?.toISOString() ?? null,
          failureCode: ref.failureCode,
          outcome: ref.outcome,
          replyPublicId: ref.replyPublicId,
        })
      : ref.status,
  }));
}

export async function exportSharedAsks(
  t: Tx,
  shareId: string,
  messageIds: readonly TeamMessageId[],
) {
  const refs = await sharedAskStates(t, shareId, messageIds);
  return (id: TeamMessageId) =>
    refs
      .filter((a) => a.triggerMessageId === id)
      .map((a) => ({
        target: { teamId: a.homeTeamId, userId: a.homeUserId as UserId },
        status: a.status,
      }));
}

export async function applySharedAskStatus(
  t: Tx,
  refId: TeamAgentRequestId,
  status: TeamShareAskStatus,
  changeSeq: string,
  localCancellation = false,
) {
  const ref = await t
    .selectFrom("teamShareAsks")
    .selectAll()
    .where("id", "=", refId)
    .executeTakeFirstOrThrow();
  if (
    ref.localRequestId ||
    (ref.outcome && !(ref.outcome === "answered" && status.outcome === "answered")) ||
    (!localCancellation && ref.status && BigInt(ref.status.revision) >= BigInt(status.revision))
  )
    return false;
  return completeSharedAskStatus(t, ref, status, changeSeq);
}

async function completeSharedAskStatus(
  t: Tx,
  ref: Selectable<DatabaseSchema["teamShareAsks"]>,
  status: TeamShareAskStatus,
  changeSeq: string,
) {
  const reply = status.replyPublicId
    ? await t
        .selectFrom("teamMessages")
        .selectAll()
        .where("channelId", "=", ref.channelId)
        .where("publicId", "=", status.replyPublicId)
        .where("authorUserId", "=", ref.targetPrincipalId)
        .where("authorKind", "=", "agent")
        .where("threadRootId", "=", ref.threadRootId)
        .where("deletedAt", "is", null)
        .executeTakeFirst()
    : null;
  if (status.replyPublicId && !reply) {
    if (ref.outcome) return false;
    await t
      .updateTable("teamShareAsks")
      .set({ status, changeSeq })
      .where("id", "=", ref.id)
      .execute();
    return true;
  }
  await t
    .updateTable("teamShareAsks")
    .set({ status, outcome: status.outcome, replyMessageId: reply?.id ?? null, changeSeq })
    .where("id", "=", ref.id)
    .execute();
  if (status.outcome)
    await createTeamAskReturn(
      t,
      {
        id: ref.id,
        kind: "ask",
        ownerUserId: ref.targetPrincipalId,
        targetAgentHandle: ref.targetAgentHandle,
        channelId: ref.channelId,
        threadRootId: ref.threadRootId,
        triggerMessageId: ref.triggerMessageId,
        replyMessageId: null,
      },
      status.outcome,
      changeSeq,
      reply?.id,
    );
  return true;
}

export async function cancelSharedAsks(
  t: Tx,
  messageIds: readonly TeamMessageId[],
  changeSeq: string,
  failure: TeamShareAskStatus["failureCode"],
) {
  if (!messageIds.length) return;
  const refs = await t
    .selectFrom("teamShareAsks")
    .selectAll()
    .where("triggerMessageId", "in", [...messageIds])
    .where("outcome", "is", null)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  for (const ref of refs)
    await applySharedAskStatus(t, ref.id, failedSharedAsk(changeSeq, failure), changeSeq, true);
}

export async function completeSharedAskReplies(
  t: Tx,
  shareId: string,
  publicIds: readonly string[],
  changeSeq: string,
) {
  const pending = await t
    .selectFrom("teamShareAsks")
    .selectAll()
    .where("shareId", "=", shareId)
    .where("localRequestId", "is", null)
    .where("outcome", "is", null)
    .where(sql<string>`status->>'replyPublicId'`, "in", [...publicIds])
    .orderBy("id")
    .execute();
  for (const ref of pending) await completeSharedAskStatus(t, ref, ref.status!, changeSeq);
}

export async function importSharedAsks(
  t: Tx,
  chat: import("./team-chat-store.js").TeamChatStore,
  share: Selectable<TeamShareTable>,
  rows: readonly {
    row: TeamShareRow;
    id: TeamMessageId;
    principalId: UserId;
    fresh: boolean;
    proof?: Selectable<DatabaseSchema["teamShareRelays"]> | undefined;
  }[],
  changeSeq: string,
) {
  if (!rows.some((item) => item.row.asks?.length)) return;
  const participants = await t
    .selectFrom("teamShareParticipants as a")
    .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
    .select(["p.id", "p.homeTeamId", "p.homeUserId", "p.memberUserId", "a.handle"])
    .where("a.shareId", "=", share.id)
    .execute();
  const all = await t
    .selectFrom("teamMessages")
    .selectAll()
    .where(
      "id",
      "in",
      rows.map((r) => r.id),
    )
    .execute();
  const mentions = await t
    .selectFrom("teamMentions")
    .select(["messageId", "targetUserId"])
    .where(
      "messageId",
      "in",
      rows.map((r) => r.id),
    )
    .where("targetKind", "=", "agent")
    .execute();
  const references = await t
    .selectFrom("teamShareAsks")
    .selectAll()
    .where("shareId", "=", share.id)
    .where(
      "triggerMessageId",
      "in",
      rows.map((r) => r.id),
    )
    .execute();
  const admissions: { message: Message; targets: UserId[] }[] = [];
  const statuses: { id: TeamAgentRequestId; status: TeamShareAskStatus }[] = [];
  for (const item of rows) {
    const message = all.find((m) => m.id === item.id)!;
    const targets = mentions.filter((m) => m.messageId === message.id).map((m) => m.targetUserId);
    const localTargets: UserId[] = [];
    for (const ask of item.row.asks ?? []) {
      const target = participants.find(
        (p) => p.homeTeamId === ask.target.teamId && p.homeUserId === ask.target.userId,
      );
      if (!target || target.id === message.authorUserId)
        throw new Error("Invalid shared ask target");
      if (
        item.row.author.teamId === chat.identity.teamId &&
        !item.proof?.agentTargets.includes(target.id)
      )
        continue;
      let ref = references.find(
        (a) => a.triggerMessageId === message.id && a.targetPrincipalId === target.id,
      );
      if (!ref) {
        if (!item.fresh || message.deletedAt || message.editedAt || !targets.includes(target.id))
          continue;
        ref = await t
          .insertInto("teamShareAsks")
          .values({
            id: createId("teamAgentRequest"),
            shareId: share.id,
            channelId: message.channelId,
            triggerMessageId: message.id,
            threadRootId: message.threadRootId ?? message.id,
            targetPrincipalId: target.id,
            targetAgentHandle: target.handle,
            localRequestId: null,
            status: null,
            outcome: null,
            replyMessageId: null,
            createdAt: new Date(),
            changeSeq,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (
          target.memberUserId &&
          message.authorUserId !== target.id &&
          item.row.author.teamId !== chat.identity.teamId
        ) {
          if (share.ready && new Date(item.row.createdAt).getTime() > Date.now() - 7 * 86400000)
            localTargets.push(target.id);
          else statuses.push({ id: ref.id, status: failedSharedAsk(changeSeq, "expired") });
        }
      }
      if (!target.memberUserId && ask.status) statuses.push({ id: ref.id, status: ask.status });
    }
    if (localTargets.length) admissions.push({ message, targets: localTargets });
  }
  for (const { message, targets } of admissions) {
    const result = await chat.admitRequests(
      t,
      { kind: message.authorKind, userId: message.authorUserId },
      message,
      targets.map((userId) => ({ kind: "agent", userId })),
      { self: false, shareId: share.id },
    );
    for (const outcome of result.outcomes)
      await appendTeamAudit(t, {
        actor: null,
        action: "request.create",
        resourceKind: "message",
        resourceId: message.id,
        channelId: message.channelId,
        outcome: outcome.outcome === "queued" ? "allowed" : "denied",
        metadata: outcome,
      });
  }
  for (const status of statuses) await applySharedAskStatus(t, status.id, status.status, changeSeq);
}

export async function cancelUnavailableSharedAsks(t: Tx, access: TeamAccessStore) {
  const refs = await t
    .selectFrom("teamShareAsks as a")
    .innerJoin("teamShares as s", "s.id", "a.shareId")
    .innerJoin("teamPartnerLinks as l", "l.id", "s.partnerLinkId")
    .innerJoin("teamMessages as m", "m.id", "a.triggerMessageId")
    .selectAll("a")
    .select(["s.state as shareState", "l.state as linkState", "m.authorKind", "m.authorUserId"])
    .where("a.outcome", "is", null)
    .orderBy("a.id")
    .execute();
  const channels = new Set<Message["channelId"]>();
  for (const ref of refs) {
    if (
      ref.shareState === "active" &&
      ref.linkState === "active" &&
      (await teamAskerCanPost(
        t,
        access,
        { kind: ref.authorKind, userId: ref.authorUserId },
        ref.channelId,
      )) &&
      (await teamAskerCanPost(
        t,
        access,
        { kind: "agent", userId: ref.targetPrincipalId },
        ref.channelId,
      ))
    )
      continue;
    const channel = await t
      .updateTable("teamChannels")
      .set({ changeSeq: sql`change_seq+1`, updatedAt: new Date() })
      .where("id", "=", ref.channelId)
      .returning("changeSeq")
      .executeTakeFirstOrThrow();
    await applySharedAskStatus(
      t,
      ref.id,
      failedSharedAsk(channel.changeSeq),
      channel.changeSeq,
      true,
    );
    await t
      .updateTable("teamMessages")
      .set({ changeSeq: channel.changeSeq })
      .where("id", "in", [ref.triggerMessageId, ref.threadRootId])
      .execute();
    channels.add(ref.channelId);
  }
  return channels;
}

export async function expireSharedAsks(access: TeamAccessStore) {
  const expired = await access.database
    .selectFrom("teamShareAsks as a")
    .innerJoin("teamMessages as m", "m.id", "a.triggerMessageId")
    .selectAll("a")
    .select(["m.authorUserId", "m.authorKind"])
    .where("a.status", "is", null)
    .where("a.localRequestId", "is", null)
    .where("a.createdAt", "<=", new Date(Date.now() - 7 * 86400000))
    .orderBy("a.id")
    .execute();
  const channels = new Set<Message["channelId"]>();
  for (const ref of expired)
    await access.contentWrite(
      { kind: ref.authorKind, userId: ref.authorUserId },
      ref.channelId,
      async (t) => {
        await t
          .selectFrom("teamMessages")
          .select("id")
          .where("id", "in", [ref.triggerMessageId, ref.threadRootId])
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        const channel = await t
          .updateTable("teamChannels")
          .set({ changeSeq: sql`change_seq+1`, updatedAt: new Date() })
          .where("id", "=", ref.channelId)
          .returning("changeSeq")
          .executeTakeFirstOrThrow();
        if (
          await applySharedAskStatus(
            t,
            ref.id,
            failedSharedAsk(channel.changeSeq, "expired"),
            channel.changeSeq,
          )
        ) {
          await t
            .updateTable("teamMessages")
            .set({ changeSeq: channel.changeSeq })
            .where("id", "in", [ref.triggerMessageId, ref.threadRootId])
            .execute();
          channels.add(ref.channelId);
        }
      },
    );
  return channels;
}
