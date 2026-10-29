import { describe, expect, it } from "vitest";
import {
  channelProviderCatalog,
  imessageChannelProviderManifest,
  slackChannelProviderManifest,
} from "./catalog.js";
import { ChannelProviderManifestSchema } from "./models.js";

describe("channel provider catalog", () => {
  it("keeps the Slack catalog entry valid and registered", () => {
    expect(ChannelProviderManifestSchema.safeParse(slackChannelProviderManifest).success).toBe(
      true,
    );
    expect(channelProviderCatalog).toContain(slackChannelProviderManifest);
  });

  /**
   * iMessage is reached through one Mac and its Messages, never a token, and
   * anybody who knows the address can write to it: so it carries no
   * credentials, is pinned to a computer, and the Host speaks only to people
   * it admitted.
   */
  it("describes iMessage as a credential-less, computer-pinned transport anyone can write to", () => {
    expect(ChannelProviderManifestSchema.parse(imessageChannelProviderManifest)).toMatchObject({
      actorDelivery: "direct-message-only",
      computerApp: "apple-messages",
      connectionMethods: ["computer"],
      credentialFields: [],
      defaultTransportKind: "computer",
      provider: "imessage",
      senders: "anyone",
      transportKinds: ["computer"],
    });
    expect(slackChannelProviderManifest.senders).toBe("members");
    expect(channelProviderCatalog).toContain(imessageChannelProviderManifest);
  });

  it("refuses a computer transport that asks for credentials, or one mixed with another transport", () => {
    expect(
      ChannelProviderManifestSchema.safeParse({
        ...imessageChannelProviderManifest,
        credentialFields: slackChannelProviderManifest.credentialFields,
      }).success,
    ).toBe(false);
    expect(
      ChannelProviderManifestSchema.safeParse({
        ...imessageChannelProviderManifest,
        transportKinds: ["computer", "socket"],
      }).success,
    ).toBe(false);
    const { computerApp: _computerApp, ...withoutApp } = imessageChannelProviderManifest;
    expect(ChannelProviderManifestSchema.safeParse(withoutApp).success).toBe(false);
    expect(
      ChannelProviderManifestSchema.safeParse({
        ...slackChannelProviderManifest,
        computerApp: "apple-messages",
      }).success,
    ).toBe(false);
  });
});
