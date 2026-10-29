import { ed25519 } from "@noble/curves/ed25519.js";
import {
  BrowserSourceInvitationSchema,
  browserSourceChallengeBytes,
  browserSourcePairChallengeBytes,
  browserSourceRouteChangedBytes,
  type BrowserSourcePairChallenge,
  browserSourceInvitationPrefix,
  browserSourceInvitationSigningBytes,
  maximumBrowserSourceInvitationLength,
  type BrowserSourceInvitation,
  type BrowserSourceChallenge,
} from "./browser-source.js";
import { decodeBase64Url } from "@opensteer/shared/base64url";
import {
  HostDiscoveryEnvelopeSchema,
  hostDiscoverySigningBytes,
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
} from "./authority.js";
import {
  PersonalHostAccessRouteEnvelopeSchema,
  personalHostAccessRouteSigningBytes,
  type PersonalHostAccessRouteEnvelope,
} from "./personal-access-route.js";

/**
 * Verification runs on every surface that lists a Deployment — the Host, the
 * Desktop, and the client packages a phone bundles — so it is written against
 * `@noble/curves` rather than `node:crypto`. One implementation of a signature
 * check is worth a dependency; two would be a security hazard.
 */

/**
 * The canonical DER SubjectPublicKeyInfo of an Ed25519 key is a fixed 12-byte
 * prefix — SEQUENCE, AlgorithmIdentifier SEQUENCE holding OID 1.3.101.112, and
 * a BIT STRING with no unused bits — followed by the 32 key bytes. There is
 * exactly one such spelling, so comparing the prefix and re-deriving the key is
 * the whole parse, and anything else is a different algorithm or a re-encoding
 * that must not fingerprint as this key.
 */
const ed25519SpkiPrefix = Uint8Array.of(
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
);
const ed25519SpkiLength = ed25519SpkiPrefix.length + 32;
const ed25519SignatureLength = 64;

type Ed25519PublicKeyResult =
  | { readonly kind: "ok"; readonly key: Uint8Array }
  /** Not the one canonical base64url spelling of its own bytes. */
  | { readonly kind: "not-canonical" }
  /** Canonical base64url, but not the size of any SubjectPublicKeyInfo we accept. */
  | { readonly kind: "invalid" }
  /** SubjectPublicKeyInfo-shaped, naming an algorithm other than Ed25519. */
  | { readonly kind: "not-ed25519" };

export function verifyHostDiscoveryEnvelope(input: HostDiscoveryEnvelope): HostDiscoveryDocument {
  const envelope = HostDiscoveryEnvelopeSchema.parse(input);
  const publicKey = ed25519PublicKeyFromSpki(envelope.publicKey.spki);
  switch (publicKey.kind) {
    case "not-canonical":
      throw new Error("Host discovery public key is not canonical.");
    case "invalid":
      throw new Error("Host discovery public key is invalid.");
    case "not-ed25519":
      throw new Error("Host discovery public key must be Ed25519.");
    case "ok":
      break;
  }
  const signature = ed25519SignatureFrom(envelope.signature);
  if (
    signature === null ||
    !verifyEd25519(signature, hostDiscoverySigningBytes(envelope.document), publicKey.key)
  ) {
    throw new Error("Host discovery signature is invalid.");
  }
  return envelope.document;
}

export function verifyBrowserSourceChallenge(
  input: BrowserSourceChallenge & {
    readonly authority: HostDiscoveryEnvelope;
    readonly signature: string;
  },
): boolean {
  const key = ed25519PublicKeyFromSpki(input.authority.publicKey.spki);
  const signature = ed25519SignatureFrom(input.signature);
  return (
    key.kind === "ok" &&
    signature !== null &&
    verifyEd25519(
      signature,
      browserSourceChallengeBytes({
        sourceId: input.sourceId,
        nonce: input.nonce,
        origin: input.origin,
        routeGeneration: input.routeGeneration,
      }),
      key.key,
    )
  );
}

export function verifyBrowserSourcePairChallenge(
  input: BrowserSourcePairChallenge & {
    readonly authority: HostDiscoveryEnvelope;
    readonly signature: string;
  },
): boolean {
  return verifyHostSignature(
    input.authority,
    input.signature,
    browserSourcePairChallengeBytes({
      nonce: input.nonce,
      origin: input.origin,
      routeGeneration: input.routeGeneration,
    }),
  );
}

export function verifyBrowserSourceRouteChanged(
  input: BrowserSourceChallenge & {
    readonly authority: HostDiscoveryEnvelope;
    readonly signature: string;
  },
): boolean {
  return verifyHostSignature(
    input.authority,
    input.signature,
    browserSourceRouteChangedBytes({
      sourceId: input.sourceId,
      nonce: input.nonce,
      origin: input.origin,
      routeGeneration: input.routeGeneration,
    }),
  );
}

