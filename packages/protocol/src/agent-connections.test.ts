import { describe, expect, it } from "vitest";
import { AgentConnectionBridgeSchema } from "./agent-connections.js";

const bridge = {
  accountId: "cha_1",
  provider: "Slack",
  conversationId: null,
  senders: "owner",
  accountName: "Workshop",
  conversationName: null,
  channelConnectionId: "con_1",
};

describe("a chat's facts on the wire", () => {
  it("reads a cause from a newer Home as not said, and keeps the rest of the chat", () => {
    const read = AgentConnectionBridgeSchema.parse({
      ...bridge,
      endedBy: "a-newer-cause",
      pausedBy: "a-newer-cause",
      pausedMessages: "a-newer-fate",
      unknownReplies: 1,
    });
    expect(read).toMatchObject({ accountName: "Workshop", unknownReplies: 1 });
    expect(read.endedBy).toBeUndefined();
    expect(read.pausedBy).toBeUndefined();
    expect(read.pausedMessages).toBeUndefined();
  });

  it("keeps a cause this app knows", () => {
    expect(
      AgentConnectionBridgeSchema.parse({ ...bridge, endedBy: "account", pausedBy: "you" }),
    ).toMatchObject({ endedBy: "account", pausedBy: "you" });
  });
});
