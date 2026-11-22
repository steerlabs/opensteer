import { randomInt, randomUUID } from "node:crypto";
import {
  ChannelAccountIdSchema,
  NormalizedChannelEventSchema,
  createChannelId,
  type ChannelConversationId,
  type ChannelIngressId,
  type NormalizedChannelEvent,
} from "@opensteer/channel-core";
import { sha256Base64Url } from "@opensteer/core/crypto";
import { OpensteerError, type ThreadId, type UserId } from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import { channelSourceAllows, enqueueChannelConversationStatus } from "./channel-deliveries.js";
import { admitBridgeSender } from "./bridge-admission.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import type { DatabaseSchema } from "./schema.js";
import { upsertChannelIdentity } from "./channel-store.js";

/** What the Home does with one message a chat delivered. */
export type BridgeIngressDecision =
  | { readonly kind: "ignored"; readonly reason: string }
  /** Its chat is paused: the message goes back to waiting, untouched, until the chat is back. */
  | { readonly kind: "waiting" }
  /** The person sent the code Opensteer showed them: their account is "me" now. Nothing is said. */
  | { readonly kind: "linked" }
  | {
      readonly kind: "work";
      readonly action: "create" | "send" | "interrupt";
      readonly bridgeId: string;
      readonly ownerUserId: UserId;
      /** The revision the message was admitted under; a change of who may speak raises it. */
      readonly grantRevision: number;
      readonly conversationId: ChannelConversationId;
      readonly taskId: ThreadId | null;
      readonly sender: { readonly displayName: string; readonly externalUserId: string };
      readonly text: string;
    };

const linkCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const linkCodeLifetimeMs = 60 * 60 * 1_000;
/** Interrupting from the chat only ever reduces what happens, so it is the one word honoured. */
const stopWord = /^stop[.!]?$/iu;

function digest(value: string): string {
  return sha256Base64Url(value);
}

function normalizedCode(text: string): string | null {
  const code = text.trim().toUpperCase().replaceAll(/[\s-]/gu, "");
  return /^[A-HJ-NP-Z2-9]{8}$/u.test(code) ? code : null;
}

/** The plain text of a chat message; anything else it carried is named, never forwarded. */
export function chatMessageText(event: NormalizedChannelEvent): string {
  const parts = event.content.map((part) =>
    part.type === "text" ? part.text : `[${part.type} not forwarded from the chat]`,
  );
  return parts.join("\n").trim();
}

/**
 * Show the person a code to send from their own account to the bot: the account that sends it
 * becomes "me" for every bridge on that account. A new code replaces any earlier unused one.
 */
export async function startBridgeOwnerLink(
  database: Kysely<DatabaseSchema>,
  input: { readonly userId: UserId; readonly accountId: string },
): Promise<{ readonly code: string; readonly expiresAt: Date }> {
  const accountId = ChannelAccountIdSchema.parse(input.accountId);
  return commitPersonalMutation(database, async (tx) => {
    await requirePersonalOwner(tx, input.userId);
    const account = await tx
      .selectFrom("channelAccounts")
      .innerJoin(
        "integrationConnections",
        "integrationConnections.id",
        "channelAccounts.connectionId",
      )
      .select("channelAccounts.id")
      .where("channelAccounts.id", "=", accountId)
      .where("integrationConnections.ownerUserId", "=", input.userId)
      .where("channelAccounts.status", "!=", "revoked")
      .executeTakeFirst();
    if (!account)
      throw new OpensteerError({
        code: "not_found",
        message: "That messaging account is no longer connected.",
      });
    await tx
      .deleteFrom("bridgeLinkCodes")
      .where("accountId", "=", accountId)
      .where("consumedAt", "is", null)
      .execute();
    const code = Array.from(
      { length: 8 },
      () => linkCodeAlphabet[randomInt(linkCodeAlphabet.length)],
    ).join("");
    const expiresAt = new Date(Date.now() + linkCodeLifetimeMs);
    await tx
      .insertInto("bridgeLinkCodes")
      .values({
        id: `blc_${randomUUID()}`,
        accountId,
        userId: input.userId,
        codeHash: digest(code),
        expiresAt,
      })
      .execute();
    return { code, expiresAt };
  });
}

