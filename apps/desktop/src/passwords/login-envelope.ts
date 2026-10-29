import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import {
  LoginEnvelopeBindingSchema,
  LoginReceiverKeySchema,
  SealedLoginEnvelopeSchema,
  loginEnvelopeHkdfInfo,
  loginEnvelopeMaxLifetimeMs,
  loginEnvelopeMaxPlaintextBytes,
  loginEnvelopeMaxValueLength,
  type LoginEnvelopeBinding,
  type LoginReceiverKey,
  type SealedLoginEnvelope,
} from "@opensteer/protocol";
import { decodeBase64Url } from "@opensteer/shared/base64url";
import { canonicalJson } from "@opensteer/shared/canonicalJson";

/** Called only in the vault desktop, immediately after a serialized broker release. */
export function sealLoginEnvelope(input: {
  readonly value: string;
  readonly receiver: LoginReceiverKey;
  readonly binding: LoginEnvelopeBinding;
  readonly now: number;
}): SealedLoginEnvelope {
  let plaintext: Buffer | undefined;
  let shared: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    const receiver = LoginReceiverKeySchema.parse(input.receiver);
    const binding = LoginEnvelopeBindingSchema.parse(input.binding);
    checkBinding(receiver, binding, input.now);
    if (input.value.length > loginEnvelopeMaxValueLength || !input.value.isWellFormed())
      throw new Error();
    plaintext = Buffer.from(input.value, "utf8");
    const sender = createECDH("prime256v1");
    sender.generateKeys();
    shared = sender.computeSecret(publicKey(receiver.publicKey));
    const salt = randomBytes(32);
    const nonce = randomBytes(12);
    key = deriveKey(shared, salt);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(canonicalJson(binding), "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return SealedLoginEnvelopeSchema.parse({
      binding,
      senderPublicKey: sender.getPublicKey(undefined, "uncompressed").toString("base64url"),
      salt: salt.toString("base64url"),
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    });
  } catch {
    // No crypto error, validation issue, parameter or released value crosses this boundary.
    throw new Error("Saved login text could not be sealed.");
  } finally {
    plaintext?.fill(0);
    shared?.fill(0);
    key?.fill(0);
  }
}

/**
 * Reference opener for the shared vectors. Production executors implement this
 * in CryptoKit/JCA and own the same connection-local replay claims.
 */
export function openLoginEnvelope(input: {
  readonly envelope: unknown;
  readonly receiver: LoginReceiverKey;
  readonly privateKey: Uint8Array;
  readonly expectedBinding: LoginEnvelopeBinding;
  readonly now: number;
  readonly consumed: Map<string, number>;
}): string {
  let plaintext: Buffer | undefined;
  let pendingPlaintext: Buffer | undefined;
  let shared: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    const envelope = SealedLoginEnvelopeSchema.parse(input.envelope);
    const receiver = LoginReceiverKeySchema.parse(input.receiver);
    const expected = LoginEnvelopeBindingSchema.parse(input.expectedBinding);
    checkBinding(receiver, expected, input.now);
    const aad = canonicalJson(expected);
    if (canonicalJson(envelope.binding) !== aad) throw new Error();
    const recipient = createECDH("prime256v1");
    if (input.privateKey.byteLength !== 32) throw new Error();
    recipient.setPrivateKey(input.privateKey);
    if (!recipient.getPublicKey(undefined, "uncompressed").equals(publicKey(receiver.publicKey)))
      throw new Error();
    shared = recipient.computeSecret(publicKey(envelope.senderPublicKey));
    key = deriveKey(shared, binary(envelope.salt, 32));
    const ciphertext = binary(envelope.ciphertext);
    if (ciphertext.length > loginEnvelopeMaxPlaintextBytes) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, binary(envelope.nonce, 12), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(binary(envelope.tag, 16));
    pendingPlaintext = decipher.update(ciphertext);
    plaintext = Buffer.concat([pendingPlaintext, decipher.final()]);
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plaintext);
    if (value.length > loginEnvelopeMaxValueLength) throw new Error();
    const claim = canonicalJson([
      expected.connectionId,
      expected.connectionGeneration,
      expected.runId,
      expected.sessionId,
      expected.actId,
      expected.actionIndex,
    ]);
    for (const [id, expiry] of input.consumed) if (expiry <= input.now) input.consumed.delete(id);
    if (input.consumed.has(claim)) throw new Error();
    // Synchronous claim before returning plaintext: a concurrent open cannot
    // type twice, even if re-sealed with another field or deadline.
    input.consumed.set(claim, expected.expiresAt);
    return value;
  } catch {
    throw new Error("Saved login text could not be opened.");
  } finally {
    plaintext?.fill(0);
    pendingPlaintext?.fill(0);
    shared?.fill(0);
    key?.fill(0);
  }
}

function checkBinding(
  receiver: LoginReceiverKey,
  binding: LoginEnvelopeBinding,
  now: number,
): void {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    binding.connectionId !== receiver.connectionId ||
    binding.connectionGeneration !== receiver.connectionGeneration ||
    binding.expiresAt <= now ||
    binding.expiresAt - now > loginEnvelopeMaxLifetimeMs
  )
    throw new Error();
}

function binary(value: string, length?: number): Buffer {
  const bytes = Buffer.from(decodeBase64Url(value));
  if (length !== undefined && bytes.length !== length) throw new Error();
  return bytes;
}

function publicKey(value: string): Buffer {
  const bytes = binary(value, 65);
  if (bytes[0] !== 4) throw new Error();
  return bytes;
}

function deriveKey(shared: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, salt, loginEnvelopeHkdfInfo, 32));
}
