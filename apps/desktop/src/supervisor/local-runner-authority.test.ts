import { generateKeyPairSync, sign } from "node:crypto";
import { createId } from "@opensteer/core";
import { personalHostAccessRouteSigningBytes } from "@opensteer/control-plane-protocol";
import {
  hostDiscoverySigningBytes,
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { describe, expect, it } from "vitest";
import {
  DeploymentCatalogSchema,
  DeploymentConnectionSchema,
  type DeploymentCatalog,
} from "@opensteer/client/connections";
import { DesktopLocalRunnerTargetResolver } from "./local-runner-authority.js";

const keys = generateKeyPairSync("ed25519");
const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const now = "2026-08-11T10:00:00.000Z";
const loopbackOrigin = "http://127.0.0.1:4310";
const routeOrigin = "https://studio.connect.opensteer.example";

describe("DesktopLocalRunnerTargetResolver", () => {
  it("accepts a Personal Deployment this Mac reaches over its signed route", async () => {
    const connection = personalConnection({ route: routeOrigin });
    const deploymentId = connection.authority.document.deploymentId;
    const resolver = new DesktopLocalRunnerTargetResolver({
      catalog: catalogStore([connection]),
      supervisedDeploymentId: async () => null,
    });

    const target = await resolver.resolve(deploymentId);

    expect(target).toMatchObject({
      deploymentId,
      deploymentShape: { kind: "personal" },
      // The signed access route, never the Host's own unreachable loopback.
      hostUrl: routeOrigin,
      // A Personal Deployment grants every computer but its Main exactly shell.
      mayRunAgents: false,
    });
    await expect(resolver.isCurrent(target)).resolves.toBe(true);
  });

  it("refuses the Mac that hosts the Personal Deployment", async () => {
    const connection = personalConnection({ route: routeOrigin });
    const deploymentId = connection.authority.document.deploymentId;
    const resolver = new DesktopLocalRunnerTargetResolver({
      catalog: catalogStore([connection]),
      supervisedDeploymentId: async () => deploymentId,
    });

    await expect(resolver.resolve(deploymentId)).rejects.toThrow(
      "This Mac hosts this Deployment, so it already runs as its Main Runner.",
    );
  });

  it("refuses a Personal Deployment whose computer is switched off", async () => {
    const connection = personalConnection({ route: null });
    const resolver = new DesktopLocalRunnerTargetResolver({
      catalog: catalogStore([connection]),
      supervisedDeploymentId: async () => null,
    });

    await expect(resolver.resolve(connection.authority.document.deploymentId)).rejects.toThrow(
      "no live remote access route",
    );
  });

  it("lets only a server Deployment run agents on this Mac", async () => {
    const connection = serverConnection();
    const resolver = new DesktopLocalRunnerTargetResolver({
      catalog: catalogStore([connection]),
      supervisedDeploymentId: async () => null,
    });

    await expect(
      resolver.resolve(connection.authority.document.deploymentId),
    ).resolves.toMatchObject({
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      hostUrl: "https://cloud.opensteer.test",
      mayRunAgents: true,
    });
  });
});

/**
 * A Personal computer as the Account directory projects it: signed authority,
 * a canonical origin that is somebody else's loopback, and a route that exists
 * only while that computer is awake.
 */
function personalConnection(options: { readonly route: string | null }) {
  const authority = envelope({
    canonicalOrigin: loopbackOrigin,
    deploymentId: createId("deployment"),
    deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" },
  });
  return DeploymentConnectionSchema.parse({
    accountLivenessExpiresAt: null,
    authority,
    bootstrapMethods: ["connect-grant"],
    createdAt: now,
    endpoints: [
      options.route === null
        ? { kind: "canonical", origin: loopbackOrigin, verifiedAt: now }
        : { kind: "direct", origin: options.route, verifiedAt: now },
    ],
    kind: "personal",
    lastUsedAt: null,
    name: "Studio Mac",
    personalAccessRoute: accessRoute(authority),
    preferredEndpointOrigin: options.route,
    reachability: "routed",
    source: { kind: "manual" },
    updatedAt: now,
  });
}

function serverConnection() {
  const canonicalOrigin = "https://cloud.opensteer.test";
  return DeploymentConnectionSchema.parse({
    authority: envelope({
      canonicalOrigin,
      deploymentId: createId("deployment"),
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
    }),
    bootstrapMethods: ["password"],
    createdAt: now,
    endpoints: [{ kind: "canonical", origin: canonicalOrigin, verifiedAt: now }],
    kind: "self-hosted",
    lastUsedAt: null,
    name: "Cloud",
    reachability: "canonical",
    source: { kind: "manual" },
    updatedAt: now,
  });
}

function envelope(document: HostDiscoveryDocument): HostDiscoveryEnvelope {
  return {
    document,
    publicKey: { algorithm: "Ed25519", spki },
    signature: sign(null, hostDiscoverySigningBytes(document), keys.privateKey).toString(
      "base64url",
    ),
  };
}

function accessRoute(authority: HostDiscoveryEnvelope) {
  const document = {
    authority: authority.document,
    documentVersion: 2 as const,
    purpose: "opensteer-personal-access-route" as const,
    route: { generation: 7, kind: "connect" as const, origin: routeOrigin },
  };
  return {
    document,
    publicKey: { algorithm: "Ed25519", spki },
    schemaVersion: 1,
    signature: sign(null, personalHostAccessRouteSigningBytes(document), keys.privateKey).toString(
      "base64url",
    ),
  };
}

function catalogStore(deployments: DeploymentCatalog["deployments"]) {
  const catalog = DeploymentCatalogSchema.parse({
    deployments,
    revision: deployments.length ? 1 : 0,
    schemaVersion: 4,
    selectedDeploymentId: deployments[0]?.authority.document.deploymentId ?? null,
    updatedAt: deployments.length ? now : null,
  });
  return { load: async () => catalog, subscribe: () => () => undefined };
}
