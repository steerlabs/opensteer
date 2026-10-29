import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HostDiscoveryEnvelopeSchema,
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteDocumentSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  hostDiscoverySigningBytes,
  hostKeyFingerprint,
  personalHostAccessRouteSigningBytes,
  verifyHostDiscoveryEnvelope,
  verifyPersonalHostAccessRouteEnvelope,
  type HostDiscoveryEnvelope,
  type PersonalHostAccessRouteEnvelope,
} from "./index.js";

/**
 * Verification moved from `node:crypto` to `@noble/curves` so the same code
 * runs in a client bundle. Every Host in the field signs with `node:crypto`,
 * so the fixtures here are generated that way on purpose: they are the proof
 * that the new verifier accepts exactly the old signatures and exactly the old
 * fingerprint bytes, and nothing looser.
 */

const authorityDocument = PersonalHostAccessAuthoritySchema.parse({
  canonicalOrigin: "http://127.0.0.1:4310",
  deploymentId: "dep_66666666-6666-4666-8666-666666666666",
  hostInstanceId: "hst_77777777-7777-4777-8777-777777777777",
  hostKey: { algorithm: "Ed25519" },
  deploymentShape: {
    defaultWorkspaceBacking: "portablefs",
    kind: "personal" as const,
  },
});

/**
 * The eight points of Ed25519's torsion subgroup. A public key and an `R` drawn
 * from it with `S = 0` satisfies the cofactored equation ZIP215 checks and
 * fails the cofactorless one RFC 8032 mandates, so it is the fixture that
 * proves `zip215: false` is actually selected.
 */
const torsionPoint = "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a";
const identityPoint = "0100000000000000000000000000000000000000000000000000000000000000";

describe("Ed25519 verification against node:crypto fixtures", () => {
  it("accepts Host-signed envelopes and fingerprints their keys byte-identically", () => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const keys = generateKeyPairSync("ed25519");
      const spki = keys.publicKey.export({ format: "der", type: "spki" });

      expect(verifyHostDiscoveryEnvelope(discoveryEnvelope(keys))).toEqual(authorityDocument);
      expect(verifyPersonalHostAccessRouteEnvelope(routeEnvelope(keys))).toEqual(
        routeEnvelope(keys),
      );
      expect(hostKeyFingerprint(spki.toString("base64url"))).toBe(
        `sha256:${createHash("sha256").update(spki).digest("base64url")}`,
      );
    }
  });

  it("rejects a non-canonical base64url spelling of the same bytes", () => {
    const keys = generateKeyPairSync("ed25519");
    const envelope = discoveryEnvelope(keys);
    const route = routeEnvelope(keys);

    // The trailing sextet of a 44-byte key carries two bits no encoder sets.
    expect(() =>
      verifyHostDiscoveryEnvelope({
        ...envelope,
        publicKey: { ...envelope.publicKey, spki: withTrailingBits(envelope.publicKey.spki) },
      }),
    ).toThrow("Host discovery public key is not canonical.");
    // The same for the four spare bits of a 64-byte signature.
    expect(() =>
      verifyHostDiscoveryEnvelope({
        ...envelope,
        signature: withTrailingBits(envelope.signature),
      }),
    ).toThrow("Host discovery signature is invalid.");
    expect(() =>
      verifyPersonalHostAccessRouteEnvelope({
        ...route,
        publicKey: { ...route.publicKey, spki: withTrailingBits(route.publicKey.spki) },
      }),
    ).toThrow("Personal access-route signature is invalid.");

    // Padding and the standard alphabet never reach the decoder: the envelope
    // schemas admit unpadded base64url only.
    for (const spelling of [
      `${envelope.publicKey.spki}=`,
      envelope.publicKey.spki.replace(/.$/u, "+"),
      envelope.publicKey.spki.replace(/.$/u, "/"),
    ]) {
      expect(() =>
        verifyHostDiscoveryEnvelope({
          ...envelope,
          publicKey: { ...envelope.publicKey, spki: spelling },
        }),
      ).toThrow();
    }
  });

  it("rejects a truncated or oversized signature", () => {
    const keys = generateKeyPairSync("ed25519");
    const envelope = discoveryEnvelope(keys);

    expect(() =>
      verifyHostDiscoveryEnvelope({ ...envelope, signature: envelope.signature.slice(0, 85) }),
    ).toThrow();
    expect(() =>
      verifyHostDiscoveryEnvelope({ ...envelope, signature: `${envelope.signature}A` }),
    ).toThrow();
  });

  it("rejects a SubjectPublicKeyInfo that is not Ed25519", () => {
    const keys = generateKeyPairSync("ed25519");
    const envelope = discoveryEnvelope(keys);
    const route = routeEnvelope(keys);
    const x25519 = encodedSpki(generateKeyPairSync("x25519").publicKey);
    const p256 = encodedSpki(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey);
    const rsa = encodedSpki(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey);

    // Same 44-byte shape, different algorithm OID.
    expect(() =>
      verifyHostDiscoveryEnvelope({
        ...envelope,
        publicKey: { ...envelope.publicKey, spki: x25519 },
      }),
    ).toThrow("Host discovery public key must be Ed25519.");
    expect(() =>
      verifyPersonalHostAccessRouteEnvelope({
        ...route,
        publicKey: { ...route.publicKey, spki: x25519 },
      }),
    ).toThrow("Personal access-route public key must be Ed25519.");
    // A P-256 SPKI is 91 bytes, so it is not a key this verifier can parse.
    expect(() =>
      verifyHostDiscoveryEnvelope({
        ...envelope,
        publicKey: { ...envelope.publicKey, spki: p256 },
      }),
    ).toThrow("Host discovery public key is invalid.");
    // An RSA SPKI overflows the envelope schema's key-length bound.
    expect(() =>
      verifyHostDiscoveryEnvelope({ ...envelope, publicKey: { ...envelope.publicKey, spki: rsa } }),
    ).toThrow();
  });

  it("rejects a torsion-subgroup signature that only ZIP215 would accept", () => {
    const keys = generateKeyPairSync("ed25519");
    const envelope = discoveryEnvelope(keys);
    const route = routeEnvelope(keys);
    const torsionSpki = spkiForRawKey(torsionPoint);
    const cofactoredSignature = base64Url(`${identityPoint}${"00".repeat(32)}`);

    expect(() =>
      verifyHostDiscoveryEnvelope({
        ...envelope,
        publicKey: { ...envelope.publicKey, spki: torsionSpki },
        signature: cofactoredSignature,
      }),
    ).toThrow("Host discovery signature is invalid.");
    expect(() =>
      verifyPersonalHostAccessRouteEnvelope({
        ...route,
        publicKey: { ...route.publicKey, spki: torsionSpki },
        signature: cofactoredSignature,
      }),
    ).toThrow("Personal access-route signature is invalid.");
  });
});

