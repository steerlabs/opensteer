import { describe, expect, it } from "vitest";
import {
  generateOAuthBrokerEphemeralKeyPair,
  openOAuthBrokerPayload,
  sealOAuthBrokerPayload,
} from "./broker-sealing.js";

describe("OAuth broker sealing", () => {
  it("binds ciphertext to every authenticated context field", () => {
    const host = generateOAuthBrokerEphemeralKeyPair();
    const context = {
      accountSubject: "acct_exact",
      attemptId: "hoa_exact",
      authority: "digest",
      expiry: "2030-01-01T00:00:00.000Z",
      revision: 1,
      scopes: "scope-digest",
    };
    const sealed = sealOAuthBrokerPayload({ accessToken: "marker" }, host.publicKey, context);
    expect(openOAuthBrokerPayload(sealed, host.privateKey, context)).toEqual({
      accessToken: "marker",
    });
    for (const field of Object.keys(context)) {
      expect(() =>
        openOAuthBrokerPayload(sealed, host.privateKey, { ...context, [field]: "other" }),
      ).toThrow();
    }
    const otherHost = generateOAuthBrokerEphemeralKeyPair();
    expect(() => openOAuthBrokerPayload(sealed, otherHost.privateKey, context)).toThrow();
  });
});
