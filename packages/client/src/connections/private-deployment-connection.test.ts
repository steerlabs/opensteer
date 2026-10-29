import { createId } from "@opensteer/core";
import { type PersonalHostAccessRouteEnvelope } from "@opensteer/control-plane-protocol";
import {
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { describe, expect, it, vi } from "vitest";
import { DeploymentCatalogStore } from "./deployment-catalog.js";
import { PrivateDeploymentConnectionService } from "./private-deployment-connection.js";
import {
  establishedCookieSession,
  MemoryPrivateFilesystem,
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
  testHostDescriptor,
} from "../test-support/index.js";

const pairingCode = `osp_${"p".repeat(43)}`;

describe("PrivateDeploymentConnectionService", () => {
  it("verifies the Host-signed Private route, consumes a code, and stores direct-only Personal", async () => {
    const catalog = newCatalog();
    const route = accessRoute();
    const sessions = sessionPort();
    const fetch = vi.fn(async (input: string | URL | Request) => personalResponse(route, input));
    const service = new PrivateDeploymentConnectionService({ catalog, fetch, sessions });

    await service.connect({
      kind: "personal-pairing",
      origin: route.document.route.origin,
      pairingCode,
    });

    expect(fetch).toHaveBeenCalledWith(
      `${route.document.route.origin}/.well-known/opensteer/personal-access-route`,
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    expect(sessions.establish).toHaveBeenCalledWith(
      expect.objectContaining({ access: "private", route, origin: route.document.route.origin }),
      { pairingCode },
    );
    await expect(catalog.load()).resolves.toMatchObject({
      deployments: [
        {
          authority: expect.objectContaining({ document: route.document.authority }),
          endpoints: [{ kind: "direct", origin: route.document.route.origin }],
          kind: "personal" as const,
          source: { kind: "manual" },
          preferredEndpointOrigin: route.document.route.origin,
        },
      ],
      selectedDeploymentId: route.document.authority.deploymentId,
    });
  });

  it("does not consume another one-use code when the exact session cookie already exists", async () => {
    const catalog = newCatalog();
    const route = accessRoute();
    const sessions = sessionPort(true);
    const service = new PrivateDeploymentConnectionService({
      catalog,
      fetch: async (input) => personalResponse(route, input),
      sessions,
    });

    await service.connect({
      kind: "personal-pairing",
      origin: route.document.route.origin,
      pairingCode,
    });

    expect(sessions.establish).not.toHaveBeenCalled();
  });

  it("rejects a forged or wrong-origin route before pairing or catalog mutation", async () => {
    const catalog = newCatalog();
    const valid = accessRoute();
    const sessions = sessionPort();
    const forged = { ...valid, signature: "A".repeat(86) };
    const forgedService = new PrivateDeploymentConnectionService({
      catalog,
      fetch: async () => routeResponse(forged),
      sessions,
    });
    await expect(
      forgedService.connect({
        kind: "personal-pairing",
        origin: valid.document.route.origin,
        pairingCode,
      }),
    ).rejects.toThrow(/signature is invalid/u);

    const otherOrigin = accessRoute("https://other.tailnet.example");
    const mismatchedService = new PrivateDeploymentConnectionService({
      catalog,
      fetch: async () => routeResponse(otherOrigin),
      sessions,
    });
    await expect(
      mismatchedService.connect({
        kind: "personal-pairing",
        origin: valid.document.route.origin,
        pairingCode,
      }),
    ).rejects.toThrow(/does not match the requested HTTPS route/u);
    expect(sessions.establish).not.toHaveBeenCalled();
    await expect(catalog.load()).resolves.toMatchObject({ deployments: [], revision: 0 });
  });

  it("keeps the catalog empty when pairing fails and no cookie was committed", async () => {
    const catalog = newCatalog();
    const route = accessRoute();
    const sessions = sessionPort();
    sessions.establish.mockRejectedValueOnce(new Error("Pairing rejected"));
    const service = new PrivateDeploymentConnectionService({
      catalog,
      fetch: async (input) => personalResponse(route, input),
      sessions,
    });

    await expect(
      service.connect({
        kind: "personal-pairing",
        origin: route.document.route.origin,
        pairingCode,
      }),
    ).rejects.toThrow("Pairing rejected");
    await expect(catalog.load()).resolves.toMatchObject({ deployments: [], revision: 0 });
  });

  it("rejects non-HTTPS remote origins without network or pairing I/O", async () => {
    const catalog = newCatalog();
    const fetch = vi.fn();
    const sessions = sessionPort();
    const service = new PrivateDeploymentConnectionService({ catalog, fetch, sessions });

    await expect(
      service.connect({
        kind: "personal-pairing",
        origin: "http://192.168.1.41:4310",
        pairingCode,
      }),
    ).rejects.toThrow(/must use HTTPS/u);
    expect(fetch).not.toHaveBeenCalled();
    expect(sessions.establish).not.toHaveBeenCalled();
  });

  it("stores signed self-hosted canonical discovery without manufacturing a signed-in session", async () => {
    const catalog = newCatalog();
    const discovery = selfHostedDiscovery();
    const sessions = sessionPort();
    const fetch = vi.fn(async () => discoveryResponse(discovery));
    const service = new PrivateDeploymentConnectionService({ catalog, fetch, sessions });

    await service.connect({
      kind: "self-hosted",
      origin: discovery.document.canonicalOrigin,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      `${discovery.document.canonicalOrigin}/.well-known/opensteer`,
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    expect(sessions.probe).not.toHaveBeenCalled();
    expect(sessions.establish).not.toHaveBeenCalled();
    await expect(catalog.load()).resolves.toMatchObject({
      deployments: [
        {
          authority: discovery,
          endpoints: [{ kind: "canonical", origin: discovery.document.canonicalOrigin }],
          kind: "self-hosted",
          source: { kind: "manual" },
        },
      ],
      selectedDeploymentId: discovery.document.deploymentId,
    });
  });

  it("never switches discovery protocols when the explicitly selected connection kind is wrong", async () => {
    const catalog = newCatalog();
    const personalDiscovery = selfHostedDiscovery("https://personal.example.test", "personal");
    const sessions = sessionPort();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        `${personalDiscovery.document.canonicalOrigin}/.well-known/opensteer`,
      );
      return discoveryResponse(personalDiscovery);
    });
    const service = new PrivateDeploymentConnectionService({ catalog, fetch, sessions });

    await expect(
      service.connect({
        kind: "self-hosted",
        origin: personalDiscovery.document.canonicalOrigin,
      }),
    ).rejects.toThrow(/is a computer, not a server/u);

    expect(fetch).toHaveBeenCalledOnce();
    expect(sessions.probe).not.toHaveBeenCalled();
    expect(sessions.establish).not.toHaveBeenCalled();
    await expect(catalog.load()).resolves.toMatchObject({ deployments: [], revision: 0 });
  });

  it("rejects ambiguous or cross-kind authority before network I/O", async () => {
    const catalog = newCatalog();
    const fetch = vi.fn();
    const sessions = sessionPort();
    const service = new PrivateDeploymentConnectionService({ catalog, fetch, sessions });

    await expect(
      service.connect({
        origin: "https://self-hosted.example.test",
        pairingCode,
      }),
    ).rejects.toThrow();
    await expect(
      service.connect({
        kind: "self-hosted",
        origin: "https://self-hosted.example.test",
        pairingCode,
      }),
    ).rejects.toThrow();
    await expect(
      service.connect({
        kind: "personal-pairing",
        origin: "https://personal.example.test",
      }),
    ).rejects.toThrow();

    expect(fetch).not.toHaveBeenCalled();
    expect(sessions.probe).not.toHaveBeenCalled();
    expect(sessions.establish).not.toHaveBeenCalled();
    await expect(catalog.load()).resolves.toMatchObject({ deployments: [], revision: 0 });
  });
});

function sessionPort(initiallyAuthenticated = false) {
  let authenticated = initiallyAuthenticated;
  return {
    establish: vi.fn(async () => {
      authenticated = true;
      return establishedCookieSession();
    }),
    probe: vi.fn(async () =>
      authenticated ? ("authenticated" as const) : ("unauthenticated" as const),
    ),
  };
}

function newCatalog(): DeploymentCatalogStore {
  return new DeploymentCatalogStore({
    filePath: "/private/deployment-catalog.json",
    now: () => new Date("2026-08-12T10:00:00.000Z"),
    privateFiles: new MemoryPrivateFilesystem(),
  });
}

function accessRoute(
  routeOrigin = "https://studio.tailnet.example",
): PersonalHostAccessRouteEnvelope {
  const keys = testHostAuthorityKeys();
  const document = {
    authority: {
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: {
        algorithm: "Ed25519" as const,
      },
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory" as const,
        kind: "personal" as const,
      },
    },
    documentVersion: 2 as const,
    purpose: "opensteer-personal-access-route" as const,
    route: { generation: 3, kind: "private" as const, origin: routeOrigin },
  };
  const route = signTestPersonalAccessRoute(document, keys);
  personalDiscoveryByDeployment.set(
    document.authority.deploymentId,
    signTestDiscoveryEnvelope(document.authority, keys),
  );
  return route;
}

