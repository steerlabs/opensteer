import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import * as frozen from "@opensteer/browser-source-wire/frozen";
import {
  BrowserSourceIdSchema,
  CanonicalOriginSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  IsoDateTimeSchema,
  isLoopbackHostname,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  BrowserSourceOriginSchema,
  HostCapabilitySchema,
  HostDescriptorSchema,
  HostDiscoveryEnvelopeSchema,
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteDocumentSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  browserSourceChallengeBytes,
  browserSourceInvitationSigningBytes,
  browserSourcePairChallengeBytes,
  browserSourceRouteChangedBytes,
  decodeBrowserSourceInvitation,
  encodeBrowserSourceInvitation,
  hostApiVersion,
  hostDiscoverySigningBytes,
  personalHostAccessRouteSigningBytes,
  type BrowserSourceInvitationDocument,
  type HostDiscoveryEnvelope,
  type PersonalHostAccessRouteEnvelope,
} from "./index.js";

/**
 * Shipped extensions parse and verify these documents with the copies in
 * `@opensteer/browser-source-wire/frozen`. What this package builds and signs
 * must pass those copies byte for byte, or every installed extension breaks.
 */

const authorityDocument = PersonalHostAccessAuthoritySchema.parse({
  canonicalOrigin: "http://127.0.0.1:4310",
  deploymentId: "dep_66666666-6666-4666-8666-666666666666",
  hostInstanceId: "hst_77777777-7777-4777-8777-777777777777",
  hostKey: { algorithm: "Ed25519" },
  deploymentShape: { kind: "personal" as const },
});
const routeOrigin = "https://connect-frozen.opensteer.test";

