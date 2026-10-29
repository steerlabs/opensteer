import type { ChannelProviderManifest } from "./models.js";

const slackAppManifest = JSON.stringify(
  {
    display_information: {
      description: "Route Slack conversations to Opensteer Workspaces.",
      name: "Opensteer",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { always_online: true, display_name: "Opensteer" },
    },
    oauth_config: {
      scopes: {
        bot: [
          "channels:history",
          "chat:write",
          "groups:history",
          "im:history",
          "mpim:history",
          "users:read",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ["message.channels", "message.groups", "message.im", "message.mpim"],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  },
  undefined,
  2,
);

export const slackChannelProviderManifest = {
  // Slack's ephemeral messages reach one person inside a channel, so a link
  // code can be handed over where the person wrote.
  actorDelivery: "in-conversation",
  availability: "available",
  connectionMethods: ["bring-your-own"],
  credentialFields: [
    {
      help: "Bot User OAuth Token from OAuth & Permissions.",
      key: "botToken",
      label: "Bot user OAuth token",
      placeholder: "xoxb-…",
      secret: true,
      uses: ["delivery", "transport"],
    },
    {
      help: "App-level token with the connections:write scope.",
      key: "appToken",
      label: "App-level token",
      placeholder: "xapp-…",
      secret: true,
      uses: ["transport"],
    },
  ],
  defaultTransportKind: "socket",
  description: "Route Slack channels, threads, and direct messages to Workspaces.",
  label: "Slack",
  maxMessageChars: 3_800,
  provider: "slack",
  // Only people inside the Slack workspace can write to the bot.
  senders: "members",
  setupUrl: "https://api.slack.com/apps",
  setupArtifact: {
    content: slackAppManifest,
    filename: "opensteer-slack-app-manifest.json",
    mediaType: "application/json",
  },
  transportKinds: ["socket"],
} as const satisfies ChannelProviderManifest;

/**
 * iMessage through one Mac signed into an Apple account kept for the bot: the
 * Opensteer Computer Use helper on that Mac reads its Messages and sends
 * through it, so the connection is pinned to that Mac and has no secret. v1
 * is text in one-to-one iMessage conversations: no groups, no SMS, no
 * attachments.
 */
export const imessageChannelProviderManifest = {
  // A one-to-one conversation is the only kind, and it is already private.
  actorDelivery: "direct-message-only",
  availability: "available",
  computerApp: "apple-messages",
  connectionMethods: ["computer"],
  credentialFields: [],
  defaultTransportKind: "computer",
  description:
    "Text your agents from your phone, through a Mac signed into an Apple account for the bot.",
  label: "iMessage",
  // What the helper sends in one message.
  maxMessageChars: 4_000,
  provider: "imessage",
  // Anybody who knows the address can text it.
  senders: "anyone",
  setupUrl: null,
  setupArtifact: null,
  transportKinds: ["computer"],
} as const satisfies ChannelProviderManifest;

/**
 * An address a person is texted at — iMessage's kind — in the one form a
 * channel compares: an email in lower case, or a phone number as `+` and its
 * digits. Null for anything else. The owner's typed handles and every sender
 * a Mac reports go through it, so one person is never two identities.
 */
export function normalizePersonalAddress(value: string): string | null {
  const handle = value.trim();
  if (handle.includes("@")) {
    const email = handle.toLowerCase();
    return /^[^\s@]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/u.test(email) ? email : null;
  }
  if (!/^\+[\d\s().-]+$/u.test(handle)) return null;
  const digits = handle.replaceAll(/\D/gu, "");
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export const channelProviderCatalog = [
  imessageChannelProviderManifest,
  slackChannelProviderManifest,
] as const satisfies readonly ChannelProviderManifest[];
