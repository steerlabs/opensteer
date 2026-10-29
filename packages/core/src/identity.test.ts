import { describe, expect, it } from "vitest";
import {
  NativeOAuthClientSetSchema,
  NativeOAuthRedirectUriSchema,
  opensteerAccountNativeOAuthClients,
  opensteerHostNativeOAuthClients,
  type NativeOAuthClient,
} from "./identity.js";

const desktop: NativeOAuthClient = {
  application: "desktop",
  clientId: "opensteer-desktop",
  displayName: "Opensteer Desktop",
  redirectUris: ["com.opensteer.opensteer:/oauth/host-callback"],
  softwareId: "opensteer-desktop",
};

describe("native OAuth redirect URIs", () => {
  it("accepts the reverse-domain private-use callbacks the built-in clients ship", () => {
    for (const client of [
      ...opensteerHostNativeOAuthClients,
      ...opensteerAccountNativeOAuthClients,
    ])
      for (const redirectUri of client.redirectUris) {
        expect(NativeOAuthRedirectUriSchema.safeParse(redirectUri).success).toBe(true);
      }
    expect(
      NativeOAuthRedirectUriSchema.safeParse("com.steerlabs.opensteer.beta:/oauth/host-callback")
        .success,
    ).toBe(true);
  });

  it.each([
    // Not a callback at all: an operable URI the browser would run.
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    // A web origin can never receive a native authorization code.
    "http://127.0.0.1:4310/oauth/host-callback",
    "https://opensteer.example.com/oauth/host-callback",
    // A generic scheme any other installed application can register.
    "opensteer:/oauth/host-callback",
    "myapp:/oauth/host-callback",
    // An authority the operating system does not arbitrate.
    "com.opensteer.mobile://oauth/host-callback",
    "com.opensteer.mobile://user:secret@oauth/host-callback",
    // Spellings that would let two strings name one callback.
    "com.opensteer.mobile:/oauth/host-callback?channel=beta",
    "com.opensteer.mobile:/oauth/host-callback#fragment",
    "com.opensteer.mobile:/oauth/../oauth/host-callback",
    "com.opensteer.mobile:",
    "com.opensteer.mobile:/",
    "COM.OPENSTEER.MOBILE:/oauth/host-callback",
    "/oauth/host-callback",
    "",
  ])("rejects %s", (value) => {
    expect(NativeOAuthRedirectUriSchema.safeParse(value).success).toBe(false);
  });
});

describe("native OAuth client set", () => {
  it("accepts the built-in allowlists", () => {
    expect(NativeOAuthClientSetSchema.safeParse(opensteerHostNativeOAuthClients).success).toBe(
      true,
    );
    expect(NativeOAuthClientSetSchema.safeParse(opensteerAccountNativeOAuthClients).success).toBe(
      true,
    );
  });

  it("refuses two applications that share one operating-system scheme", () => {
    const result = NativeOAuthClientSetSchema.safeParse([
      desktop,
      {
        ...desktop,
        application: "mobile",
        clientId: "opensteer-mobile",
        redirectUris: ["com.opensteer.opensteer:/oauth/mobile-callback"],
      },
    ]);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("claimed by more than one client");
  });

  it("refuses a client that spreads its callbacks across schemes", () => {
    const result = NativeOAuthClientSetSchema.safeParse([
      {
        ...desktop,
        redirectUris: [
          "com.opensteer.opensteer:/oauth/host-callback",
          "com.opensteer.mobile:/oauth/host-callback",
        ],
      },
    ]);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("must use one application scheme");
  });

  it("allows independently signed stable and Beta desktop builds", () => {
    expect(
      NativeOAuthClientSetSchema.safeParse([
        desktop,
        {
          ...desktop,
          clientId: "opensteer-desktop-beta",
          redirectUris: ["com.steerlabs.opensteer.beta:/oauth/host-callback"],
          softwareId: "opensteer-desktop-beta",
        },
      ]).success,
    ).toBe(true);
  });

  it("refuses a repeated client ID or callback", () => {
    expect(NativeOAuthClientSetSchema.safeParse([desktop, desktop]).success).toBe(false);
    expect(
      NativeOAuthClientSetSchema.safeParse([
        {
          ...desktop,
          redirectUris: [
            "com.opensteer.opensteer:/oauth/host-callback",
            "com.opensteer.opensteer:/oauth/host-callback",
          ],
        },
      ]).success,
    ).toBe(false);
    expect(NativeOAuthClientSetSchema.safeParse([]).success).toBe(false);
  });
});
