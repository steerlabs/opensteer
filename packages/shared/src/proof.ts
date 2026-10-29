import { createPrivateKey, createPublicKey, sign, verify, KeyObject } from "node:crypto";
import { canonicalJson } from "./canonicalJson.js";

export const maximumProofTimestampWindowMs = 30_000;

export type Ed25519KeySource = KeyObject | string | Buffer;

/**
 * Each protocol reports a rejected key in its own vocabulary — a Device raises
 * a coded `DeviceError`, an attach ticket raises a Forbidden — and callers
 * branch on those types. The caller therefore supplies the error; only the
 * decision of what counts as a usable Ed25519 key lives here.
 */
export type Ed25519KeyFailure = (kind: "unreadable" | "not-ed25519", cause?: unknown) => Error;

export function normalizeEd25519PublicKey(
  source: Ed25519KeySource,
  fail: Ed25519KeyFailure,
): KeyObject {
  let key: KeyObject;
  try {
    key = source instanceof KeyObject ? source : createPublicKey(source);
  } catch (error) {
    throw fail("unreadable", error);
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw fail("not-ed25519");
  return key;
}

export function normalizeEd25519PrivateKey(
  source: Ed25519KeySource,
  fail: Ed25519KeyFailure,
): KeyObject {
  let key: KeyObject;
  try {
    key = source instanceof KeyObject ? source : createPrivateKey(source);
  } catch (error) {
    throw fail("unreadable", error);
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw fail("not-ed25519");
  return key;
}

export function signProof(
  privateKey: KeyObject,
  input: { readonly domain: string; readonly payload: readonly unknown[] },
): string {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Proof signing requires an Ed25519 private key");
  }
  return sign(null, proofTranscript(input), privateKey).toString("base64url");
}

export function verifyProof(
  publicKey: KeyObject,
  input: {
    readonly domain: string;
    readonly expiresAt: string;
    readonly now: number;
    readonly payload: readonly unknown[];
    readonly signature: string;
  },
): boolean {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Proof verification requires an Ed25519 public key");
  }
  if (!proofTimestampIsValid(input.expiresAt, input.now)) return false;
  let signature: Buffer;
  try {
    signature = Buffer.from(input.signature, "base64url");
  } catch {
    return false;
  }
  return signature.byteLength === 64 && verify(null, proofTranscript(input), publicKey, signature);
}

export function proofTimestampIsValid(expiresAt: string, now: number): boolean {
  const expiration = Date.parse(expiresAt);
  return (
    Number.isFinite(expiration) &&
    expiration > now &&
    expiration - now <= maximumProofTimestampWindowMs
  );
}

function proofTranscript(input: {
  readonly domain: string;
  readonly payload: readonly unknown[];
}): Buffer {
  return Buffer.from(canonicalJson([input.domain, ...input.payload]), "utf8");
}
