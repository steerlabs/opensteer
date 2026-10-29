import { ed25519 } from "@noble/curves/ed25519.js";
import { personalHostAccessRouteSigningBytes } from "@opensteer/control-plane-protocol";
import type { PersonalHostAccessRouteEnvelope } from "@opensteer/control-plane-protocol";
import {
  HostDescriptorSchema,
  HostDiscoveryDocumentSchema,
  HostDiscoveryEnvelopeSchema,
  hostApiVersion,
  hostDiscoverySigningBytes,
  type HostBootstrapMethod,
  type HostCapability,
  type HostDescriptor,
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { encodeBase64Url } from "@opensteer/shared/base64url";

/** The fixed DER prefix of an Ed25519 SubjectPublicKeyInfo. */
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

export interface TestHostAuthorityKeys {
  readonly secretKey: Uint8Array;
  readonly spki: string;
}

/**
 * A syntactically valid, deliberately unsigned Host discovery envelope.
 *
 * Every test that needs a catalog connection needs one of these, in this
 * package and in the applications that compose it, so it has exactly one home.
 * It is not a signing helper: the signature bytes are filler, and anything
 * that actually verifies a signature must use `testHostAuthorityKeys` and
 * `signTestDiscoveryEnvelope` instead.
 */
export function testDiscoveryEnvelope(discoveryInput: unknown): HostDiscoveryEnvelope {
  const discovery = HostDiscoveryDocumentSchema.parse(discoveryInput);
  return HostDiscoveryEnvelopeSchema.parse({
    document: discovery,
    publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
    signature: "A".repeat(86),
  });
}

/** One Host signing identity, in the SPKI spelling the envelopes carry. */
export function testHostAuthorityKeys(): TestHostAuthorityKeys {
  const { publicKey, secretKey } = ed25519.keygen();
  const spki = new Uint8Array(ed25519SpkiPrefix.length + publicKey.length);
  spki.set(ed25519SpkiPrefix);
  spki.set(publicKey, ed25519SpkiPrefix.length);
  return { secretKey, spki: encodeBase64Url(spki) };
}

export function signTestDiscoveryEnvelope(
  discovery: HostDiscoveryDocument,
  keys: TestHostAuthorityKeys,
): HostDiscoveryEnvelope {
  return {
    document: discovery,
    publicKey: { algorithm: "Ed25519", spki: keys.spki },
    signature: encodeBase64Url(ed25519.sign(hostDiscoverySigningBytes(discovery), keys.secretKey)),
  };
}

export function signTestPersonalAccessRoute(
  document: PersonalHostAccessRouteEnvelope["document"],
  keys: TestHostAuthorityKeys,
): PersonalHostAccessRouteEnvelope {
  return {
    document,
    publicKey: { algorithm: "Ed25519", spki: keys.spki },
    schemaVersion: 1,
    signature: encodeBase64Url(
      ed25519.sign(personalHostAccessRouteSigningBytes(document), keys.secretKey),
    ),
  };
}

/**
 * The `/.well-known/opensteer` body a Host on this tree's protocol epoch
 * serves. Tests that need an incompatible Host state the epoch themselves —
 * that is the fact under test — and everything else goes through here so a
 * future bump is one edit rather than one per fake Host.
 */
export function testHostDescriptor(
  authority: HostDiscoveryEnvelope,
  bootstrapMethods: readonly HostBootstrapMethod[] = [],
  capabilities: readonly HostCapability[] = [],
): HostDescriptor {
  return HostDescriptorSchema.parse({
    apiVersion: hostApiVersion,
    authority,
    bootstrapMethods,
    capabilities,
  });
}
