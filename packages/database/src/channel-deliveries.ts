import { computerConnectionDeviceId } from "./integration-connections.js";
import { getDeviceSelfRunnerId } from "./device-inventory-store.js";
import { stripRefs } from "@opensteer/shared/stripRefs";
import { placeContentLabel } from "@opensteer/core";
import {
  ChannelConversationIdSchema,
  channelProviderCatalog,
  createChannelId,
  splitMessageText,
  type IntegrationConnectionId,
  type ChannelAccountId,
} from "@opensteer/channel-core";
import type { ContentPart, MessageId, ThreadId } from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import { chatNotEnded } from "./connection-liveness.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue, type ChannelLinks } from "./store-primitives.js";

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
    .select(["computerAccess", "ownerUserId", computerConnectionDeviceId.as("deviceId"), "status"])
    .where("id", "=", channel.sourceConnectionId)
    .$if(lock, (query) => query.forShare())
    .executeTakeFirst();
  return (
    source !== undefined &&
    source.status !== "revoked" &&
    source.computerAccess === "read-write" &&
    source.ownerUserId === channel.ownerUserId &&
    source.deviceId !== null &&
    (await getDeviceSelfRunnerId(transaction, source.deviceId)) === channel.runnerId
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
  // Its bridges lose their authority in the same statement that reads them (their account is
  // no longer connected); the Disconnect worker revokes them and stops what they started.
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
  const conversation = await liveBridgeConversation(transaction, input.conversationId);
  if (!conversation) return;
  await transaction
    .insertInto("bridgeDeliveries")
    .values({
      id: createChannelId("delivery"),
      bridgeId: conversation.bridgeId,
      accountId: conversation.accountId,
      conversationId: conversation.id,
      messageId: null,
      kind: "status",
      part: 0,
      partCount: 1,
      content: jsonValue([{ text: stripRefs(input.text), type: "text" }]),
      status: "pending",
      receipt: null,
      nextAttemptAt: sql<Date>`statement_timestamp()`,
    })
    .execute();
}

/**
 * The bridge conversation a Run replies to, while its bridge has not ended. A reply target naming
 * a conversation from before the update, or a bridge that ended, produces nothing: nothing leaves
 * the Home except as an attempt of a bridge, and only a live one sends it.
 */
async function liveBridgeConversation(
  transaction: Transaction<DatabaseSchema>,
  conversationId: string,
) {
  const parsed = ChannelConversationIdSchema.safeParse(conversationId);
  if (!parsed.success) return undefined;
  return (
    transaction
      .selectFrom("bridgeConversations")
      .innerJoin("agentConnections", "agentConnections.id", "bridgeConversations.bridgeId")
      .innerJoin("channelAccounts", "channelAccounts.id", "bridgeConversations.accountId")
      .select([
        "bridgeConversations.id",
        "bridgeConversations.bridgeId",
        "bridgeConversations.accountId",
        "channelAccounts.provider",
      ])
      .where("bridgeConversations.id", "=", parsed.data)
      // A paused chat keeps what it makes and sends it when it is back; an ended one makes nothing.
      .where(chatNotEnded(transaction))
      .executeTakeFirst()
  );
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
  const conversation = await liveBridgeConversation(transaction, input.conversationId);
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
      .insertInto("bridgeDeliveries")
      .values({
        id: createChannelId("delivery"),
        bridgeId: conversation.bridgeId,
        accountId: conversation.accountId,
        conversationId: conversation.id,
        messageId: input.messageId,
        kind: "reply",
        part: index,
        partCount: parts.length,
        content: jsonValue([{ text, type: "text" }]),
        status: "pending",
        receipt: null,
        nextAttemptAt: sql<Date>`statement_timestamp()`,
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

export function channelReplyMarkdown(content: readonly ContentPart[], threadUrl: string): string {
  const blocks = content.map((part) =>
    part.type === "text"
      ? part.text
      : part.type === "browser-page"
        ? `🌐 ${placeContentLabel(part)} — [Open in Opensteer](${threadUrl})`
        : part.type === "computer-app" || part.type === "phone"
          ? `${part.type === "phone" ? "📱" : "🖥️"} ${placeContentLabel(part)} — [Open in Opensteer](${threadUrl})`
          : `📎 ${part.name} — [Open in Opensteer](${threadUrl})`,
  );
  const text = stripRefs(blocks.join("\n\n")).trim();
  return text.length > 0 ? text : "(No text content)";
}
