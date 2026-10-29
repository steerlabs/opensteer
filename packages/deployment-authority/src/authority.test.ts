import { createHash, generateKeyPairSync, sign, webcrypto, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HostDiscoveryDocumentSchema,
  HostDiscoveryEnvelopeSchema,
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteDocumentSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  HostDescriptorSchema,
  hostApiCompatibility,
  hostApiVersion,
  hostDiscoverySigningBytes,
  hostDiscoveryDefaultWorkspaceBacking,
  knownHostCapabilities,
  hostAuthorityIdentityMatches,
  isSameHost,
  personalHostAccessRouteEnvelopeSha256,
  personalHostAccessRouteSigningBytes,
  sameDiscoveryDocument,
  verifyHostDiscoveryEnvelope,
  verifyPersonalHostAccessRouteEnvelope,
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
  type PersonalHostAccessRouteEnvelope,
} from "./index.js";

const fixedAuthority = PersonalHostAccessAuthoritySchema.parse({
  canonicalOrigin: "http://127.0.0.1:4310",
  deploymentId: "dep_11111111-1111-4111-8111-111111111111",
  hostInstanceId: "hst_22222222-2222-4222-8222-222222222222",
  hostKey: { algorithm: "Ed25519" },
  deploymentShape: {
    defaultWorkspaceBacking: "local-directory",
    kind: "personal" as const,
  },
});

const fixedRoute = PersonalHostAccessRouteDocumentSchema.parse({
  authority: fixedAuthority,
  documentVersion: 2,
  purpose: "opensteer-personal-access-route",
  route: {
    generation: 9,
    kind: "connect",
    origin: "https://connect-fixture.opensteer.test",
  },
});

describe("signing corpus", () => {
  it("keeps the complete Host discovery signing bytes byte-identical", () => {
    expect(new TextDecoder().decode(hostDiscoverySigningBytes(fixedAuthority))).toBe(
      'opensteer-host-discovery-v4\0{"canonicalOrigin":"http://127.0.0.1:4310","deploymentId":"dep_11111111-1111-4111-8111-111111111111","hostInstanceId":"hst_22222222-2222-4222-8222-222222222222","hostKey":{"algorithm":"Ed25519"},"deploymentShape":{"defaultWorkspaceBacking":"local-directory","kind":"personal"}}',
    );
  });

  it("keeps legacy Host and Personal route signing bytes byte-identical", () => {
    const authority = HostDiscoveryDocumentSchema.parse({
      ...fixedAuthority,
      deploymentShape: { backing: "local-directory", kind: "personal" },
    });
    const route = PersonalHostAccessRouteDocumentSchema.parse({ ...fixedRoute, authority });

    expect(new TextDecoder().decode(hostDiscoverySigningBytes(authority))).toBe(
      'opensteer-host-discovery-v4\0{"canonicalOrigin":"http://127.0.0.1:4310","deploymentId":"dep_11111111-1111-4111-8111-111111111111","hostInstanceId":"hst_22222222-2222-4222-8222-222222222222","hostKey":{"algorithm":"Ed25519"},"deploymentShape":{"backing":"local-directory","kind":"personal"}}',
    );
    expect(new TextDecoder().decode(personalHostAccessRouteSigningBytes(route))).toBe(
      'opensteer-personal-access-route-v4\0{"authority":{"canonicalOrigin":"http://127.0.0.1:4310","deploymentId":"dep_11111111-1111-4111-8111-111111111111","hostInstanceId":"hst_22222222-2222-4222-8222-222222222222","hostKey":{"algorithm":"Ed25519"},"deploymentShape":{"backing":"local-directory","kind":"personal"}},"documentVersion":2,"purpose":"opensteer-personal-access-route","route":{"generation":9,"kind":"connect","origin":"https://connect-fixture.opensteer.test"}}',
    );
  });

  it("rejects a discovery shape containing both backing field names", () => {
    expect(() =>
      HostDiscoveryDocumentSchema.parse({
        ...fixedAuthority,
        deploymentShape: {
          backing: "local-directory",
          defaultWorkspaceBacking: "local-directory",
          kind: "personal",
        },
      }),
    ).toThrow();
  });

  it("keeps the complete Personal access-route signing bytes byte-identical", () => {
    expect(new TextDecoder().decode(personalHostAccessRouteSigningBytes(fixedRoute))).toBe(
      'opensteer-personal-access-route-v4\0{"authority":{"canonicalOrigin":"http://127.0.0.1:4310","deploymentId":"dep_11111111-1111-4111-8111-111111111111","hostInstanceId":"hst_22222222-2222-4222-8222-222222222222","hostKey":{"algorithm":"Ed25519"},"deploymentShape":{"defaultWorkspaceBacking":"local-directory","kind":"personal"}},"documentVersion":2,"purpose":"opensteer-personal-access-route","route":{"generation":9,"kind":"connect","origin":"https://connect-fixture.opensteer.test"}}',
    );
  });

  it("keeps the Personal access-route envelope digest byte-identical", () => {
    const envelope = PersonalHostAccessRouteEnvelopeSchema.parse({
      document: fixedRoute,
      publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
      schemaVersion: 1,
      signature: "B".repeat(86),
    });
    expect(personalHostAccessRouteEnvelopeSha256(envelope)).toBe(
      "ACnhtJ4UiqlWsVrx3iWZ6CGOSMiCpXFj89sGPnQ8gNo",
    );
    expect(
      personalHostAccessRouteEnvelopeSha256({
        signature: envelope.signature,
        schemaVersion: envelope.schemaVersion,
        publicKey: envelope.publicKey,
        document: envelope.document,
      }),
    ).toBe("ACnhtJ4UiqlWsVrx3iWZ6CGOSMiCpXFj89sGPnQ8gNo");
  });

  it("agrees with Web Crypto, which is what a Host and an Account already ran", async () => {
    // The digest moved off `crypto.subtle` so it can run on a phone, where
    // Hermes has no Web Crypto at all. The grants already issued pin these
    // bytes, so the replacement is only correct if it is the same hash of the
    // same input — which is what this compares, through the one function that
    // still knows how the input is built.
    const envelope = PersonalHostAccessRouteEnvelopeSchema.parse({
      document: fixedRoute,
      publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
      schemaVersion: 1,
      signature: "B".repeat(86),
    });
    const preimage = preimageOf(envelope);
    const node = new Uint8Array(createHash("sha256").update(preimage).digest());
    const subtle = new Uint8Array(await webcrypto.subtle.digest("SHA-256", preimage));

    expect(node).toEqual(subtle);
    expect(personalHostAccessRouteEnvelopeSha256(envelope)).toBe(
      Buffer.from(node).toString("base64url"),
    );
  });
});

