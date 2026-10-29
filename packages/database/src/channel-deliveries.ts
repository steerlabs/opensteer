import { placeContentLabel } from "@opensteer/core";
import {
  ChannelConversationIdSchema,
  NormalizedChannelEventSchema,
  channelProviderCatalog,
  createChannelId,
  splitMessageText,
  type IntegrationConnectionId,
  type ChannelAccountId,
  type ChannelConversationId,
  type ChannelDeliveryId,
  type ChannelIngressId,
} from "@opensteer/channel-core";
import type { ContentPart, MessageId, ThreadId } from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue, type ChannelLinks } from "./store-primitives.js";

/** One delivery a `status` message becomes, addressed by conversation or by ingress. */
export interface ChannelStatusDelivery {
  readonly accountId: ChannelAccountId;
  readonly audience: "conversation" | "actor";
  readonly conversationId: ChannelConversationId | null;
  readonly ingressId: ChannelIngressId | null;
  readonly text: string;
}

/**
 * Inserts one `status` message — every word the system says for itself goes
 * through here, which is why the silence rule lives here and nowhere else.
 * Where anybody who knows the address can write to the bot (`senders:
 * "anyone"`, iMessage), a person the system did not admit is told nothing: a
 * wrong number or a spammer never learns the bot exists, never receives a
 * link code, an approval acknowledgement or a failure notice. Null when that
 * rule kept it back.
 */