/** Who on this account is "me", as the person linked it; null until they send a code. */
export async function bridgeOwnerIdentity(
  database: Kysely<DatabaseSchema>,
  input: { readonly userId: UserId; readonly accountId: string },
): Promise<{ readonly displayName: string; readonly externalUserId: string } | null> {
  const row = await database
    .selectFrom("channelIdentities")
    .select(["displayName", "externalUserId"])
    .where("accountId", "=", ChannelAccountIdSchema.parse(input.accountId))
    .where("linkedUserId", "=", input.userId)
    .where("status", "=", "linked")
    .orderBy("updatedAt", "desc")
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Decide one leased chat message, in one transaction: a code the person sent to link "me"; else
 * the bridge covering its conversation, read live with its sender rule in the same statement;
 * then whether its sender may speak, and the conversation's task. Anything not admitted ends
 * here, silently: a stranger never learns the bot exists, and nobody is asked anything in chat.
 */
export async function decideBridgeIngress(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ingressId: ChannelIngressId;
    readonly claimToken: string;
    /** Why it is too old to act on, when it is: nothing runs, and an admitted sender is told. */
    readonly stale?: string;
  },
): Promise<BridgeIngressDecision> {
  return commitPersonalMutation(database, async (tx) => {
    const ingress = await tx
      .selectFrom("channelIngressEvents")
      .selectAll()
      .where("id", "=", input.ingressId)
      .where("status", "=", "leased")
      .where("claimTokenHash", "=", digest(input.claimToken))
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!ingress)
      throw new OpensteerError({ code: "conflict", message: "Channel ingress claim is stale" });
    const ignore = async (reason: string): Promise<BridgeIngressDecision> => {
      await finishIngress(tx, ingress.id, "ignored", reason);
      return { kind: "ignored", reason };
    };
    const parsed = NormalizedChannelEventSchema.safeParse(ingress.event);
    if (!parsed.success) return ignore("The message could not be read");
    const event = parsed.data;
    if (!(await channelSourceAllows(tx, ingress.accountId, false)))
      return ignore("The computer's app connection no longer allows this channel");
    const text = chatMessageText(event);

    // A code the person sent from their own account, in a direct message, while it is fresh.
    const code = event.conversation.type === "dm" && !input.stale ? normalizedCode(text) : null;
    if (code) {
      const linked = await redeemLinkCode(tx, ingress.accountId, code, event);
      if (linked) {
        await finishIngress(tx, ingress.id, "ignored", "Linked the person's own account");
        return { kind: "linked" };
      }
    }

    const admitted = await admitChatMessage(tx, ingress.accountId, event);
    if (admitted.kind === "waiting") {
      // Not taken: its attempt is given back, and it is decided when the chat is back.
      await tx
        .updateTable("channelIngressEvents")
        .set({
          attempts: sql<number>`greatest(attempts - 1, 0)`,
          claimExpiresAt: null,
          claimOwner: null,
          claimTokenHash: null,
          status: "pending",
          updatedAt: new Date(),
        })
        .where("id", "=", ingress.id)
        .executeTakeFirstOrThrow();
      return { kind: "waiting" };
    }
    if (admitted.kind === "refused") return ignore(admitted.reason);
    const { bridge, conversation } = admitted;
    // Too old to act on: the person who may speak hears that, and may send it again.
    if (input.stale) {
      await enqueueChannelConversationStatus(tx, {
        conversationId: conversation.id,
        text: chatNotices.late,
      });
      return ignore(input.stale);
    }
    const task = conversation.threadId
      ? await tx
          .selectFrom("threads")
          .select(["id", "doneAt", "status", "removedAt", "originConnectionId"])
          .where("id", "=", conversation.threadId)
          .executeTakeFirst()
      : undefined;
    const open =
      task !== undefined &&
      task.doneAt === null &&
      task.removedAt === null &&
      task.status !== "archived" &&
      task.originConnectionId === bridge.id;
    const stop = stopWord.test(text);
    if (stop && !open) return ignore("Nothing is running here to stop");
    if (!stop && !text) return ignore("The message had nothing to send");
    return {
      kind: "work",
      action: stop ? "interrupt" : open ? "send" : "create",
      bridgeId: bridge.id,
      ownerUserId: bridge.userId,
      grantRevision: bridge.grantRevision,
      conversationId: conversation.id,
      taskId: open ? task.id : null,
      sender: { displayName: event.actor.displayName, externalUserId: event.actor.externalUserId },
      text,
    };
  });
}

/**
 * The two lines a sender who may speak is told when their message starts nothing. Neither says
 * why, so nothing about the Home leaves in them; anyone who may not speak is told nothing.
 */
export const chatNotices = {
  late: "This message arrived too late to act on. Send it again if you still need it.",
  notStarted: "Opensteer couldn't start this. Open Opensteer to see why.",
} as const;

