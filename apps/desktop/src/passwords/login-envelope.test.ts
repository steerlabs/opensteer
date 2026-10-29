import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LoginEnvelopeBindingSchema, LoginReceiverKeySchema } from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { sealLoginEnvelope, openLoginEnvelope } from "./login-envelope.js";

// A fixed byte oracle keeps CryptoKit, JCA and Node from agreeing only with
// themselves about encoding, AAD or key derivation.
interface Vector {
  name: string;
  receiver: unknown;
  receiverPrivateKey: string;
  expectedBinding: unknown;
  envelope: unknown;
  now: number;
  plaintext?: string;
  aad?: string;
  expected: "open" | "reject";
}
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../packages/protocol/fixtures/login-envelope-v1.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };

describe("cross-language saved-login envelopes", () => {
  it.each(fixture.vectors)("$name", (vector) => {
    const options = {
      envelope: vector.envelope,
      receiver: LoginReceiverKeySchema.parse(vector.receiver),
      privateKey: Buffer.from(vector.receiverPrivateKey, "base64url"),
      expectedBinding: LoginEnvelopeBindingSchema.parse(vector.expectedBinding),
      now: vector.now,
      consumed: new Map<string, number>(),
    };
    if (vector.expected === "reject") {
      expect(() => openLoginEnvelope(options)).toThrow("Saved login text could not be opened.");
      expect(options.consumed.size).toBe(0);
    } else {
      expect(canonicalJson(options.expectedBinding)).toBe(vector.aad);
      expect(openLoginEnvelope(options)).toBe(vector.plaintext);
      expect(() => openLoginEnvelope(options)).toThrow("Saved login text could not be opened.");
      expect(options.consumed.size).toBe(1);
    }
  });

  it("seals fresh sender keys, salts and nonces, preserving literal UTF-8", () => {
    const vector = fixture.vectors.find((entry) => entry.expected === "open")!;
    const receiver = LoginReceiverKeySchema.parse(vector.receiver);
    const binding = LoginEnvelopeBindingSchema.parse(vector.expectedBinding);
    const value = "雪😀e\u0301\u0000\r\n\t";
    const first = sealLoginEnvelope({ value, receiver, binding, now: vector.now });
    const second = sealLoginEnvelope({ value, receiver, binding, now: vector.now });
    expect(first.senderPublicKey).not.toBe(second.senderPublicKey);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.salt).not.toBe(second.salt);
    expect(
      openLoginEnvelope({
        envelope: first,
        receiver,
        expectedBinding: binding,
        now: vector.now,
        privateKey: Buffer.from(vector.receiverPrivateKey, "base64url"),
        consumed: new Map(),
      }),
    ).toBe(value);
    expect(JSON.stringify(first)).not.toContain(value);
  });

  it("rejects all context changes and consumes an act/action once even with a fresh envelope", () => {
    const vector = fixture.vectors.find((entry) => entry.expected === "open")!;
    const receiver = LoginReceiverKeySchema.parse(vector.receiver);
    const binding = LoginEnvelopeBindingSchema.parse(vector.expectedBinding);
    const options = {
      envelope: vector.envelope,
      receiver,
      expectedBinding: binding,
      now: vector.now,
      privateKey: Buffer.from(vector.receiverPrivateKey, "base64url"),
      consumed: new Map<string, number>(),
    };
    for (const patch of [
      { connectionId: "different" },
      { connectionGeneration: 2 },
      { runId: "run_00000000-0000-4000-8000-000000000099" },
      { sessionId: "cus_00000000-0000-4000-8000-000000000099" },
      { actId: "different" },
      { actionIndex: 1 },
      { field: "username" },
      { expiresAt: binding.expiresAt - 1 },
    ]) {
      expect(() =>
        openLoginEnvelope({
          ...options,
          expectedBinding: LoginEnvelopeBindingSchema.parse({ ...binding, ...patch }),
        }),
      ).toThrow();
    }
    expect(options.consumed.size).toBe(0);
    openLoginEnvelope(options);
    const fresh = sealLoginEnvelope({
      value: "another",
      receiver,
      binding: { ...binding, field: "username" },
      now: vector.now,
    });
    expect(() =>
      openLoginEnvelope({
        ...options,
        envelope: fresh,
        expectedBinding: { ...binding, field: "username" },
      }),
    ).toThrow();
  });

  it("refuses bad receiver points, overlong validity, expired values and invalid Unicode without echoing values", () => {
    const vector = fixture.vectors.find((entry) => entry.expected === "open")!;
    const receiver = LoginReceiverKeySchema.parse(vector.receiver);
    const binding = LoginEnvelopeBindingSchema.parse(vector.expectedBinding);
    for (const value of ["\ud800", "\udfff", "x".repeat(4097)]) {
      expect(() => sealLoginEnvelope({ value, receiver, binding, now: vector.now })).toThrow(
        "Saved login text could not be sealed.",
      );
    }
    for (const expiresAt of [vector.now, vector.now - 1, vector.now + 60_001]) {
      expect(() =>
        sealLoginEnvelope({
          value: "secret",
          receiver,
          binding: { ...binding, expiresAt },
          now: vector.now,
        }),
      ).toThrow();
    }
    const badKey = createECDH("prime256v1");
    badKey.generateKeys();
    expect(() =>
      openLoginEnvelope({
        envelope: vector.envelope,
        receiver,
        privateKey: badKey.getPrivateKey(),
        expectedBinding: binding,
        now: vector.now,
        consumed: new Map(),
      }),
    ).toThrow();
    expect(() =>
      sealLoginEnvelope({
        value: "secret",
        receiver: { ...receiver, publicKey: "B" + "A".repeat(86) },
        binding,
        now: vector.now,
      }),
    ).toThrow();
  });
});
