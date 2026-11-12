import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import {
  createDeviceLeaveSignature,
  createDeviceSessionBindingSignature,
  deviceLeaveTranscript,
  deviceSessionBindTranscript,
  verifyDeviceLeaveSignature,
  verifyDeviceSessionBindingSignature,
} from "./device-proofs.js";

const input = {
  deploymentId: "deployment",
  runnerId: "runner",
  sessionId: "session",
  issuedAt: "2026-11-12T12:00:00.000Z",
};
const now = Date.parse(input.issuedAt);
describe("device proofs", () => {
  it("uses the exact canonical transcript and separates binding from leave", () => {
    const key = generateKeyPairSync("ed25519");
    expect(deviceSessionBindTranscript(input)).toEqual([
      "opensteer-device-session-bind-v1",
      "deployment",
      "runner",
      "session",
      input.issuedAt,
    ]);
    expect(deviceLeaveTranscript(input)).toEqual([
      "opensteer-device-leave-v1",
      "deployment",
      "runner",
      input.issuedAt,
    ]);
    const signature = createDeviceSessionBindingSignature(key.privateKey, input);
    expect(signature).toBe(
      sign(
        null,
        Buffer.from(canonicalJson(deviceSessionBindTranscript(input))),
        key.privateKey,
      ).toString("base64url"),
    );
    expect(verifyDeviceSessionBindingSignature(key.publicKey, { ...input, signature }, now)).toBe(
      true,
    );
    for (const field of ["deploymentId", "runnerId", "sessionId", "issuedAt"] as const) {
      expect(
        verifyDeviceSessionBindingSignature(
          key.publicKey,
          { ...input, [field]: "changed", signature },
          now,
        ),
      ).toBe(false);
    }
    expect(verifyDeviceLeaveSignature(key.publicKey, { ...input, signature })).toBe(false);
    expect(
      verifyDeviceSessionBindingSignature(key.publicKey, { ...input, signature }, now + 300_001),
    ).toBe(false);
    expect(
      verifyDeviceSessionBindingSignature(key.publicKey, { ...input, signature }, now - 300_001),
    ).toBe(false);
    expect(
      verifyDeviceSessionBindingSignature(
        generateKeyPairSync("ed25519").publicKey,
        { ...input, signature },
        now,
      ),
    ).toBe(false);
  });
  it("keeps a durable leave proof valid and bound to one identity", () => {
    const key = generateKeyPairSync("ed25519");
    const signature = createDeviceLeaveSignature(key.privateKey, input);
    expect(verifyDeviceLeaveSignature(key.publicKey, { ...input, signature })).toBe(true);
    expect(
      verifyDeviceLeaveSignature(key.publicKey, { ...input, runnerId: "replacement", signature }),
    ).toBe(false);
    expect(
      verifyDeviceLeaveSignature(key.publicKey, { ...input, signature: signature + "=" }),
    ).toBe(false);
  });
});
