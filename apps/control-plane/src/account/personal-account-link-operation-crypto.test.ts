import { describe, expect, it } from "vitest";
import {
  CompletePersonalHostAccountLinkResponseSchema,
  PersonalHostAccountLinkChallengeIdSchema,
} from "@opensteer/control-plane-protocol";
import { PersonalAccountLinkOperationCipher } from "./personal-account-link-operation-crypto.js";

describe("Personal Account-link operation encryption", () => {
  const cipher = new PersonalAccountLinkOperationCipher(Buffer.alloc(32, 7).toString("base64url"));
  const challengeId = PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`);

  it("round trips a small retry-safe result", () => {
    const response = fixture();
    expect(cipher.open(challengeId, cipher.seal(challengeId, response))).toEqual(response);
  });

  it.each([
    "plr1.not-canonical.AA.AA",
    `plr1.${"A".repeat(16)}.${"A".repeat(100_000)}.${"A".repeat(22)}`,
  ])("rejects malformed or oversized stored data", (sealed) => {
    expect(() => cipher.open(challengeId, sealed)).toThrow();
  });

  it("rejects tampering and challenge replay", () => {
    const sealed = cipher.seal(challengeId, fixture());
    const parts = sealed.split(".");
    const ciphertext = parts[2]!;
    parts[2] = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;
    expect(() => cipher.open(challengeId, parts.join("."))).toThrow();
    expect(() =>
      cipher.open(
        PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`),
        sealed,
      ),
    ).toThrow();
  });
});

function fixture() {
  return CompletePersonalHostAccountLinkResponseSchema.parse({
    completionGrant: `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`,
    hostCredential: `osc_${"d".repeat(43)}`,
    linkGeneration: "g".repeat(43),
    resultExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}
