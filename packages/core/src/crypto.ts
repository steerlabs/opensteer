import { createHash, KeyObject } from "node:crypto";

/**
 * The two digests Opensteer's signed artifacts are built from.
 *
 * These are Node-only, so they are reached through the `@opensteer/core/crypto`
 * entry point rather than the package index: the browser bundle imports
 * `@opensteer/core` and must not pull `node:crypto` in behind it.
 *
 * Both outputs are unpadded base64url because they travel in URLs, JSON
 * identity documents, and database keys. Their exact bytes are part of signed
 * artifacts — a Host key fingerprint is pinned by an Account and compared by a
 * Desktop — so this formatting is a compatibility contract, not a detail.
 */

/** Unpadded base64url SHA-256 of a UTF-8 string or raw bytes. */
export function sha256Base64Url(value: string | Uint8Array): string {
  return typeof value === "string"
    ? createHash("sha256").update(value, "utf8").digest("base64url")
    : createHash("sha256").update(value).digest("base64url");
}

/**
 * The `sha256:<base64url>` digest of a bearer token, stored in place of the
 * token itself. Enrollment compares the digest it computes against the one a
 * Host persisted, so this spelling — prefix included — is a stored contract.
 */
export function tokenDigest(token: string): string {
  return `sha256:${sha256Base64Url(token)}`;
}

/**
 * The `sha256:<base64url>` fingerprint of an Ed25519 public key, taken over its
 * canonical DER SPKI encoding so two spellings of the same key — PEM, DER, a
 * live `KeyObject` — always fingerprint identically.
 */
export function ed25519SpkiFingerprint(publicKey: KeyObject): string {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("An SPKI fingerprint requires an Ed25519 public key");
  }
  return `sha256:${sha256Base64Url(publicKey.export({ format: "der", type: "spki" }))}`;
}
