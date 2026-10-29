import {
  ChannelDeliveryError,
  type ChannelCredentialLease,
  type ChannelDelivery,
  type ChannelDeliveryDestination,
} from "@opensteer/channel-core";
import {
  callSlackApi,
  SlackConversationHistorySchema,
  SlackPostEphemeralSchema,
  SlackPostMessageSchema,
} from "./api.js";
import { renderSlackDeliveryText } from "./mrkdwn.js";

/**
 * The metadata event this app stamps on every message it posts, so a delivery
 * whose outcome was lost can be found again. Only the delivery id travels in
 * it: message metadata is readable by the whole workspace.
 */
export const slackDeliveryMetadataEventType = "opensteer.delivery";

/** How far before a delivery was created reconciliation looks for its message. */
const reconcileLookbackSeconds = 5 * 60;
const reconcilePageLimit = 200;
const reconcilePageCap = 5;

export interface SlackOutboundInput {
  readonly delivery: ChannelDelivery;
  readonly destination: ChannelDeliveryDestination;
  readonly lease: ChannelCredentialLease;
  readonly signal: AbortSignal;
}

export async function sendSlackDelivery(
  input: SlackOutboundInput,
  fetch_: typeof globalThis.fetch,
): Promise<{ readonly receipt: Readonly<Record<string, unknown>> }> {
  const token = botToken(input.lease);
  const text = renderSlackDeliveryText(input.delivery);
  const channel = input.destination.externalConversationId;

  if (input.delivery.audience === "actor" && !isDirectMessageChannel(channel)) {
    const user = input.destination.externalUserId;
    if (!user) {
      throw new ChannelDeliveryError(
        "A Slack delivery for one person names nobody to send it to",
        "dead",
      );
    }
    // An ephemeral message is only shown inside a thread when that thread is
    // already open for the reader, so it is posted to the conversation itself.
    const result = await callSlackApi(
      {
        fetch: fetch_,
        json: { channel, text, user },
        method: "chat.postEphemeral",
        signal: input.signal,
        token,
      },
      SlackPostEphemeralSchema,
    );
    if (!result.message_ts) {
      throw new ChannelDeliveryError("Slack did not acknowledge the ephemeral message", "unknown");
    }
    return { receipt: { channel, ephemeral: true, ts: result.message_ts } };
  }

  const result = await callSlackApi(
    {
      fetch: fetch_,
      json: {
        channel,
        metadata: {
          event_payload: { delivery_id: input.delivery.id },
          event_type: slackDeliveryMetadataEventType,
        },
        text,
        ...(input.destination.externalThreadId
          ? { thread_ts: input.destination.externalThreadId }
          : {}),
        // Agent replies quote links constantly; unfurling every one of them
        // would bury the answer under previews.
        unfurl_links: false,
        unfurl_media: false,
      },
      method: "chat.postMessage",
      signal: input.signal,
      token,
    },
    SlackPostMessageSchema,
  );
  if (!result.ts) {
    throw new ChannelDeliveryError("Slack did not return a message timestamp", "unknown");
  }
  return { receipt: { channel: result.channel ?? channel, ts: result.ts } };
}

/**
 * Decide whether a delivery whose answer was lost actually reached Slack.
 *
 * There is exactly one way a message is recognised: the delivery id this app
 * stamped into the message's own metadata. Slack's older publishing docs say an
 * undeclared event type is stored without validation, so the stamp is there to
 * be read back; nothing else about a message is identity. Text, timestamp and
 * bot id would all be guesses, and guessing wrong drops a reply for good — so
 * an unrecognised delivery is `unknown` and is sent again, which is the
 * at-least-once behaviour `docs/messaging.md` §4 documents.
 *
 * Reads run at Tier 3 for the customer-built apps this integration expects —
 * every person installs their own app from the manifest in the catalog, so the
 * 2025 limit on newly distributed apps (1 request/minute, 15 messages) does not
 * apply; pagination is still bounded so a busy channel cannot hold a claim open.
 */
export async function reconcileSlackDelivery(
  input: SlackOutboundInput,
  fetch_: typeof globalThis.fetch,
): Promise<
  | { readonly kind: "sent"; readonly receipt: Readonly<Record<string, unknown>> }
  | { readonly kind: "unknown" }
> {
  // An ephemeral message is never stored, so there is nothing to look for.
  if (
    input.delivery.audience === "actor" &&
    !isDirectMessageChannel(input.destination.externalConversationId)
  ) {
    return { kind: "unknown" };
  }
  const token = botToken(input.lease);
  const channel = input.destination.externalConversationId;
  const createdAtSeconds = Date.parse(input.delivery.createdAt) / 1_000;
  const oldest = (createdAtSeconds - reconcileLookbackSeconds).toFixed(6);
  const thread = input.destination.externalThreadId;

  let cursor: string | undefined;
  for (let page = 0; page < reconcilePageCap; page += 1) {
    const result = await callSlackApi(
      {
        fetch: fetch_,
        method: thread ? "conversations.replies" : "conversations.history",
        query: {
          channel,
          ...(cursor ? { cursor } : {}),
          include_all_metadata: "true",
          limit: String(reconcilePageLimit),
          oldest,
          ...(thread ? { ts: thread } : {}),
        },
        signal: input.signal,
        token,
      },
      SlackConversationHistorySchema,
    );
    for (const message of result.messages) {
      if (!message.ts) continue;
      if (
        message.metadata?.event_type === slackDeliveryMetadataEventType &&
        message.metadata.event_payload?.delivery_id === input.delivery.id
      ) {
        return { kind: "sent", receipt: { channel, ts: message.ts } };
      }
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return { kind: "unknown" };
}

/** Slack names a one-to-one conversation with a `D` id and nothing else. */
function isDirectMessageChannel(externalConversationId: string): boolean {
  return externalConversationId.startsWith("D");
}

function botToken(lease: ChannelCredentialLease): string {
  const token = lease.secrets.botToken;
  if (!token) throw new ChannelDeliveryError("Slack bot token is unavailable", "dead");
  return token;
}
