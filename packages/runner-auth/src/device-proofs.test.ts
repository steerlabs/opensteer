import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { canonicalRunnerPublicKeyPem } from "./proof.js";

// Swift (IphoneAppsCoreTests) and Kotlin (phone-connection DeviceProofsTest)
// read this file; OPENSTEER_WRITE_DEVICE_PROOF_VECTORS=1 rewrites it.
const fixturePath = fileURLToPath(new URL("../fixtures/device-proofs.v1.json", import.meta.url));

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
  it("matches the checked-in vectors the phones sign against", () => {
    const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
    const privateKey = createPrivateKey({
      format: "der",
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      type: "pkcs8",
    });
    const bind = {
      deploymentId: "dep_0192f4a1-0000-4000-8000-000000000001",
      runnerId: "rnr_0192f4a1-1111-4111-8111-111111111111",
      sessionId: "ses_0192f4a1-2222-4222-8222-222222222222",
      issuedAt: "2026-11-12T18:30:00.000+00:00",
    };
    const leave = { deploymentId: bind.deploymentId, runnerId: bind.runnerId, issuedAt: bind.issuedAt };
    const hex = (transcript: readonly string[]) =>
      Buffer.from(canonicalJson(transcript), "utf8").toString("hex");
    const actual = `${JSON.stringify(
      {
        version: 1,
        runnerSeed: seed.toString("hex"),
        publicKeyPem: canonicalRunnerPublicKeyPem(createPublicKey(privateKey)),
        bind: {
          ...bind,
          transcriptHex: hex(deviceSessionBindTranscript(bind)),
          signature: createDeviceSessionBindingSignature(privateKey, bind),
        },
        leave: {
          ...leave,
          transcriptHex: hex(deviceLeaveTranscript(leave)),
          signature: createDeviceLeaveSignature(privateKey, leave),
        },
      },
      null,
      2,
    )}\n`;
    if (process.env.OPENSTEER_WRITE_DEVICE_PROOF_VECTORS === "1") writeFileSync(fixturePath, actual);
    expect(readFileSync(fixturePath, "utf8")).toBe(actual);
    const vectors = JSON.parse(actual) as {
      bind: typeof bind & { signature: string };
      leave: typeof leave & { signature: string };
      publicKeyPem: string;
    };
    const verifying = createPublicKey(vectors.publicKeyPem);
    expect(
      verifyDeviceSessionBindingSignature(verifying, vectors.bind, Date.parse(bind.issuedAt)),
    ).toBe(true);
    expect(verifyDeviceLeaveSignature(verifying, vectors.leave)).toBe(true);
  });
});