/**
 * The exact bytes the digest is taken over, spelled out independently of the
 * implementation so the comparison above is a check rather than a tautology.
 */
function preimageOf(envelope: PersonalHostAccessRouteEnvelope): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `opensteer-personal-access-route-envelope-v4\0${JSON.stringify({
      document: {
        authority: {
          canonicalOrigin: envelope.document.authority.canonicalOrigin,
          deploymentId: envelope.document.authority.deploymentId,
          hostInstanceId: envelope.document.authority.hostInstanceId,
          hostKey: { algorithm: envelope.document.authority.hostKey.algorithm },
          deploymentShape: envelope.document.authority.deploymentShape,
        },
        documentVersion: envelope.document.documentVersion,
        purpose: envelope.document.purpose,
        route: {
          generation: envelope.document.route.generation,
          kind: envelope.document.route.kind,
          origin: envelope.document.route.origin,
        },
      },
      publicKey: {
        algorithm: envelope.publicKey.algorithm,
        spki: envelope.publicKey.spki,
      },
      schemaVersion: envelope.schemaVersion,
      signature: envelope.signature,
    })}`,
  );
}

describe("Personal Host access authority", () => {
  it.each([
    { canonicalOrigin: "https://personal.example.test" },
    { canonicalOrigin: "http://127.0.0.1" },
    { canonicalOrigin: "http://192.168.1.2:4310" },
    {
      deploymentShape: {
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
    },
  ])("rejects a non-Personal canonical authority %#", (override) => {
    expect(
      PersonalHostAccessAuthoritySchema.safeParse({ ...fixedAuthority, ...override }).success,
    ).toBe(false);
  });

  it("rejects a non-HTTPS or canonical-equivalent access route", () => {
    expect(
      PersonalHostAccessRouteDocumentSchema.safeParse({
        ...fixedRoute,
        route: {
          ...fixedRoute.route,
          origin: fixedRoute.authority.canonicalOrigin,
        },
      }).success,
    ).toBe(false);
  });
});

describe("authority equality and Host identity", () => {
  const current = HostDiscoveryDocumentSchema.parse(fixedAuthority);

  it("includes Host identity in authority equality", () => {
    const hostChanged = HostDiscoveryDocumentSchema.parse({
      ...current,
      hostInstanceId: "hst_33333333-3333-4333-8333-333333333333",
    });
    expect(sameDiscoveryDocument(current, hostChanged)).toBe(false);
  });

  it("matches the flattened authority identity used by credentials and directory rows", () => {
    const fingerprint = `sha256:${"a".repeat(43)}`;
    expect(
      hostAuthorityIdentityMatches(current, fingerprint, {
        canonicalOrigin: current.canonicalOrigin,
        deploymentId: current.deploymentId,
        hostInstanceId: current.hostInstanceId,
        hostKeyFingerprint: fingerprint,
      }),
    ).toBe(true);
    expect(
      hostAuthorityIdentityMatches(current, fingerprint, {
        canonicalOrigin: current.canonicalOrigin,
        deploymentId: current.deploymentId,
        hostInstanceId: current.hostInstanceId,
        hostKeyFingerprint: `sha256:${"b".repeat(43)}`,
      }),
    ).toBe(false);
  });
});

describe("Ed25519 envelope verification", () => {
  it("verifies legacy backing envelopes without changing their signed bytes", () => {
    const keys = generateKeyPairSync("ed25519");
    const legacyDocument = HostDiscoveryDocumentSchema.parse({
      ...fixedAuthority,
      deploymentShape: { backing: "local-directory", kind: "personal" },
    });
    const legacyEnvelope = HostDiscoveryEnvelopeSchema.parse({
      document: legacyDocument,
      publicKey: { algorithm: "Ed25519", spki: encodedSpki(keys.publicKey) },
      signature: sign(null, hostDiscoverySigningBytes(legacyDocument), keys.privateKey).toString(
        "base64url",
      ),
    });
    const legacyRouteDocument = PersonalHostAccessRouteDocumentSchema.parse({
      ...fixedRoute,
      authority: legacyDocument,
    });
    const legacyRouteEnvelope = PersonalHostAccessRouteEnvelopeSchema.parse({
      document: legacyRouteDocument,
      publicKey: legacyEnvelope.publicKey,
      schemaVersion: 1,
      signature: sign(
        null,
        personalHostAccessRouteSigningBytes(legacyRouteDocument),
        keys.privateKey,
      ).toString("base64url"),
    });

    expect(verifyHostDiscoveryEnvelope(legacyEnvelope)).toEqual(legacyDocument);
    expect(verifyPersonalHostAccessRouteEnvelope(legacyRouteEnvelope)).toEqual(legacyRouteEnvelope);
    expect(hostDiscoveryDefaultWorkspaceBacking(legacyDocument.deploymentShape)).toBe(
      "local-directory",
    );
    expect(sameDiscoveryDocument(legacyDocument, fixedAuthority)).toBe(true);
    expect(() =>
      verifyHostDiscoveryEnvelope({
        ...legacyEnvelope,
        document: {
          ...legacyDocument,
          deploymentShape: { backing: "portablefs", kind: "personal" },
        },
      }),
    ).toThrow("signature is invalid");
  });

  it("verifies Host discovery and rejects document, signature, and key tampering", () => {
    const fixture = signedFixture();
    expect(verifyHostDiscoveryEnvelope(fixture.discovery)).toEqual(fixture.discovery.document);
    expect(() =>
      verifyHostDiscoveryEnvelope({
        ...fixture.discovery,
        document: { ...fixture.discovery.document, canonicalOrigin: "http://localhost:4310" },
      }),
    ).toThrow("signature is invalid");
    expect(() =>
      verifyHostDiscoveryEnvelope({ ...fixture.discovery, signature: "A".repeat(86) }),
    ).toThrow("signature is invalid");
    expect(() =>
      verifyHostDiscoveryEnvelope({
        ...fixture.discovery,
        publicKey: { algorithm: "Ed25519", spki: fixture.wrongSpki },
      }),
    ).toThrow("signature is invalid");
    expect(
      isSameHost(fixture.discovery, {
        ...fixture.discovery,
        signature: "A".repeat(86),
      }),
    ).toBe(true);
    expect(
      isSameHost(fixture.discovery, {
        ...fixture.discovery,
        publicKey: { algorithm: "Ed25519", spki: fixture.wrongSpki },
      }),
    ).toBe(false);
  });

  it("verifies a Personal route and rejects document, signature, and key tampering", () => {
    const fixture = signedFixture();
    expect(verifyPersonalHostAccessRouteEnvelope(fixture.route)).toEqual(fixture.route);
    expect(() =>
      verifyPersonalHostAccessRouteEnvelope({
        ...fixture.route,
        document: {
          ...fixture.route.document,
          route: { ...fixture.route.document.route, generation: 2 },
        },
      }),
    ).toThrow("signature is invalid");
    expect(() =>
      verifyPersonalHostAccessRouteEnvelope({ ...fixture.route, signature: "A".repeat(86) }),
    ).toThrow("signature is invalid");
    expect(() =>
      verifyPersonalHostAccessRouteEnvelope({
        ...fixture.route,
        publicKey: { algorithm: "Ed25519", spki: fixture.wrongSpki },
      }),
    ).toThrow("signature is invalid");
  });
});

describe("Host descriptor", () => {
  it("reads a later Host's added field rather than failing the parse", () => {
    const { discovery } = signedFixture();

    expect(
      HostDescriptorSchema.parse({
        apiVersion: hostApiVersion,
        authority: discovery,
        bootstrapMethods: [],
        capabilities: [],
        somethingAddedLater: true,
      }),
    ).not.toHaveProperty("somethingAddedLater");
  });

  it("names which side is behind, and rejects legacy epochs as too old", () => {
    const { discovery } = signedFixture();
    const descriptor = {
      apiVersion: hostApiVersion,
      authority: discovery,
      bootstrapMethods: [],
      capabilities: [],
    };

    expect(hostApiCompatibility(descriptor)).toBe("compatible");
    expect(hostApiCompatibility({ ...descriptor, apiVersion: hostApiVersion + 1 })).toBe(
      "client-too-old",
    );
    for (const legacyHostApiVersion of Array.from(
      { length: hostApiVersion - 1 },
      (_, index) => index + 1,
    )) {
      expect(hostApiCompatibility({ ...descriptor, apiVersion: legacyHostApiVersion })).toBe(
        "host-too-old",
      );
    }
    expect(hostApiCompatibility({ authority: discovery, bootstrapMethods: [] })).toBe(
      "host-too-old",
    );
  });

  it("keeps the capability names it knows and drops the ones it does not", () => {
    expect(
      knownHostCapabilities([
        "native-oauth",
        "invented-later",
        "ownerViewWindows",
        "browser-target-control-v1",
        "native-oauth",
      ]),
    ).toEqual(["native-oauth", "ownerViewWindows", "browser-target-control-v1"]);
  });
});

function signedFixture(): {
  readonly discovery: HostDiscoveryEnvelope;
  readonly route: PersonalHostAccessRouteEnvelope;
  readonly wrongSpki: string;
} {
  const keys = generateKeyPairSync("ed25519");
  const wrongKeys = generateKeyPairSync("ed25519");
  const authority = authorityForKey();
  const discovery = HostDiscoveryEnvelopeSchema.parse({
    document: authority,
    publicKey: { algorithm: "Ed25519", spki: encodedSpki(keys.publicKey) },
    signature: sign(null, hostDiscoverySigningBytes(authority), keys.privateKey).toString(
      "base64url",
    ),
  });
  const routeDocument = PersonalHostAccessRouteDocumentSchema.parse({
    authority,
    documentVersion: 2,
    purpose: "opensteer-personal-access-route",
    route: {
      generation: 1,
      kind: "connect",
      origin: "https://connect-signature.opensteer.test",
    },
  });
  const route = PersonalHostAccessRouteEnvelopeSchema.parse({
    document: routeDocument,
    publicKey: { algorithm: "Ed25519", spki: encodedSpki(keys.publicKey) },
    schemaVersion: 1,
    signature: sign(
      null,
      personalHostAccessRouteSigningBytes(routeDocument),
      keys.privateKey,
    ).toString("base64url"),
  });
  return { discovery, route, wrongSpki: encodedSpki(wrongKeys.publicKey) };
}

function authorityForKey(): HostDiscoveryDocument {
  return PersonalHostAccessAuthoritySchema.parse({
    canonicalOrigin: "http://127.0.0.1:4310",
    deploymentId: "dep_44444444-4444-4444-8444-444444444444",
    hostInstanceId: "hst_55555555-5555-4555-8555-555555555555",
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: {
      defaultWorkspaceBacking: "local-directory",
      kind: "personal" as const,
    },
  });
}

function encodedSpki(publicKey: KeyObject): string {
  return publicKey.export({ format: "der", type: "spki" }).toString("base64url");
}
