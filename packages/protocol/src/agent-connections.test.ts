import { AgentConnectionIdentityAtConsentSchema } from "@opensteer/control-plane-protocol";
import { describe, expect, it } from "vitest";
import {
  AgentConnectionBridgeSchema,
  AgentConnectionIdentityPresentationSchema,
} from "./agent-connections.js";

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

describe("verified agent identity on the wire", () => {
  it("uses verified origin fields with no platform* leftover names", () => {
    const verifiedAtConsent = {
      kind: "verified",
      origin: "https://agentpay.example",
      directoryId: "agentpay",
      displayName: "AgentPay",
      directoryRevision: 3,
      recordedAt: "2026-11-20T12:00:00.000Z",
    };
    expect(AgentConnectionIdentityAtConsentSchema.parse(verifiedAtConsent)).toEqual(
      verifiedAtConsent,
    );
    expect(
      AgentConnectionIdentityAtConsentSchema.safeParse({
        kind: "platform",
        platformOrigin: "https://agentpay.example",
        platformDirectoryId: "agentpay",
        platformName: "AgentPay",
        directoryRevision: 3,
        recordedAt: "2026-11-20T12:00:00.000Z",
      }).success,
    ).toBe(false);

    const presentation = {
      evidenceKind: "verified",
      verified: true,
      selfAsserted: false,
      heading: "AgentPay",
      detail: "https://agentpay.example",
      origins: [{ role: "verified", label: "AgentPay", origin: "https://agentpay.example" }],
      warning: "Only allow this if you started it yourself.",
    };
    expect(AgentConnectionIdentityPresentationSchema.parse(presentation)).toEqual(presentation);
    expect(
      AgentConnectionIdentityPresentationSchema.safeParse({
        ...presentation,
        evidenceKind: "platform",
        origins: [{ role: "platform", label: "AgentPay", origin: "https://agentpay.example" }],
      }).success,
    ).toBe(false);
  });
});
