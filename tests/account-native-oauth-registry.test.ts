import { describe, expect, it } from "vitest";
import {
  NativeOAuthClientSetSchema,
  opensteerAccountNativeOAuthClients,
  opensteerNativeClients,
} from "../packages/core/src/identity.js";

describe("Account native OAuth registry", () => {
  it("registers the same first-party applications on Account and Host", () => {
    expect(opensteerAccountNativeOAuthClients.map((client) => client.clientId)).toEqual([
      "opensteer-desktop",
      "opensteer-desktop-beta",
      "opensteer-mobile",
    ]);
    expect(opensteerNativeClients.map((client) => client.clientId)).toEqual(
      opensteerAccountNativeOAuthClients.map((client) => client.clientId),
    );
    expect(NativeOAuthClientSetSchema.safeParse(opensteerAccountNativeOAuthClients).success).toBe(
      true,
    );
  });

  it("preserves the deployed Beta presentation while fencing client IDs and callback schemes", () => {
    const beta = opensteerAccountNativeOAuthClients[1]!;
    expect(beta).toMatchObject({
      clientId: "opensteer-desktop-beta",
      displayName: "Opensteer",
      softwareId: "opensteer-native",
    });
    expect(NativeOAuthClientSetSchema.safeParse([beta, beta]).success).toBe(false);
    expect(
      NativeOAuthClientSetSchema.safeParse([
        beta,
        {
          ...opensteerAccountNativeOAuthClients[2]!,
          redirectUris: ["com.steerlabs.opensteer.beta:/oauth/mobile-callback"],
        },
      ]).success,
    ).toBe(false);
  });
});
