import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import {
  hostDiscoverySigningBytes,
  hostKeyFingerprint,
  teamApiVersion,
} from "@opensteer/deployment-authority";
import { teamLinkUpdateSide, verifiedTeamDiscovery } from "./discovery.js";
import { allowedTeamAddress } from "./network.js";

function discovery() {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const document = {
    canonicalOrigin: "https://team.example.invalid",
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" as const },
    deploymentShape: { kind: "team" as const },
  };
  const authority = {
    document,
    publicKey: { algorithm: "Ed25519", spki },
    signature: sign(null, hostDiscoverySigningBytes(document), keys.privateKey).toString(
      "base64url",
    ),
  };
  return {
    descriptor: {
      kind: "team",
      apiVersion: teamApiVersion,
      authority,
      bootstrapMethods: [],
      capabilities: [],
    },
    offer: {
      teamId: document.deploymentId,
      origin: document.canonicalOrigin,
      hostKeyFingerprint: hostKeyFingerprint(spki),
    },
  };
}

describe("team discovery and route pinning", () => {
  it("uses the independent team version while verifying the signature and pinned identity", () => {
    const { descriptor, offer } = discovery();
    expect(verifiedTeamDiscovery(descriptor, offer)).toMatchObject({ apiVersion: teamApiVersion });
    expect(() =>
      verifiedTeamDiscovery(descriptor, { ...offer, hostKeyFingerprint: "wrong" }),
    ).toThrow();
    expect(() => verifiedTeamDiscovery(descriptor, offer, createId("hostInstance"))).toThrow();
    descriptor.authority.document.canonicalOrigin = "https://other.example.invalid";
    expect(() => verifiedTeamDiscovery(descriptor, offer)).toThrow();
  });
  it("names the behind side without changing any personal state", () => {
    const { descriptor, offer } = discovery();
    expect(() =>
      verifiedTeamDiscovery({ ...descriptor, apiVersion: teamApiVersion + 1 }, offer),
    ).toThrow(expect.objectContaining({ details: { behind: "personal" } }));
    expect(teamLinkUpdateSide(1, 2)).toBe("team");
    expect(teamLinkUpdateSide(2, 1)).toBe("personal");
  });
  it.each([
    "169.254.169.254",
    "100.100.100.200",
    "fd00:ec2::254",
    "fd00:ec2:0:0:0:0:0:254",
    "169.254.1.1",
    "fe80::1",
    "::",
    "0.0.0.0",
    "224.0.0.1",
    "::ffff:169.254.169.254",
  ])("refuses metadata/link-local route %s", (address) => {
    expect(allowedTeamAddress(address)).toBe(false);
  });
  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.10",
    "172.16.0.2",
    "100.64.1.2",
    "fd00::1",
    "::1",
    "8.8.8.8",
  ])("allows the approved team's exact private or public route %s", (address) => {
    expect(allowedTeamAddress(address)).toBe(true);
  });
});
