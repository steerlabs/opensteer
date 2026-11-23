import {
  ChannelDeliveryError,
  type ChannelCredentialLease,
  type ChannelDelivery,
  type ChannelDeliveryDestination,
} from "@opensteer/channel-core";
import { callSlackApi, SlackPostMessageSchema } from "./api.js";
import { renderSlackDeliveryText } from "./mrkdwn.js";

export interface SlackOutboundInput {
  readonly delivery: ChannelDelivery;
  readonly destination: ChannelDeliveryDestination;
  readonly lease: ChannelCredentialLease;
  readonly signal: AbortSignal;
}

/**
 * Posts one delivery as one message where it came from. A failure that may have come after
 * Slack posted it is `unknown` and is never posted again; only a rate limit is retried.
 */
export async function sendSlackDelivery(
  input: SlackOutboundInput,
  fetch_: typeof globalThis.fetch,
): Promise<{ readonly receipt: Readonly<Record<string, unknown>> }> {
  const channel = input.destination.externalConversationId;
  const result = await callSlackApi(
    {
      fetch: fetch_,
      json: {
        channel,
        text: renderSlackDeliveryText(input.delivery),
        ...(input.destination.externalThreadId
          ? { thread_ts: input.destination.externalThreadId }
          : {}),
        // Agent replies quote links constantly; unfurling every one of them
        // would bury the answer under previews.
        unfurl_links: false,
        unfurl_media: false,
      },
      method: "chat.postMessage",
      posts: true,
      signal: input.signal,
      token: botToken(input.lease),
    },
    SlackPostMessageSchema,
  );
  if (!result.ts) {
    throw new ChannelDeliveryError("Slack did not return a message timestamp", "unknown");
  }
  return { receipt: { channel: result.channel ?? channel, ts: result.ts } };
}

function botToken(lease: ChannelCredentialLease): string {
  const token = lease.secrets.botToken;
  if (!token) throw new ChannelDeliveryError("Slack bot token is unavailable", "dead");
  return token;
}
