import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  AccountHostSessionGrantClaimsSchema,
  IssuePersonalAccountHostSessionGrantRequestSchema,
  accountHostSessionGrantLifetimeSeconds,
} from "./index.js";

const issuedAt = 1_700_000_000;
const accountId = `acct_${crypto.randomUUID()}`;
const accountIssuer = "https://account.opensteer.test";
const personalAuthority = authority("http://127.0.0.1:4310");

describe("Account Host session grants", () => {
  it("represents the Personal Connect grant", () => {
    expect(AccountHostSessionGrantClaimsSchema.parse(personalClaims())).toMatchObject({
      routeGeneration: 4,
      targetKind: "personal-connect",
    });
  });

  it.each([
    ["Personal without a route", () => omit(personalClaims(), "route")],
    [
      "Desktop with a portal origin",
      () => ({ ...personalClaims(), portalOrigin: "https://portal.opensteer.test" }),
    ],
    [
      "Native with a portal origin",
      () => ({
        ...personalClaims(),
        clientSurface: "native",
        portalOrigin: "https://portal.opensteer.test",
      }),
    ],
    ["an unknown client surface", () => ({ ...personalClaims(), clientSurface: "phone" })],
    ["Browser without a portal origin", () => ({ ...personalClaims(), clientSurface: "browser" })],
    ["a stale explicit route generation", () => ({ ...personalClaims(), routeGeneration: 3 })],
    [
      "a lifetime beyond two minutes",
      () => ({ ...personalClaims(), exp: issuedAt + accountHostSessionGrantLifetimeSeconds + 1 }),
    ],
    ["a non-advancing expiry", () => ({ ...personalClaims(), exp: issuedAt })],
    ["a foreign Deployment", () => ({ ...personalClaims(), deploymentId: createId("deployment") })],
    ["a foreign token purpose", () => ({ ...personalClaims(), tokenUse: "another-purpose" })],
  ])("rejects %s", (_description, candidate) => {
    expect(AccountHostSessionGrantClaimsSchema.safeParse(candidate()).success).toBe(false);
  });

  it("requires the exact Connect route and browser surface pairing at issuance", () => {
    expect(
      IssuePersonalAccountHostSessionGrantRequestSchema.parse({
        clientSurface: "browser",
        expectedAuthority: personalAuthority,
        expectedRoute: routeEnvelope(),
        portalOrigin: "https://portal.opensteer.test",
        targetKind: "personal-connect",
      }).expectedRoute.document.route.generation,
    ).toBe(4);
    for (const clientSurface of ["desktop", "native"] as const) {
      expect(
        IssuePersonalAccountHostSessionGrantRequestSchema.safeParse({
          clientSurface,
          expectedAuthority: personalAuthority,
          expectedRoute: routeEnvelope(),
          portalOrigin: "https://portal.opensteer.test",
          targetKind: "personal-connect",
        }).success,
      ).toBe(false);
      expect(
        IssuePersonalAccountHostSessionGrantRequestSchema.safeParse({
          clientSurface,
          expectedAuthority: personalAuthority,
          expectedRoute: routeEnvelope(),
          targetKind: "personal-connect",
        }).success,
      ).toBe(true);
    }
  });
});

function personalClaims() {
  return {
    ...commonClaims(personalAuthority),
    clientSurface: "desktop",
    personalHostAccessRouteEnvelopeSha256: "c".repeat(43),
    route: routeDocument(),
    routeGeneration: 4,
    targetKind: "personal-connect",
  } as const;
}

function commonClaims(hostAuthority: ReturnType<typeof authority>) {
  return {
    account: { issuer: accountIssuer, subject: accountId },
    aud: hostAuthority.canonicalOrigin,
    authority: hostAuthority,
    deploymentId: hostAuthority.deploymentId,
    exp: issuedAt + accountHostSessionGrantLifetimeSeconds,
    iat: issuedAt,
    iss: accountIssuer,
    jti: `ahs_${crypto.randomUUID()}`,
    sub: accountId,
    tokenUse: "opensteer-account-host-session",
  } as const;
}

function authority(canonicalOrigin: string) {
  return {
    canonicalOrigin,
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: {
      defaultWorkspaceBacking: "local-directory",
      kind: "personal" as const,
    },
  } as const;
}

function routeDocument() {
  return {
    authority: personalAuthority,
    documentVersion: 2,
    purpose: "opensteer-personal-access-route",
    route: {
      generation: 4,
      kind: "connect",
      origin: "https://connect-home.opensteer.test",
    },
  } as const;
}

function routeEnvelope() {
  return {
    document: routeDocument(),
    publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
    schemaVersion: 1,
    signature: "A".repeat(86),
  } as const;
}

function omit<Value extends object, Key extends keyof Value>(value: Value, key: Key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
