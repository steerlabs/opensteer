import { expect, it } from "vitest";
import { descendantPids } from "../scripts/smoke-desktop-release-processes.js";
it("captures nested children regardless of ps order without selecting shared-Mac peers", () => {
  expect(descendantPids("4 3\n2 1\n3 2\n5 1\n6 5", 2)).toEqual([3, 4]);
  expect(descendantPids("", 2)).toEqual([]);
});

import {
  personalSetupIntent,
  personalSelectionReady,
} from "../scripts/smoke-desktop-release-profile.js";
import {
  emptyDeploymentCatalog,
  DeploymentConnectionSchema,
} from "../packages/client/src/connections/deployment-catalog.js";
import { testDiscoveryEnvelope } from "../packages/client/src/test-support/host-authority.js";
import { createHash } from "node:crypto";
const runtime = JSON.stringify({
  architecture: "arm64",
  operatingSystem: "darwin",
  hostVersion: "0.1.1",
  runnerVersion: "0.1.1",
  postgresVersion: "17.11.0",
  postgresMajor: 17,
  schemaVersion: 7,
  files: [],
});
it("seeds only setup intent bound to the actual runtime, without a database or owner", () => {
  const intent = personalSetupIntent(runtime, "/private/temp/check", 4101, 4102);
  expect(intent).toMatchObject({
    databaseInitialized: false,
    ownerInitialized: false,
    hostKeyFingerprint: null,
    revision: 0,
    workspaceRoot: "/private/temp/check/Workspaces",
  });
  expect(intent.release.manifestSha256).toBe(createHash("sha256").update(runtime).digest("hex"));
  expect(() => personalSetupIntent(runtime, "/private/temp/check", 4101, 4101)).toThrow();
});
it("requires the supervisor's matching Personal selection rather than an empty or unrelated profile", () => {
  const intent = personalSetupIntent(runtime, "/private/temp/check", 4101, 4102);
  expect(
    personalSelectionReady(JSON.stringify(emptyDeploymentCatalog()), intent.deploymentId),
  ).toBe(false);
  const now = new Date().toISOString();
  const connection = DeploymentConnectionSchema.parse({
    accountAccess: null,
    bootstrapMethods: [],
    kind: "personal",
    name: "Release launch check",
    source: { kind: "manual" },
    reachability: "canonical",
    endpoints: [{ kind: "canonical", origin: "http://127.0.0.1:4101", verifiedAt: now }],
    authority: testDiscoveryEnvelope({
      deploymentId: intent.deploymentId,
      hostInstanceId: intent.hostInstanceId,
      canonicalOrigin: "http://127.0.0.1:4101",
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
    }),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  });
  const catalog = {
    ...emptyDeploymentCatalog(),
    revision: 1,
    updatedAt: now,
    deployments: [connection],
    selectedDeploymentId: intent.deploymentId,
  };
  expect(personalSelectionReady(JSON.stringify(catalog), intent.deploymentId)).toBe(true);
  expect(personalSelectionReady(JSON.stringify(catalog), "unrelated")).toBe(false);
});
