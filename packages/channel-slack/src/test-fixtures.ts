import {
  createChannelId,
  type ChannelCredentialLease,
  type ChannelDelivery,
  type ChannelDeliveryDestination,
} from "@opensteer/channel-core";

/** One delivery, with every field a test is not asserting already filled in. */
export function delivery(overrides: Partial<ChannelDelivery> = {}): ChannelDelivery {
  return {
    accountId: createChannelId("account"),
    attempts: 1,
    audience: "conversation",
    content: [{ text: "hello", type: "text" }],
    conversationId: createChannelId("conversation"),
    createdAt: "2026-08-10T00:00:00.000Z",
    id: createChannelId("delivery"),
    kind: "reply",
    lastError: null,
    messageId: null,
    receipt: null,
    status: "attempt-started",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

export function destination(
  overrides: Partial<ChannelDeliveryDestination> = {},
): ChannelDeliveryDestination {
  return {
    externalConversationId: "C1",
    externalScopeId: "T1",
    externalThreadId: null,
    externalUserId: null,
    ...overrides,
  };
}

export function lease(
  secrets: Record<string, string> = { botToken: "xoxb-test" },
): ChannelCredentialLease {
  return {
    accountId: createChannelId("account"),
    externalAccountId: "T1",
    secrets,
  };
}
