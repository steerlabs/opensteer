import { describe, expect, it, vi } from "vitest";
import { OAuthDeepLinkBroker, isOpensteerOAuthCallback } from "./oauth-deep-link.js";

const oauth = {
  accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
  application: "desktop",
  clientId: "opensteer-desktop",
  hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
} as const;

describe("Desktop OAuth deep links", () => {
  it("accepts only the two exact OAuth callback routes", () => {
    expect(
      isOpensteerOAuthCallback(
        "com.opensteer.opensteer:/oauth/account-callback?code=code&state=state",
        oauth,
      ),
    ).toBe(true);
    expect(
      isOpensteerOAuthCallback(
        "com.opensteer.opensteer:/oauth/host-callback?error=access_denied",
        oauth,
      ),
    ).toBe(true);
    expect(
      isOpensteerOAuthCallback("com.opensteer.opensteer:/oauth/other-callback?code=code", oauth),
    ).toBe(false);
    expect(isOpensteerOAuthCallback("com.opensteer.opensteer:/settings/account", oauth)).toBe(
      false,
    );
    expect(isOpensteerOAuthCallback("https://oauth/account-callback", oauth)).toBe(false);
  });

  it("queues startup callbacks and delivers them in order after the manager attaches", async () => {
    const broker = new OAuthDeepLinkBroker(oauth);
    const consumer = vi.fn(async (_url: string) => true);
    broker.accept("com.opensteer.opensteer:/oauth/account-callback?code=first");
    broker.accept("com.opensteer.opensteer:/oauth/host-callback?code=second");
    broker.attach(consumer);
    await broker.settled();
    expect(consumer.mock.calls.map(([url]) => url)).toEqual([
      "com.opensteer.opensteer:/oauth/account-callback?code=first",
      "com.opensteer.opensteer:/oauth/host-callback?code=second",
    ]);
  });
});
