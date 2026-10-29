import { generateKeyPairSync, sign } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  PersonalHostAccountLinkChallengeIdSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
  personalHostAccessRouteSigningBytes,
  personalHostAccountLinkProofSigningBytes,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  verifyPersonalHostAccessRoute,
  verifyPersonalHostAccountLinkProof,
} from "./personal-host-proof.js";

describe("Personal Host proof verification", () => {
  it("accepts Host-key-bound route and Account-link proofs", () => {
    const signing = hostSigningFixture();
    expect(verifyPersonalHostAccessRoute(signing.route).document.route.generation).toBe(3);
    expect(verifyPersonalHostAccountLinkProof(signing.link).document.account.subject).toBe(
      signing.link.document.account.subject,
    );
  });

  it.each(["route signature", "route authority", "link challenge"])(
    "rejects a tampered %s",
    (kind) => {
      const signing = hostSigningFixture();
      if (kind === "route signature") {
        expect(() =>
          verifyPersonalHostAccessRoute({ ...signing.route, signature: "B".repeat(86) }),
        ).toThrow("invalid");
      } else if (kind === "route authority") {
        expect(() =>
          verifyPersonalHostAccessRoute({
            ...signing.route,
            document: {
              ...signing.route.document,
              authority: {
                ...signing.route.document.authority,
                canonicalOrigin: "http://localhost:4310",
              },
            },
          }),
        ).toThrow("invalid");
      } else {
        expect(() =>
          verifyPersonalHostAccountLinkProof({
            ...signing.link,
            document: {
              ...signing.link.document,
              challenge: {
                ...signing.link.document.challenge,
                credentialSha256: "b".repeat(43),
              },
            },
          }),
        ).toThrow("invalid");
      }
    },
  );
});

function hostSigningFixture() {
  const keyPair = generateKeyPairSync("ed25519");
  const encodedSpki = keyPair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64url");
  const authority = {
    canonicalOrigin: "http://127.0.0.1:4310",
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: {
      defaultWorkspaceBacking: "local-directory",
      kind: "personal" as const,
    },
  } as const;
  const routeDocument = {
    authority,
    documentVersion: 2,
    purpose: "opensteer-personal-access-route",
    route: {
      generation: 3,
      kind: "connect",
      origin: "https://connect-host.opensteer.test",
    },
  } as const;
  const route = PersonalHostAccessRouteEnvelopeSchema.parse({
    document: routeDocument,
    publicKey: { algorithm: "Ed25519", spki: encodedSpki },
    schemaVersion: 1,
    signature: sign(
      null,
      personalHostAccessRouteSigningBytes(routeDocument),
      keyPair.privateKey,
    ).toString("base64url"),
  });
  const issuedAt = new Date();
  const linkDocument = {
    account: {
      issuer: "https://account.opensteer.test",
      subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
    },
    authority,
    challenge: {
      credentialSha256: "a".repeat(43),
      id: PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`),
    },
    documentVersion: 2,
    expiresAt: new Date(issuedAt.getTime() + 120_000).toISOString(),
    issuedAt: issuedAt.toISOString(),
    purpose: "opensteer-personal-host-account-link",
  } as const;
  const link = PersonalHostAccountLinkProofEnvelopeSchema.parse({
    document: linkDocument,
    publicKey: { algorithm: "Ed25519", spki: encodedSpki },
    signature: sign(
      null,
      personalHostAccountLinkProofSigningBytes(linkDocument),
      keyPair.privateKey,
    ).toString("base64url"),
  });
  return { link, route };
}
