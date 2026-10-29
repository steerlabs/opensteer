import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  maximumProofTimestampWindowMs,
  proofTimestampIsValid,
  signProof,
  verifyProof,
} from "./proof.js";

describe("signed proofs", () => {
  it("round-trips a domain-separated canonical payload", () => {
    const keys = generateKeyPairSync("ed25519");
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const input = {
      domain: "opensteer-test-proof-v1",
      payload: ["value", { second: 2, first: 1 }],
    } as const;
    const signature = signProof(keys.privateKey, input);
    expect(
      verifyProof(keys.publicKey, {
        ...input,
        expiresAt: new Date(now + maximumProofTimestampWindowMs).toISOString(),
        now,
        signature,
      }),
    ).toBe(true);
  });

  it("rejects expired and overlong timestamp windows", () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    expect(proofTimestampIsValid(new Date(now).toISOString(), now)).toBe(false);
    expect(
      proofTimestampIsValid(new Date(now + maximumProofTimestampWindowMs + 1).toISOString(), now),
    ).toBe(false);
  });
});