function verifyHostSignature(
  authority: HostDiscoveryEnvelope,
  encodedSignature: string,
  bytes: Uint8Array,
): boolean {
  const key = ed25519PublicKeyFromSpki(authority.publicKey.spki);
  const signature = ed25519SignatureFrom(encodedSignature);
  return key.kind === "ok" && signature !== null && verifyEd25519(signature, bytes, key.key);
}

export function decodeBrowserSourceInvitation(value: string): BrowserSourceInvitation {
  const encoded = value.trim();
  if (
    !encoded.startsWith(browserSourceInvitationPrefix) ||
    encoded.length > maximumBrowserSourceInvitationLength
  ) {
    throw new Error("This isn't an Opensteer connection link. Start again from Opensteer.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        decodeBase64Url(encoded.slice(browserSourceInvitationPrefix.length)),
      ),
    );
  } catch {
    throw new Error("This connection link is damaged. Start again from Opensteer.");
  }
  const parsed = BrowserSourceInvitationSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("This connection link is from a different Opensteer version. Update both.");
  }
  const invitation = parsed.data;
  verifyHostDiscoveryEnvelope(invitation.authority);
  const origins = new Set<string>();
  for (const destination of invitation.destinations) {
    if (origins.has(destination.origin)) {
      throw new Error("This connection link lists the same address twice.");
    }
    origins.add(destination.origin);
    if (destination.route) {
      const route = verifyPersonalHostAccessRouteEnvelope(destination.route);
      const expectedAuthority = hostDiscoverySigningBytes(invitation.authority.document);
      const routeAuthority = hostDiscoverySigningBytes(route.document.authority);
      if (
        route.publicKey.spki !== invitation.authority.publicKey.spki ||
        expectedAuthority.byteLength !== routeAuthority.byteLength ||
        expectedAuthority.some((byte, index) => byte !== routeAuthority[index]) ||
        route.document.route.origin !== destination.origin
      ) {
        throw new Error("This connection link names a different Opensteer address.");
      }
    } else if (destination.origin !== invitation.authority.document.canonicalOrigin) {
      throw new Error("A remote connection address must include its signed Opensteer route.");
    }
  }
  const key = ed25519PublicKeyFromSpki(invitation.authority.publicKey.spki);
  const signature = ed25519SignatureFrom(invitation.signature);
  const { signature: _signature, ...document } = invitation;
  if (
    key.kind !== "ok" ||
    signature === null ||
    !verifyEd25519(signature, browserSourceInvitationSigningBytes(document), key.key)
  ) {
    throw new Error("This connection link doesn't match its Opensteer.");
  }
  if (Date.parse(invitation.expiresAt) <= Date.now()) {
    throw new Error(
      "This connection link expired. Go back to Opensteer and choose Connect Chrome again.",
    );
  }
  return invitation;
}

/** Verify a Personal remote route against the durable loopback Host authority. */
export function verifyPersonalHostAccessRouteEnvelope(
  input: PersonalHostAccessRouteEnvelope,
): PersonalHostAccessRouteEnvelope {
  const envelope = PersonalHostAccessRouteEnvelopeSchema.parse(input);
  const publicKey = ed25519PublicKeyFromSpki(envelope.publicKey.spki);
  const signature = ed25519SignatureFrom(envelope.signature);
  if (publicKey.kind === "not-canonical" || signature === null) {
    throw new Error("Personal access-route signature is invalid.");
  }
  switch (publicKey.kind) {
    // The route envelope pins `spki` to exactly 59 characters, so the only
    // remaining way to miss is to name another algorithm.
    case "invalid":
    case "not-ed25519":
      throw new Error("Personal access-route public key must be Ed25519.");
    case "ok":
      break;
  }
  if (
    !verifyEd25519(signature, personalHostAccessRouteSigningBytes(envelope.document), publicKey.key)
  ) {
    throw new Error("Personal access-route signature is invalid.");
  }
  return envelope;
}

function ed25519PublicKeyFromSpki(spki: string): Ed25519PublicKeyResult {
  const der = canonicalBytes(spki);
  if (der === null) return { kind: "not-canonical" };
  if (der.byteLength !== ed25519SpkiLength) return { kind: "invalid" };
  for (const [index, byte] of ed25519SpkiPrefix.entries()) {
    if (der[index] !== byte) return { kind: "not-ed25519" };
  }
  return { kind: "ok", key: der.subarray(ed25519SpkiPrefix.length) };
}

function ed25519SignatureFrom(signature: string): Uint8Array | null {
  const bytes = canonicalBytes(signature);
  return bytes !== null && bytes.byteLength === ed25519SignatureLength ? bytes : null;
}

function canonicalBytes(value: string): Uint8Array | null {
  try {
    return decodeBase64Url(value);
  } catch {
    return null;
  }
}

/**
 * Strict RFC 8032, not noble's default ZIP215: a Host signs with Node's
 * `crypto.sign`, whose verifier is strict, and the relaxed cofactored equation
 * would let a client accept signatures the Host that issued them would reject.
 * Malformed key or signature encodings raise inside the library, and a
 * rejection is what the caller asked for, not a crash.
 */
function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