describe("documents this tree signs, read by a shipped extension", () => {
  it("parse and verify under the frozen copies with identical signing bytes", () => {
    const keys = generateKeyPairSync("ed25519");
    const authority = discoveryEnvelope(keys);
    const route = routeEnvelope(keys);

    expect(frozen.HostDiscoveryEnvelopeSchema.parse(authority)).toEqual(authority);
    expect(frozen.hostDiscoverySigningBytes(authority.document)).toEqual(
      hostDiscoverySigningBytes(authority.document),
    );
    expect(frozen.verifyHostDiscoveryEnvelope(authority)).toEqual(authority.document);

    expect(frozen.PersonalHostAccessRouteEnvelopeSchema.parse(route)).toEqual(route);
    expect(frozen.personalHostAccessRouteSigningBytes(route.document)).toEqual(
      personalHostAccessRouteSigningBytes(route.document),
    );
    expect(frozen.verifyPersonalHostAccessRouteEnvelope(route)).toEqual(route);

    const descriptor = HostDescriptorSchema.parse({
      kind: "personal",
      apiVersion: hostApiVersion,
      authority,
      bootstrapMethods: ["pairing-code", "connect-grant", "password", "oidc"],
      capabilities: HostCapabilitySchema.options,
    });
    expect(frozen.HostDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });

  it("decode a v2 invitation exactly as this tree does", () => {
    const keys = generateKeyPairSync("ed25519");
    const authority = discoveryEnvelope(keys);
    const document: BrowserSourceInvitationDocument = {
      version: 2,
      destinations: [
        { origin: authorityDocument.canonicalOrigin, route: null },
        { origin: routeOrigin, route: routeEnvelope(keys) },
      ],
      deploymentName: "Tim's Mac",
      code: "c".repeat(43),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      authority,
    };
    const bytes = browserSourceInvitationSigningBytes(document);
    expect(frozen.browserSourceInvitationSigningBytes(document)).toEqual(bytes);
    const encoded = encodeBrowserSourceInvitation({
      ...document,
      signature: sign(null, bytes, keys.privateKey).toString("base64url"),
    });

    expect(frozen.decodeBrowserSourceInvitation(encoded)).toEqual(
      decodeBrowserSourceInvitation(encoded),
    );
    const tampered = encodeBrowserSourceInvitation({
      ...document,
      deploymentName: "Someone else",
      signature: sign(null, bytes, keys.privateKey).toString("base64url"),
    });
    expect(() => frozen.decodeBrowserSourceInvitation(tampered)).toThrow(
      "This connection link doesn't match its Opensteer.",
    );
  });

  it("verify the challenge, pair-challenge and route-changed signatures the Host makes", () => {
    const keys = generateKeyPairSync("ed25519");
    const authority = discoveryEnvelope(keys);
    const challenge = {
      origin: routeOrigin,
      routeGeneration: 3,
      sourceId: BrowserSourceIdSchema.parse("bsr_88888888-8888-4888-8888-888888888888"),
      nonce: randomUUID(),
    };
    const signed = (bytes: Uint8Array) => sign(null, bytes, keys.privateKey).toString("base64url");

    const proof = signed(browserSourceChallengeBytes(challenge));
    expect(frozen.verifyBrowserSourceChallenge({ ...challenge, authority, signature: proof })).toBe(
      true,
    );
    expect(
      frozen.verifyBrowserSourceRouteChanged({ ...challenge, authority, signature: proof }),
    ).toBe(false);
    expect(
      frozen.verifyBrowserSourceRouteChanged({
        ...challenge,
        authority,
        signature: signed(browserSourceRouteChangedBytes(challenge)),
      }),
    ).toBe(true);
    const { sourceId: _sourceId, ...pair } = challenge;
    expect(
      frozen.verifyBrowserSourcePairChallenge({
        ...pair,
        authority,
        signature: signed(browserSourcePairChallengeBytes(pair)),
      }),
    ).toBe(true);
  });
});

describe("frozen primitives agree with core", () => {
  it.each([
    ["bsr_88888888-8888-4888-8888-888888888888"],
    ["BSR_88888888-8888-4888-8888-888888888888"],
    ["bsr_88888888-8888-9888-8888-888888888888"],
    ["dep_66666666-6666-4666-8666-666666666666"],
    ["hst_77777777-7777-4777-8777-777777777777"],
    ["hst_77777777-7777-4777-8777-77777777777"],
    [""],
  ])("on the ID %j", (value) => {
    expect(frozen.BrowserSourceIdSchema.safeParse(value).success).toBe(
      BrowserSourceIdSchema.safeParse(value).success,
    );
    expect(frozen.DeploymentIdSchema.safeParse(value).success).toBe(
      DeploymentIdSchema.safeParse(value).success,
    );
    expect(frozen.HostInstanceIdSchema.safeParse(value).success).toBe(
      HostInstanceIdSchema.safeParse(value).success,
    );
  });

  it.each([
    ["http://127.0.0.1:4310"],
    ["https://example.com"],
    ["https://example.com/"],
    ["https://example.com/path"],
    ["https://user:pass@example.com"],
    ["https://example.com?x=1"],
    ["HTTPS://EXAMPLE.COM"],
    ["http://localhost:80"],
    ["http://[::1]:4310"],
    ["http://10.0.0.2:4310"],
    ["http://app.localhost:4310"],
    ["ftp://example.com"],
    ["not a url"],
  ])("on the origin %j", (value) => {
    expect(outcome(frozen.CanonicalOriginSchema, value)).toBe(
      outcome(CanonicalOriginSchema, value),
    );
    // Both refinements run after a failed URL check and throw alike.
    expect(outcome(frozen.BrowserSourceOriginSchema, value)).toBe(
      outcome(BrowserSourceOriginSchema, value),
    );
  });

  it.each([
    ["localhost"],
    ["LOCALHOST."],
    ["app.localhost"],
    [".localhost"],
    ["127.1.2.3"],
    ["[::1]"],
    ["0:0:0:0:0:0:0:1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:10.0.0.1"],
    ["0.0.0.0"],
    ["256.0.0.1"],
    ["example.com"],
  ])("on the hostname %j", (value) => {
    expect(frozen.isLoopbackHostname(value)).toBe(isLoopbackHostname(value));
  });

  it.each([
    ["2026-11-12T10:00:00.000Z"],
    ["2026-11-12T10:00Z"],
    ["2024-02-29T00:00:00+05:30"],
    ["2026-02-29T00:00:00Z"],
    ["2026-11-12 10:00:00Z"],
    ["2026-11-12T10:00:00"],
  ])("on the instant %j", (value) => {
    expect(frozen.IsoDateTimeSchema.safeParse(value).success).toBe(
      IsoDateTimeSchema.safeParse(value).success,
    );
  });
});

function outcome(schema: z.ZodType, value: unknown): boolean | "throws" {
  try {
    return schema.safeParse(value).success;
  } catch {
    return "throws";
  }
}

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
    route: { generation: 3, kind: "connect", origin: routeOrigin },
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
