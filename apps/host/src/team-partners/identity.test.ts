import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import { teamPartnerCapability, type TeamPartnerChallenge } from "@opensteer/protocol";
import { signHostDiscovery } from "../identity/host-keys.js";
import {
  signPartnerChallenge,
  verifiedPartnerDescriptor,
  verifyPartnerChallenge,
  verifyPartnerPins,
} from "./identity.js";

function identity() {
  const keys = generateKeyPairSync("ed25519");
  const authority = signHostDiscovery(keys, {
    deploymentId: createId("deployment"),
    canonicalOrigin: "https://partner.example",
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: { kind: "team" },
  });
  return { keys, authority };
}

describe("partner identity", () => {
  it("binds proofs to the purpose, teams, fresh challenges, approvals, version and signing role", () => {
    const a = identity(),
      b = identity();
    const challenge: TeamPartnerChallenge = {
      purpose: "pair",
      selector: "selector",
      listenerTeamId: a.authority.document.deploymentId,
      dialerTeamId: b.authority.document.deploymentId,
      listenerNonce: "fresh-server-nonce",
      dialerNonce: "fresh-client-nonce",
      listenerApproved: false,
      dialerApproved: true,
      version: 1,
    };
    const signature = signPartnerChallenge(b.keys.privateKey, challenge, "dialer");
    expect(() => verifyPartnerChallenge(b.authority, challenge, "dialer", signature)).not.toThrow();
    expect(() => verifyPartnerChallenge(a.authority, challenge, "dialer", signature)).toThrow();
    expect(() => verifyPartnerChallenge(b.authority, challenge, "listener", signature)).toThrow();
    for (const patch of [
      { purpose: "connect" as const },
      { selector: "other-invite" },
      { listenerTeamId: "other-team" },
      { dialerTeamId: "other-team" },
      { listenerNonce: "next-connection" },
      { dialerNonce: "next-dialer" },
      { listenerApproved: true },
      { dialerApproved: false },
      { version: 2 },
    ])
      expect(() =>
        verifyPartnerChallenge(b.authority, { ...challenge, ...patch }, "dialer", signature),
      ).toThrow();
  });

  it("pins signed identity and negotiates partners independently of the team-client API", () => {
    const a = identity(),
      b = identity();
    const pins = {
      teamId: a.authority.document.deploymentId,
      origin: a.authority.document.canonicalOrigin,
      hostInstanceId: a.authority.document.hostInstanceId,
      hostKeyFingerprint: hostKeyFingerprint(a.authority.publicKey.spki),
    };
    const descriptor = {
      kind: "team",
      apiVersion: 999,
      minimumApiVersion: 999,
      authority: a.authority,
      bootstrapMethods: [],
      capabilities: [teamPartnerCapability],
    };
    expect(verifiedPartnerDescriptor(descriptor, pins).apiVersion).toBe(999);
    expect(() => verifiedPartnerDescriptor({ ...descriptor, capabilities: [] }, pins)).toThrow();
    for (const patch of [
      { teamId: b.authority.document.deploymentId },
      { origin: "https://other.example" },
      { hostInstanceId: b.authority.document.hostInstanceId },
      { hostKeyFingerprint: hostKeyFingerprint(b.authority.publicKey.spki) },
    ])
      expect(() => verifyPartnerPins(a.authority, { ...pins, ...patch })).toThrow();
    expect(() =>
      verifyPartnerPins(
        {
          ...a.authority,
          document: { ...a.authority.document, canonicalOrigin: "https://other.example" },
        },
        pins,
      ),
    ).toThrow();
  });
});
