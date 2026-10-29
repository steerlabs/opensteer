/** Intentional fixture regeneration only: pnpm exec tsx apps/desktop/scripts/generate-login-envelope-vectors.ts */
import { createCipheriv, createECDH, hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { LoginEnvelopeBindingSchema } from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";

const now = 1_800_000_000_000;
const binding = LoginEnvelopeBindingSchema.parse({
  version: 1,
  connectionId: "rax_00000000-0000-4000-8000-000000000001",
  connectionGeneration: 7,
  runId: "run_00000000-0000-4000-8000-000000000002",
  sessionId: "cus_00000000-0000-4000-8000-000000000003",
  actId: "cai:00000000-0000-4000-8000-000000000004",
  actionIndex: 0,
  field: "password",
  expiresAt: now + 45_000,
});
function scalar(value: number): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(value, 28);
  return bytes;
}
const recipient = createECDH("prime256v1");
recipient.setPrivateKey(scalar(1));
const receiver = {
  version: 1,
  connectionId: binding.connectionId,
  connectionGeneration: binding.connectionGeneration,
  publicKey: recipient.getPublicKey(undefined, "uncompressed").toString("base64url"),
};
function vector(name: string, plaintext: string, senderScalar: number) {
  const sender = createECDH("prime256v1");
  sender.setPrivateKey(scalar(senderScalar));
  const shared = sender.computeSecret(recipient.getPublicKey());
  const salt = Buffer.from(Array.from({ length: 32 }, (_, i) => (i + senderScalar) & 255));
  const nonce = Buffer.from(Array.from({ length: 12 }, (_, i) => (i + senderScalar) & 255));
  const aad = canonicalJson(binding);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, "opensteer/login-text/v1", 32));
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    name,
    expected: "open",
    now,
    plaintext,
    aad,
    receiver,
    receiverPrivateKey: scalar(1).toString("base64url"),
    senderPrivateKey: scalar(senderScalar).toString("base64url"),
    sharedSecret: shared.toString("base64url"),
    derivedKey: key.toString("base64url"),
    expectedBinding: binding,
    envelope: {
      binding,
      senderPublicKey: sender.getPublicKey(undefined, "uncompressed").toString("base64url"),
      salt: salt.toString("base64url"),
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    },
  };
}
const ascii = vector("ascii", "synthetic-password-v1", 2);
const unicode = vector("unicode-and-controls", "\uFEFF雪😀e\u0301\u0000\r\n\t", 3);
const empty = vector("empty", "", 4);
// Find a deterministic P-256 point whose shared X coordinate starts with 00.
let leadingScalar = 5;
for (;;) {
  const sender = createECDH("prime256v1");
  sender.setPrivateKey(scalar(leadingScalar));
  if (sender.computeSecret(recipient.getPublicKey())[0] === 0) break;
  leadingScalar += 1;
}
const leadingZero = vector("leading-zero-shared-secret", "keep all 32 bytes", leadingScalar);
const reject = { ...ascii, expected: "reject", plaintext: undefined, aad: undefined };
const vectors = [
  ascii,
  unicode,
  empty,
  leadingZero,
  {
    ...reject,
    name: "wrong-aad-field",
    envelope: { ...ascii.envelope, binding: { ...binding, field: "username" } },
    expectedBinding: { ...binding, field: "username" },
  },
  { ...reject, name: "wrong-expected-field", expectedBinding: { ...binding, field: "code" } },
  { ...reject, name: "wrong-key", receiverPrivateKey: scalar(9).toString("base64url") },
  {
    ...reject,
    name: "truncated-ciphertext",
    envelope: {
      ...ascii.envelope,
      ciphertext: Buffer.from(ascii.envelope.ciphertext, "base64url")
        .subarray(1)
        .toString("base64url"),
    },
  },
  {
    ...reject,
    name: "wrong-version",
    envelope: { ...ascii.envelope, binding: { ...binding, version: 2 } },
  },
  { ...reject, name: "expired", now: binding.expiresAt },
  { ...reject, name: "tampered-tag", envelope: { ...ascii.envelope, tag: "A".repeat(22) } },
  {
    ...reject,
    name: "noncanonical-base64",
    envelope: { ...ascii.envelope, tag: ascii.envelope.tag.slice(0, -1) + "B" },
  },
];
const fixture = {
  version: 1,
  algorithm: "P-256/HKDF-SHA256/AES-256-GCM",
  info: "opensteer/login-text/v1",
  publicKeyEncoding: "base64url of uncompressed X9.63 point (04 || X || Y)",
  binaryEncoding: "unpadded canonical base64url",
  note: "Synthetic test keys only. Regenerated deterministically with Node crypto. Native consumers must not rewrite this file.",
  vectors,
};
writeFileSync(
  new URL("../../../packages/protocol/fixtures/login-envelope-v1.json", import.meta.url),
  JSON.stringify(fixture, null, 2) + "\n",
);
