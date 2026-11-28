import { DeploymentCatalogSchema, emptyDeploymentCatalog } from "@opensteer/client/connections";
import { testDiscoveryEnvelope } from "@opensteer/client/test-support";
import { createId } from "@opensteer/core";
import { HostDescriptorSchema, knownHostCapabilities } from "@opensteer/deployment-authority";
import { DeploymentAccessDeploymentSchema } from "@opensteer/protocol/desktop";
import { expect, it } from "vitest";
import { advertisedCapabilities } from "../server.js";

it("fits a fully enabled Personal Host in the shipped deployment parsers", () => {
  const origin = "http://127.0.0.1:4310";
  const id = createId("deployment");
  const now = new Date().toISOString();
  const authority = testDiscoveryEnvelope({
    canonicalOrigin: origin,
    deploymentId: id,
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: { kind: "personal" },
  });
  // Loopback Personal supports passkeys and Account notification previews
  // together. The runtime supplies assets, device drivers and session exchange.
  const capabilities = advertisedCapabilities({
    assets: {} as never,
    authenticator: { identity: { nativeOpenIdConfiguration: () => null } } as never,
    deviceDrivers: {} as never,
    notificationPreviews: {} as never,
    passkeys: true,
    personalRemoteAccess: { service: { accountSessionExchangeEnabled: () => true } as never },
  });
  expect(capabilities.length).toBeLessThanOrEqual(32);
  expect(knownHostCapabilities([...capabilities, "task-attachments"])).toEqual(capabilities);
  const catalog = {
    ...emptyDeploymentCatalog(),
    revision: 1,
    updatedAt: now,
    selectedDeploymentId: id,
    deployments: [
      {
        authority,
        bootstrapMethods: ["pairing-code", "connect-grant"],
        capabilities,
        createdAt: now,
        endpoints: [{ kind: "canonical", origin, verifiedAt: now }],
        kind: "personal",
        lastUsedAt: null,
        name: "Mac mini",
        reachability: "canonical",
        source: { kind: "manual" },
        updatedAt: now,
      },
    ],
  } as const;
  DeploymentCatalogSchema.parse(catalog);

  const oversized = [...capabilities, ...Array<string>(33 - capabilities.length).fill("unknown")];
  expect(
    HostDescriptorSchema.parse({
      kind: "personal",
      apiVersion: 1,
      authority,
      bootstrapMethods: [],
      capabilities: oversized,
    }).capabilities,
  ).toEqual(oversized);
  expect(knownHostCapabilities(oversized)).toEqual(capabilities);
  expect(
    DeploymentCatalogSchema.safeParse({
      ...catalog,
      deployments: [{ ...catalog.deployments[0], capabilities: oversized }],
    }).success,
  ).toBe(false);

  DeploymentAccessDeploymentSchema.parse({
    id,
    access: "owner",
    activeOrigin: origin,
    canonicalOrigin: origin,
    kind: "personal",
    lastUsedAt: null,
    name: "Mac mini",
    onThisComputer: true,
    routes: [{ kind: "canonical", origin, selected: true }],
    accountAccess: "owner",
    availableActions: ["select"],
    capabilities,
    failure: null,
    source: "this-device",
    status: "connected",
    statusInfo: { reason: null, status: "ready" },
  });
});