type ChatAdmission =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "waiting" }
  | {
      readonly kind: "admitted";
      readonly bridge: {
        readonly id: string;
        readonly userId: UserId;
        readonly grantRevision: number;
      };
      readonly owner: boolean;
      readonly conversation: {
        readonly id: ChannelConversationId;
        readonly threadId: ThreadId | null;
      };
    };

/**
 * May this message be spoken to the bridge that covers its conversation: the bridge read live
 * with its sender rule in one statement, then the sender, then the conversation (made on its
 * first addressed message). The one question every answer in a chat is asked behind.
 */
async function admitChatMessage(
  tx: Transaction<DatabaseSchema>,
  accountId: ReturnType<typeof ChannelAccountIdSchema.parse>,
  event: NormalizedChannelEvent,
): Promise<ChatAdmission> {
  const covered =
    event.conversation.type === "dm" ? null : event.conversation.externalConversationId;
  // Which bridge covers it is a lookup; whether it is live and the sender may speak is the
  // one bridge admission.
  const candidate = await tx
    .selectFrom("agentConnections")
    .select(["id", "userId"])
    .where("bridgeAccountId", "=", accountId)
    .$call((query) =>
      covered === null
        ? query.where("bridgeConversationId", "is", null)
        : query.where("bridgeConversationId", "=", covered),
    )
    .where("revokedAt", "is", null)
    .executeTakeFirst();
  if (!candidate) return { kind: "refused", reason: "No bridge covers this conversation" };
  const admission = await admitBridgeSender(tx, {
    ownerUserId: candidate.userId,
    bridgeId: candidate.id,
    externalUserId: event.actor.externalUserId,
    lock: true,
  });
  if (admission.kind !== "admitted") return admission;
  const owner = admission.owner;
  const bridge = {
    id: admission.connection.agentConnectionId,
    userId: candidate.userId,
    grantRevision: admission.connection.grantRevision,
  };
  const keys = {
    bridgeId: bridge.id,
    externalScopeId: event.conversation.externalScopeId,
    externalConversationId: event.conversation.externalConversationId,
    externalThreadId: event.conversation.externalThreadId,
  };
  const existing = await tx
    .selectFrom("bridgeConversations")
    .select(["id", "threadId"])
    .where("bridgeId", "=", keys.bridgeId)
    .where(sql<boolean>`external_scope_id is not distinct from ${keys.externalScopeId}`)
    .where("externalConversationId", "=", keys.externalConversationId)
    .where(sql<boolean>`external_thread_id is not distinct from ${keys.externalThreadId}`)
    .forNoKeyUpdate()
    .executeTakeFirst();
  // Chatter nobody addressed to the bot starts nothing, and hears nothing.
  if (!existing && event.trigger === "conversation-followup")
    return { kind: "refused", reason: "The message was not addressed to the bot" };
  const conversation =
    existing ??
    (await tx
      .insertInto("bridgeConversations")
      .values({
        id: createChannelId("conversation"),
        ...keys,
        accountId,
        conversationType: event.conversation.type,
        displayName: event.conversation.displayName,
        threadId: null,
      })
      .returning(["id", "threadId"])
      .executeTakeFirstOrThrow());
  return { kind: "admitted", bridge, owner, conversation };
}

/**
 * A message admitted as its bridge whose task tools refused it: it ends here, and in the same
 * transaction its conversation hears the one line, as a chat attempt of the live bridge.
 */
export async function declineBridgeIngress(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ingressId: ChannelIngressId;
    readonly claimToken: string;
    readonly conversationId: ChannelConversationId;
    readonly reason: string;
  },
): Promise<void> {
  await commitPersonalMutation(database, async (tx) => {
    const ingress = await tx
      .selectFrom("channelIngressEvents")
      .select("id")
      .where("id", "=", input.ingressId)
      .where("status", "=", "leased")
      .where("claimTokenHash", "=", digest(input.claimToken))
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!ingress)
      throw new OpensteerError({ code: "conflict", message: "Channel ingress claim is stale" });
    await finishIngress(tx, ingress.id, "ignored", input.reason);
    await enqueueChannelConversationStatus(tx, {
      conversationId: input.conversationId,
      text: chatNotices.notStarted,
    });
  });
}

/**
 * A message that ran out of attempts: its sender, if they may speak to the bridge covering it,
 * hears the one line. Called in the transaction that marks it dead.
 */
