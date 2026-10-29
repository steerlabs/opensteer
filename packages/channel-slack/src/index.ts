import { slackChannelProviderManifest, type ChannelAdapter } from "@opensteer/channel-core";
import { SlackUserDirectory } from "./api.js";
import {
  inspectSlackSetup,
  openSlackWebSocket,
  runSlackSocketConnection,
  type SlackWebSocketFactory,
} from "./connection.js";
import { reconcileSlackDelivery, sendSlackDelivery } from "./outbound.js";

export interface SlackAdapterOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable so the Socket Mode loop can be driven by a test. */
  readonly webSocket?: SlackWebSocketFactory;
}

export function createSlackAdapter(options: SlackAdapterOptions = {}): ChannelAdapter {
  const fetch_ = options.fetch ?? globalThis.fetch.bind(globalThis);
  const webSocket = options.webSocket ?? openSlackWebSocket;
  // The cache belongs to the adapter instance: it holds nothing but public
  // Slack facts, and it exists so a busy conversation does not spend a Web API
  // call per message on names that do not change.
  const users = new SlackUserDirectory({ fetch: fetch_ });
  return {
    connection: {
      inspect: ({ credentials, transportKind }) =>
        inspectSlackSetup(credentials, transportKind, fetch_),
      run: (input) =>
        runSlackSocketConnection({
          ...input,
          displayName: (botToken, externalUserId) => users.displayName(botToken, externalUserId),
          fetch: fetch_,
          webSocket,
        }),
    },
    manifest: slackChannelProviderManifest,
    outbound: {
      reconcile: (input) => reconcileSlackDelivery(input, fetch_),
      send: (input) => sendSlackDelivery(input, fetch_),
    },
  };
}

export {
  callSlackApi,
  inspectSlackConnection,
  openSlackSocket,
  parseSlackScopes,
  slackFailureKind,
  slackRetryAfterSeconds,
  SlackUserDirectory,
} from "./api.js";
export {
  inspectSlackSetup,
  openSlackWebSocket,
  requiredSlackBotScopes,
  runSlackSocketConnection,
  type SlackWebSocket,
  type SlackWebSocketFactory,
} from "./connection.js";
export {
  mentionedUserIds,
  normalizeSlackEvent,
  slackConversationType,
  SlackEventsApiPayloadSchema,
  SlackSocketEnvelopeSchema,
  type SlackSocketEnvelope,
} from "./events.js";
export { renderSlackDeliveryText, renderSlackMrkdwn } from "./mrkdwn.js";
export {
  reconcileSlackDelivery,
  sendSlackDelivery,
  slackDeliveryMetadataEventType,
} from "./outbound.js";