const personalDiscoveryByDeployment = new Map<string, HostDiscoveryEnvelope>();

function personalResponse(
  route: PersonalHostAccessRouteEnvelope,
  input: string | URL | Request,
): Response {
  if (String(input).endsWith("/personal-access-route")) return routeResponse(route);
  const authority = personalDiscoveryByDeployment.get(route.document.authority.deploymentId);
  if (!authority) throw new Error("Personal discovery fixture is missing");
  return new Response(JSON.stringify(testHostDescriptor(authority, ["pairing-code"])), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function routeResponse(route: PersonalHostAccessRouteEnvelope): Response {
  return new Response(JSON.stringify(route), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function selfHostedDiscovery(
  canonicalOrigin = "https://self-hosted.example.test",
  kind: "personal" | "self-hosted" = "self-hosted",
): HostDiscoveryEnvelope {
  const keys = testHostAuthorityKeys();
  const deploymentShape = {
    defaultWorkspaceBacking: "local-directory" as const,
    kind: kind === "personal" ? ("personal" as const) : ("server" as const),
  };
  const document: HostDiscoveryDocument = {
    canonicalOrigin,
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKey: {
      algorithm: "Ed25519",
    },
    deploymentShape,
  };
  return signTestDiscoveryEnvelope(document, keys);
}

function discoveryResponse(discovery: HostDiscoveryEnvelope): Response {
  return new Response(JSON.stringify(testHostDescriptor(discovery)), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
