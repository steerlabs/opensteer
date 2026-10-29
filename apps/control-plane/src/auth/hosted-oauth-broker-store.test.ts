import { describe, expect, it } from "vitest";
import { assertHostedOAuthBrokerDurableRecord } from "./hosted-oauth-broker-store.js";

describe("HostedOAuthBrokerStore durable boundary", () => {
  it("rejects OAuth credentials, codes, provider responses, and provider identity", () => {
    for (const [key, marker] of [
      ["accessToken", "access-token-marker"],
      ["refreshToken", "refresh-token-marker"],
      ["idToken", "id-token-marker"],
      ["code", "authorization-code-marker"],
      ["state", "state-plaintext-marker"],
      ["providerResponse", "provider-body-marker"],
      ["email", "provider-email-marker@example.test"],
    ] as const) {
      expect(() => assertHostedOAuthBrokerDurableRecord({ [key]: marker })).toThrow(
        `cannot durably store ${key}`,
      );
    }
  });

  it("accepts only safe metadata and opaque Host-sealed ciphertext", () => {
    expect(() =>
      assertHostedOAuthBrokerDurableRecord({
        attemptId: `hoa_${crypto.randomUUID()}`,
        contextKeyVersion: 1,
        deploymentId: "dep_safe",
        encryptedContext: Buffer.from("opaque-attempt-context"),
        expiresAt: new Date(),
        hostPublicKey: "a".repeat(43),
        launchTicketHash: "f".repeat(43),
        provider: "google",
        providerApplicationRevision: 1,
        requestedScopeDigest: "b".repeat(43),
        sealedCiphertext: {
          ciphertext: "opaque",
          ephemeralPublicKey: "c".repeat(43),
          nonce: "d".repeat(16),
          tag: "e".repeat(22),
          version: 1,
        },
        stateHash: "g".repeat(43),
      }),
    ).not.toThrow();
  });
});