export async function insertStatusDelivery(
  transaction: Transaction<DatabaseSchema>,
  input: ChannelStatusDelivery,
): Promise<ChannelDeliveryId | null> {
  if (input.audience === "actor" && !(await speaksToActor(transaction, input))) return null;
  const row = await transaction
    .insertInto("channelDeliveries")
    .values({
      accountId: input.accountId,
      audience: input.audience,
      claimExpiresAt: null,
      claimOwner: null,
      claimTokenHash: null,
      content: jsonValue([{ text: input.text, type: "text" }]),
      conversationId: input.conversationId,
      id: createChannelId("delivery"),
      ingressId: input.ingressId,
      kind: "status",
      lastError: null,
      messageId: null,
      nextAttemptAt: new Date(),
      part: 0,
      partCount: 1,
      receipt: null,
      sentAt: null,
      status: "pending",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Whether an `actor` notice may reach the person whose message it answers:
 * always where only a provider workspace's own members can write, and only to
 * a linked or approved sender where anybody can.
 */
async function speaksToActor(
  transaction: Transaction<DatabaseSchema>,
  input: ChannelStatusDelivery,
): Promise<boolean> {
  const account = await transaction
    .selectFrom("channelAccounts")
    .select("provider")
    .where("id", "=", input.accountId)
    .executeTakeFirst();
  const manifest = channelProviderCatalog.find(({ provider }) => provider === account?.provider);
  if (manifest?.senders !== "anyone") return true;
  if (!input.ingressId) return false;
  const ingress = await transaction
    .selectFrom("channelIngressEvents")
    .select("event")
    .where("id", "=", input.ingressId)
    .executeTakeFirst();
  const author = NormalizedChannelEventSchema.safeParse(ingress?.event);
  if (!author.success) return false;
  const externalUserId = author.data.actor.externalUserId;
  const identity = await transaction
    .selectFrom("channelIdentities")
    .select("linkedUserId")
    .where("accountId", "=", input.accountId)
    .where("externalUserId", "=", externalUserId)
    .executeTakeFirst();
  if (identity?.linkedUserId) return true;
  const approved = await transaction
    .selectFrom("channelAccessGrants")
    .innerJoin("channelBindings", "channelBindings.id", "channelAccessGrants.bindingId")
    .select("channelAccessGrants.bindingId")
    .where("channelAccessGrants.accountId", "=", input.accountId)
    .where("channelAccessGrants.externalUserId", "=", externalUserId)
    .where("channelAccessGrants.status", "=", "approved")
    .where("channelBindings.status", "=", "active")
    .executeTakeFirst();
  return approved !== undefined;
}

/**
 * Whether a channel still has the use it was set up on. A channel whose
 * transport runs on a computer is a use of that computer's app connection —
 * iMessage of the Mac's `apple-messages` at read and write — so it runs only
 * while that connection is live, can still send, and sits on the same
 * computer for the same owner. Any other channel has no source to lose.
 */
export async function channelSourceAllows(
  transaction: Transaction<DatabaseSchema>,
  accountId: ChannelAccountId,
  lock = true,
): Promise<boolean> {
  const channel = await transaction
    .selectFrom("channelAccounts")
    .innerJoin(
      "integrationConnections",
      "integrationConnections.id",
      "channelAccounts.connectionId",
    )
    .select([
      "integrationConnections.id",
      "integrationConnections.ownerUserId",
      "integrationConnections.runnerId",
      "integrationConnections.sourceConnectionId",
      "integrationConnections.transportKind",
    ])
    .where("channelAccounts.id", "=", accountId)
    .executeTakeFirst();
  if (!channel) return false;
  if (lock) {
    // Source and channel are the same table; fence both IDs in the shared order
    // before callers acquire the Account or other channel rows.
    await transaction
      .selectFrom("integrationConnections")
      .select("id")
      .where("id", "in", [
        channel.id,
        ...(channel.sourceConnectionId ? [channel.sourceConnectionId] : []),
      ])
      .orderBy("id", "asc")
      .forShare()
      .execute();
  }
  if (channel.transportKind !== "computer") return true;
  if (channel.sourceConnectionId === null) return false;
  // Admission holds this fence until commit. An unlocked early check must be
  // repeated under the fence before admission. Revocation locks Workspaces,
  // then the source, then the channel; callers needing a Workspace lock it first.
  const source = await transaction
    .selectFrom("integrationConnections")
    .select(["computerAccess", "ownerUserId", "runnerId", "status"])
    .where("id", "=", channel.sourceConnectionId)
    .$if(lock, (query) => query.forShare())
    .executeTakeFirst();
  return (
    source !== undefined &&
    source.status !== "revoked" &&
    source.computerAccess === "read-write" &&
    source.ownerUserId === channel.ownerUserId &&
    source.runnerId === channel.runnerId
  );
}

/**
 * Revokes channel connections with everything that hangs off them: their
 * accounts and routes, the deliveries not yet begun (`dead`: they never
 * reached anybody), and those already begun (`unknown`: they may have).
 */
export async function revokeChannelConnectionsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  connectionIds: readonly IntegrationConnectionId[],
): Promise<void> {
  if (connectionIds.length === 0) return;
  const now = new Date();
  await transaction
    .updateTable("integrationConnections")
    .set({ status: "revoked", statusDetail: null, statusReason: null, updatedAt: now })
    .where("id", "in", connectionIds)
    .where("connectionKind", "=", "channel")
    .execute();
  await transaction
    .selectFrom("channelAccounts")
    .select("id")
    .where("connectionId", "in", connectionIds)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  await transaction
    .updateTable("channelAccounts")
    .set({ status: "revoked", updatedAt: now })
    .where("connectionId", "in", connectionIds)
    .execute();
  const accountIds = transaction
    .selectFrom("channelAccounts")
    .select("id")
    .where("connectionId", "in", connectionIds);
  await transaction
    .selectFrom("channelBindings")
    .select("id")
    .where("accountId", "in", accountIds)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  await transaction
    .updateTable("channelBindings")
    .set({ status: "revoked", updatedAt: now })
    .where("accountId", "in", accountIds)
    .execute();
  await transaction
    .selectFrom("channelDeliveries")
    .select("id")
    .where("accountId", "in", accountIds)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  await transaction
    .updateTable("channelDeliveries")
    .set({
      claimExpiresAt: null,
      claimOwner: null,
      claimTokenHash: null,
      lastError: "Channel connection was revoked before delivery",
      status: "dead",
      updatedAt: now,
    })
    .where("accountId", "in", accountIds)
    .where("status", "in", ["pending", "leased", "retryable-failed"])
    .execute();
  await transaction
    .updateTable("channelDeliveries")
    .set({
      claimExpiresAt: null,
      claimOwner: null,
      claimTokenHash: null,
      lastError: "Channel connection was revoked after delivery began",
      status: "unknown",
      updatedAt: now,
    })
    .where("accountId", "in", accountIds)
    .where("status", "=", "attempt-started")
    .execute();
}

/**
 * Tell a channel conversation that its Run needs a person, failed, or was
 * stopped. The conversation is the reply target the Run carries, so a Run with
 * no channel origin — or one whose conversation is gone — produces nothing.
 */
export async function enqueueChannelConversationStatus(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly conversationId: string; readonly text: string },
): Promise<void> {
  const conversation = await transaction
    .selectFrom("channelConversations")
    .select(["accountId", "id"])
    .where("id", "=", ChannelConversationIdSchema.parse(input.conversationId))
    .executeTakeFirst();
  if (!conversation) return;
  await insertStatusDelivery(transaction, {
    accountId: conversation.accountId,
    audience: "conversation",
    conversationId: conversation.id,
    ingressId: null,
    text: input.text,
  });
}

/**
 * Turn one agent message into the provider messages it has to become. A
 * provider caps how long one message may be, and the cap is the Host's to
 * respect: an adapter that had to split would have to understand Markdown,
 * and every adapter would have to understand it the same way.
 *
 * Artifacts become a line of text naming the file and linking to the Thread,
 * because a channel has nowhere to put a file the Workspace owns and a second
 * delivery channel for them would be a second thing to keep ordered.
 */
export async function enqueueChannelReply(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly content: readonly ContentPart[];
    readonly conversationId: string;
    readonly links: ChannelLinks;
    readonly messageId: MessageId;
    readonly threadId: ThreadId;
  },
): Promise<void> {
  const conversation = await transaction
    .selectFrom("channelConversations")
    .innerJoin("channelAccounts", "channelAccounts.id", "channelConversations.accountId")
    .select([
      "channelConversations.accountId",
      "channelConversations.id",
      "channelAccounts.provider",
    ])
    .where("channelConversations.id", "=", ChannelConversationIdSchema.parse(input.conversationId))
    .executeTakeFirst();
  if (!conversation) return;
  const manifest = channelProviderCatalog.find(
    (candidate) => candidate.provider === conversation.provider,
  );
  if (!manifest) return;
  const parts = splitMessageText(
    channelReplyMarkdown(input.content, input.links.threadUrl(input.threadId)),
    manifest.maxMessageChars,
  );
  for (const [index, text] of parts.entries()) {
    await transaction
      .insertInto("channelDeliveries")
      .values({
        accountId: conversation.accountId,
        audience: "conversation",
        claimExpiresAt: null,
        claimOwner: null,
        claimTokenHash: null,
        content: jsonValue([{ text, type: "text" }]),
        conversationId: conversation.id,
        id: createChannelId("delivery"),
        ingressId: null,
        kind: "reply",
        lastError: null,
        messageId: input.messageId,
        nextAttemptAt: new Date(),
        part: index,
        partCount: parts.length,
        receipt: null,
        sentAt: null,
        status: "pending",
      })
      .onConflict((conflict) =>
        conflict
          .columns(["messageId", "part"])
          .where(sql<boolean>`kind = 'reply' and message_id is not null`)
          .doNothing(),
      )
      .execute();
  }
}

function channelReplyMarkdown(content: readonly ContentPart[], threadUrl: string): string {
  const blocks = content.map((part) =>
    part.type === "text"
      ? part.text
      : part.type === "browser-page"
        ? `🌐 ${placeContentLabel(part)} — [Open in Opensteer](${threadUrl})`
        : part.type === "computer-app" || part.type === "phone"
          ? `${part.type === "phone" ? "📱" : "🖥️"} ${placeContentLabel(part)} — [Open in Opensteer](${threadUrl})`
          : `📎 ${part.name} — [Open in Opensteer](${threadUrl})`,
  );
  const text = blocks.join("\n\n").trim();
  return text.length > 0 ? text : "(No text content)";
}