export async function noticeDeadChatMessage(
  tx: Transaction<DatabaseSchema>,
  row: {
    readonly accountId: ReturnType<typeof ChannelAccountIdSchema.parse>;
    readonly event: unknown;
  },
): Promise<void> {
  const parsed = NormalizedChannelEventSchema.safeParse(row.event);
  if (!parsed.success) return;
  const admitted = await admitChatMessage(tx, row.accountId, parsed.data);
  if (admitted.kind !== "admitted") return;
  await enqueueChannelConversationStatus(tx, {
    conversationId: admitted.conversation.id,
    text: chatNotices.notStarted,
  });
}

/** The task the tools answered with is the conversation's from now on; the message is done. */
export async function recordBridgeIngress(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ingressId: ChannelIngressId;
    readonly claimToken: string;
    readonly conversationId: ChannelConversationId;
    readonly taskId: ThreadId;
  },
): Promise<void> {
  await commitPersonalMutation(database, async (tx) => {
    const ingress = await tx
      .selectFrom("channelIngressEvents")
      .select("id")
      .where("id", "=", input.ingressId)
      .where("status", "=", "leased")
      .where("claimTokenHash", "=", digest(input.claimToken))
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!ingress)
      throw new OpensteerError({ code: "conflict", message: "Channel ingress claim is stale" });
    await tx
      .updateTable("bridgeConversations")
      .set({ threadId: input.taskId, updatedAt: new Date() })
      .where("id", "=", input.conversationId)
      .execute();
    await finishIngress(tx, ingress.id, "adopted", null);
  });
}

async function finishIngress(
  tx: Transaction<DatabaseSchema>,
  id: ChannelIngressId,
  status: "ignored" | "adopted",
  reason: string | null,
): Promise<void> {
  await tx
    .updateTable("channelIngressEvents")
    .set({
      claimExpiresAt: null,
      claimOwner: null,
      claimTokenHash: null,
      lastError: reason?.slice(0, 2_000) ?? null,
      processedAt: new Date(),
      status,
      updatedAt: new Date(),
    })
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

/**
 * Link the account that sent a live code to the person who was shown it. The code is read
 * first, the identity locked next and the code consumed last, in the declared lock order.
 */
async function redeemLinkCode(
  tx: Transaction<DatabaseSchema>,
  accountId: ReturnType<typeof ChannelAccountIdSchema.parse>,
  code: string,
  event: NormalizedChannelEvent,
): Promise<boolean> {
  // Only a connected account links "me": a code that waited while it was paused or removed
  // links nothing.
  const connected = await tx
    .selectFrom("channelAccounts")
    .innerJoin(
      "integrationConnections",
      "integrationConnections.id",
      "channelAccounts.connectionId",
    )
    .select("channelAccounts.id")
    .where("channelAccounts.id", "=", accountId)
    .where("channelAccounts.status", "=", "connected")
    .where("integrationConnections.status", "in", ["pending", "connected", "needs-attention"])
    .executeTakeFirst();
  if (!connected) return false;
  const pending = await tx
    .selectFrom("bridgeLinkCodes")
    .select(["id", "userId"])
    .where("accountId", "=", accountId)
    .where("codeHash", "=", digest(code))
    .where("consumedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  if (!pending) return false;
  // Every identity this touches, in one ordered lock: the sender's and any linked to the person.
  await tx
    .selectFrom("channelIdentities")
    .select("id")
    .where("accountId", "=", accountId)
    .where((eb) =>
      eb.or([
        eb("linkedUserId", "=", pending.userId),
        eb("externalUserId", "=", event.actor.externalUserId),
      ]),
    )
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  const identity = await upsertChannelIdentity(tx, {
    accountId,
    displayName: event.actor.displayName,
    externalUserId: event.actor.externalUserId,
  });
  if (identity.linkedUserId && identity.linkedUserId !== pending.userId) return false;
  // "Me" is one identity on an account at a time: linking this one unlinks any other.
  await tx
    .updateTable("channelIdentities")
    .set({ linkedUserId: null, status: "unlinked", updatedAt: new Date() })
    .where("accountId", "=", accountId)
    .where("linkedUserId", "=", pending.userId)
    .where("id", "!=", identity.id)
    .execute();
  await tx
    .updateTable("channelIdentities")
    .set({ linkedUserId: pending.userId, status: "linked", updatedAt: new Date() })
    .where("id", "=", identity.id)
    .execute();
  const consumed = await tx
    .updateTable("bridgeLinkCodes")
    .set({ consumedAt: new Date(), identityId: identity.id })
    .where("id", "=", pending.id)
    .where("consumedAt", "is", null)
    .executeTakeFirst();
  if (consumed.numUpdatedRows !== 1n)
    throw new OpensteerError({ code: "conflict", message: "Channel ingress claim is stale" });
  return true;
}
