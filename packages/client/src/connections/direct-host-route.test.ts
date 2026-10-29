import { createId } from "@opensteer/core";
import { type HostDiscoveryDocument } from "@opensteer/deployment-authority";
import { describe, expect, it, vi } from "vitest";
import { DeploymentCatalogStore } from "./deployment-catalog.js";
import { DirectHostRouteService } from "./direct-host-route.js";
import {
  MemoryPrivateFilesystem,
  signTestDiscoveryEnvelope,
  testHostAuthorityKeys,
  testHostDescriptor,
} from "../test-support/index.js";

describe("DirectHostRouteService", () => {
  it("stores and selects a direct route only after exact signed authority verification", async () => {
    const keys = testHostAuthorityKeys();
    const discovery: HostDiscoveryDocument = {
      canonicalOrigin: "https://home.connect.opensteer.test",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: {
        algorithm: "Ed25519",
      },
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    };
    const catalog = new DeploymentCatalogStore({
      filePath: "/private/deployment-catalog.json",
      privateFiles: new MemoryPrivateFilesystem(),
    });
    await catalog.upsert({
      accountAccess: null,
      authority: signTestDiscoveryEnvelope(discovery, keys),
      bootstrapMethods: [],
      endpoints: [
        {
          kind: "canonical",
          origin: discovery.canonicalOrigin,
          verifiedAt: "2026-08-11T10:00:00.000Z",
        },
      ],
      kind: "personal" as const,
      name: "Home",
      reachability: "canonical",
      source: { kind: "manual" },
    });
    const fetch = vi.fn(async () =>
      Response.json(testHostDescriptor(signTestDiscoveryEnvelope(discovery, keys))),
    );
    const service = new DirectHostRouteService({ catalog, fetch });

    await service.add({
      deploymentId: discovery.deploymentId,
      origin: "https://home.tailnet.test",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://home.tailnet.test/.well-known/opensteer",
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    await expect(catalog.load()).resolves.toMatchObject({
      deployments: [
        {
          preferredEndpointOrigin: "https://home.tailnet.test",
          endpoints: [
            expect.objectContaining({ kind: "canonical" }),
            expect.objectContaining({ kind: "direct", origin: "https://home.tailnet.test" }),
          ],
        },
      ],
    });
  });

  it("rejects plain-LAN HTTP before contacting the endpoint", async () => {
    const fetch = vi.fn();
    const service = new DirectHostRouteService({
      catalog: { addVerifiedDirectEndpoint: vi.fn(), load: vi.fn() },
      fetch,
    });

    await expect(
      service.add({ deploymentId: createId("deployment"), origin: "http://192.168.1.4:4310" }),
    ).rejects.toThrow("must use HTTPS");
    expect(fetch).not.toHaveBeenCalled();
  });
});
