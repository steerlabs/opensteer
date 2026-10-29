import { sha256 } from "@noble/hashes/sha2.js";
import { HostKeyFingerprintSchema, type HostKeyFingerprint } from "@opensteer/core";
import { decodeBase64Url, encodeBase64Url } from "@opensteer/shared/base64url";
import type { HostDiscoveryEnvelope } from "./authority.js";

/**
 * `sha256:` plus unpadded base64url of SHA-256 over the raw SPKI DER bytes.
 * Accounts pin this string and Desktops compare it, so the bytes are a
 * compatibility contract with every Host already in the field; the hash is
 * taken with `@noble/hashes` only so the same function runs in a client
 * bundle, where `node:crypto` does not exist.
 */
export function hostKeyFingerprint(spki: string): HostKeyFingerprint {
  return HostKeyFingerprintSchema.parse(`sha256:${encodeBase64Url(sha256(decodeBase64Url(spki)))}`);
}

export interface HostIdentityReference {
  readonly deploymentId: string;
  readonly hostInstanceId: string;
  readonly hostKeyFingerprint: string;
}

export function isSameHost(
  left: HostDiscoveryEnvelope | HostIdentityReference,
  right: HostDiscoveryEnvelope | HostIdentityReference,
): boolean {
  const leftIdentity = hostIdentityReference(left);
  const rightIdentity = hostIdentityReference(right);
  return (
    leftIdentity.deploymentId === rightIdentity.deploymentId &&
    leftIdentity.hostInstanceId === rightIdentity.hostInstanceId &&
    leftIdentity.hostKeyFingerprint === rightIdentity.hostKeyFingerprint
  );
}

function hostIdentityReference(
  identity: HostDiscoveryEnvelope | HostIdentityReference,
): HostIdentityReference {
  return "document" in identity
    ? {
        deploymentId: identity.document.deploymentId,
        hostInstanceId: identity.document.hostInstanceId,
        hostKeyFingerprint: hostKeyFingerprint(identity.publicKey.spki),
      }
    : identity;
}