function discoveryEnvelope(keys: {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}): HostDiscoveryEnvelope {
  return HostDiscoveryEnvelopeSchema.parse({
    document: authorityDocument,
    publicKey: { algorithm: "Ed25519", spki: encodedSpki(keys.publicKey) },
    signature: sign(null, hostDiscoverySigningBytes(authorityDocument), keys.privateKey).toString(
      "base64url",
    ),
  });
}

function routeEnvelope(keys: {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}): PersonalHostAccessRouteEnvelope {
  const routeDocument = PersonalHostAccessRouteDocumentSchema.parse({
    authority: authorityDocument,
    documentVersion: 2,
    purpose: "opensteer-personal-access-route",
    route: {
      generation: 3,
      kind: "connect",
      origin: "https://connect-verification.opensteer.test",
    },
  });
  return PersonalHostAccessRouteEnvelopeSchema.parse({
    document: routeDocument,
    publicKey: { algorithm: "Ed25519", spki: encodedSpki(keys.publicKey) },
    schemaVersion: 1,
    signature: sign(
      null,
      personalHostAccessRouteSigningBytes(routeDocument),
      keys.privateKey,
    ).toString("base64url"),
  });
}

function encodedSpki(publicKey: KeyObject): string {
  return publicKey.export({ format: "der", type: "spki" }).toString("base64url");
}

function spkiForRawKey(rawKeyHex: string): string {
  return base64Url(`302a300506032b6570032100${rawKeyHex}`);
}

function base64Url(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64url");
}

/**
 * Sets bits in the final sextet that no encoder emits, so the string decodes
 * to the same bytes under a lenient decoder and to nothing under a strict one.
 */
function withTrailingBits(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith("B") ? "C" : "B"}`;
}
