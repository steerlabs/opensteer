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
    const desktop = opensteerAccountNativeOAuthClients[0]!;
    expect(desktop).toMatchObject({
      clientId: "opensteer-desktop",
      displayName: "Opensteer",
      softwareId: "opensteer-native",
    });
    expect(NativeOAuthClientSetSchema.safeParse([desktop, desktop]).success).toBe(false);
    expect(
      NativeOAuthClientSetSchema.safeParse([
        desktop,
        {
          ...opensteerAccountNativeOAuthClients[1]!,
          redirectUris: ["com.opensteer.opensteer:/oauth/mobile-callback"],
        },
      ]).success,
    ).toBe(false);
  });
});
