import { HostSession } from "../auth/host-session.js";
import type { NativeOAuthManager } from "../auth/native-oauth.js";
import type { HostSessionExchange } from "../auth/host-session-exchange.js";
import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { hostApiVersionHeader } from "@opensteer/protocol";
import { DesktopUpdatesService, OriginDesktopUpdates } from "./desktop-updates.js";
import {
  DeploymentCatalogSchema,
  DeploymentConnectionSchema,
  verifyAccessEndpoint,
} from "./deployment-catalog.js";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
} from "../test-support/host-authority.js";
import type { HostNetworkRequest } from "./host-transport.js";

function fixture(epoch = hostApiVersion - 1, scoped = false) {
  const keys = testHostAuthorityKeys();
  const authority = signTestDiscoveryEnvelope(
    {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentShape: { kind: "personal" },
      hostKey: { algorithm: "Ed25519" },
    },
    keys,
  );
  const origin = "https://home.connect.opensteer.test";
  const route = signTestPersonalAccessRoute(
    {
      authority: authority.document,
      documentVersion: 2,
      purpose: "opensteer-personal-access-route",
      route: { generation: 1, kind: "connect", origin },
    },
    keys,
  );
  const now = new Date().toISOString();
  const connection = DeploymentConnectionSchema.parse({
    authority,
    bootstrapMethods: ["connect-grant"],
    endpoints: [{ kind: "direct", origin, verifiedAt: now }],
    kind: "personal",
    reachability: "routed",
    personalAccessRoute: route,
    preferredEndpointOrigin: origin,
    source: { kind: "manual" },
    name: "Mac",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  });
  const catalog = DeploymentCatalogSchema.parse({
    deployments: [connection],
    selectedDeploymentId: authority.document.deploymentId,
    revision: 1,
    schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
    updatedAt: now,
  });
  const descriptor = {
    kind: "personal",
    apiVersion: epoch,
    authority,
    bootstrapMethods: ["connect-grant"],
    capabilities: [],
  };
  const status = { supported: true, state: null, operation: null, revision: "host:0" };
  const maintenance = vi.fn(async (_input: HostNetworkRequest) => Response.json(status));
  const request = vi.fn(async (input: HostNetworkRequest) => {
    if (input.url.endsWith("/personal-access-route")) {
      expect(input.authorization).toBeNull();
      return Response.json(route);
    }
    if (input.url.endsWith("/.well-known/opensteer")) {
      expect(input.authorization).toBeNull();
      return Response.json(descriptor);
    }
    expect(input.authorization).toBe("PersonalRemote owner-session");
    expect(input.request.headers.apiVersion).toBeUndefined();
    return maintenance(input);
  });
  const recoverUnauthorized = vi.fn(async () => "recovered" as const);
  const authorizationHeader = vi.fn(async () => "PersonalRemote owner-session");
  const service = new DesktopUpdatesService({
    catalog: { load: async () => catalog, subscribe: () => () => {} },
    credentials: { authorizationHeader },
    localRuntime: { current: async () => null },
    network: {
      request,
      openWebSocket: () => {
        throw new Error("Maintenance must not attach a socket");
      },
    },
    ...(scoped ? { deploymentId: authority.document.deploymentId } : {}),
    sessions: (attachment) =>
      scoped
        ? new HostSession({
            attachment,
            clearDeploymentSession: async () => {},
            exchange: {
              supports: () => true,
              probe: async () => "unauthenticated",
              establish: async () => {
                await recoverUnauthorized();
                return {} as Awaited<ReturnType<HostSessionExchange["establish"]>>;
              },
            },
            localOwner: { ownsHostSession: () => false, recoverOwnerSession: async () => false },
            oauth: {
              subscribe: () => () => {},
              subscribeHostCredentials: () => () => {},
            } as unknown as NativeOAuthManager,
          })
        : { recoverUnauthorized },
  });
  return {
    service,
    authorizationHeader,
    request,
    maintenance,
    status,
    descriptor,
    connection,
    recoverUnauthorized,
    catalog,
  };
}

it.each(["transport", "credential"])(
  "fences team maintenance requests on Account change via %s",
  async (stage) => {
    const origin = "https://team.example";
    const authority = signTestDiscoveryEnvelope(
      {
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
        canonicalOrigin: origin,
        deploymentShape: { kind: "team" },
        hostKey: { algorithm: "Ed25519" },
      },
      testHostAuthorityKeys(),
    );
    const now = new Date().toISOString();
    const connection = DeploymentConnectionSchema.parse({
      authority,
      bootstrapMethods: ["oidc"],
      kind: "team",
      reachability: "canonical",
      endpoints: [{ kind: "canonical", origin, verifiedAt: now }],
      source: { kind: "manual" },
      name: "Team",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    });
    const gate = Promise.withResolvers<Response>();
    const maintenance = vi.fn(async () => gate.promise);
    const credentialGate = Promise.withResolvers<void>();
    const read = vi.fn();
    let current = true;
    const service = new DesktopUpdatesService({
      catalog: {
        load: async () =>
          DeploymentCatalogSchema.parse({
            deployments: [connection],
            selectedDeploymentId: authority.document.deploymentId,
            revision: 1,
            schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
            updatedAt: now,
          }),
        subscribe: () => () => {},
      },
      deploymentId: authority.document.deploymentId,
      localRuntime: { current: async () => null },
      credentials: {
        teamEntryLease: () => ({
          assertCurrent: () => {
            if (!current) throw new Error("Account changed");
          },
        }),
        authorizationHeader: async () => {
          read();
          if (stage === "credential") await credentialGate.promise;
          return "Bearer outgoing";
        },
      },
      network: {
        request: async (input) =>
          input.url.endsWith("/.well-known/opensteer")
            ? Response.json({
                kind: "team",
                apiVersion: 1,
                authority,
                bootstrapMethods: ["oidc"],
                capabilities: [],
              })
            : maintenance(),
        openWebSocket: () => {
          throw new Error("No maintenance socket");
        },
      },
    });
    const pending = service.status();
    const rejected = expect(pending).rejects.toMatchObject({ code: "deployment-changed" });
    try {
      await vi.waitFor(
        () => expect(stage === "credential" ? read : maintenance).toHaveBeenCalledOnce(),
        { timeout: 1000 },
      );
      current = false;
      if (stage === "transport") service.invalidateTeamSession();
      credentialGate.resolve();
      gate.resolve(
        Response.json({ supported: true, state: null, operation: null, revision: "host:0" }),
      );
      await rejected;
      if (stage === "credential") expect(maintenance).not.toHaveBeenCalled();
    } finally {
      credentialGate.resolve();
      gate.resolve(Response.json({}));
    }
  },
);

it.each([false, true])(
  "keeps personal update requests during Account changes (scoped: %s)",
  async (scoped) => {
    const { service, maintenance, status } = fixture(hostApiVersion, scoped);
    const response = Promise.withResolvers<Response>();
    maintenance.mockImplementationOnce(async () => {
      return response.promise;
    });
    const pending = service.status();
    try {
      await vi.waitFor(() => expect(maintenance).toHaveBeenCalledOnce(), { timeout: 1000 });
      service.invalidateTeamSession();
      response.resolve(Response.json(status));
      await expect(pending).resolves.toEqual(status);
    } finally {
      response.resolve(Response.json(status));
    }
  },
);

it.each([hostApiVersion - 1, hostApiVersion + 1])(
  "verifies the signed route below attachment and reaches maintenance across epoch %s",
  async (epoch) => {
    const { service, request, descriptor, connection, maintenance, status } = fixture(epoch);
    await expect(
      verifyAccessEndpoint({
        origin: connection.preferredEndpointOrigin!,
        kind: "direct",
        fetch: async () => Response.json(descriptor),
      }),
    ).rejects.toMatchObject({ name: "HostVersionMismatchError" });
    expect(await service.status()).toEqual(status);
    expect(request).toHaveBeenCalledTimes(3);
    maintenance.mockImplementationOnce(async () =>
      Response.json({
        id: crypto.randomUUID(),
        intent: { action: "channel", channel: "beta" },
        state: "pending",
        fromVersion: null,
        targetVersion: null,
        incarnationId: null,
        detail: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const intent = { action: "channel" as const, channel: "beta" as const };
    expect(await service.request({ intent, idempotencyKey: "switch-once" })).toMatchObject({
      state: "pending",
      intent,
    });
    expect(maintenance.mock.calls.at(-1)?.[0].request.body).toBe(
      JSON.stringify({ idempotencyKey: "switch-once", intent }),
    );
  },
);

it("never sends a session after signature verification fails", async () => {
  const { descriptor, service, request, authorizationHeader } = fixture();
  descriptor.authority.signature = "A".repeat(86);
  await expect(service.status()).rejects.toMatchObject({ reason: "invalid-response" });
  expect(request.mock.calls.every(([input]) => input.authorization === null)).toBe(true);
  expect(authorizationHeader).not.toHaveBeenCalled();
});

it("reuses session recovery below attachment and identifies desktops needing their first local update", async () => {
  const { service, maintenance, status, recoverUnauthorized } = fixture();
  maintenance.mockResolvedValueOnce(Response.json({ error: "expired" }, { status: 401 }));
  maintenance.mockResolvedValueOnce(Response.json(status));
  expect(await service.status()).toEqual(status);
  expect(recoverUnauthorized).toHaveBeenCalledOnce();
  maintenance.mockResolvedValueOnce(new Response("missing", { status: 404 }));
  await expect(service.status()).rejects.toMatchObject({ reason: "unsupported" });
  maintenance.mockResolvedValueOnce(
    new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  await expect(service.status()).rejects.toMatchObject({ reason: "unsupported" });
});

it("cancels a visible subscription and its outstanding long-poll without reporting offline", async () => {
  const { service, maintenance } = fixture();
  let abandoned: AbortSignal | undefined;
  maintenance.mockImplementationOnce(async () =>
    Response.json({ supported: true, state: null, operation: null, revision: "host:1" }),
  );
  maintenance.mockImplementation(async (input) => {
    abandoned = input.signal;
    return new Promise<Response>((_resolve, reject) =>
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }),
    );
  });
  const controller = new AbortController();
  const received = vi.fn();
  const error = vi.fn();
  const stop = service.subscribeWhileVisible(received, {
    signal: controller.signal,
    onError: error,
  });
  try {
    await vi.waitFor(() => expect(maintenance).toHaveBeenCalledTimes(2), { timeout: 1000 });
    expect(maintenance.mock.calls[1]?.[0].url).toContain("?after=host%3A1");
    controller.abort();
    expect(abandoned?.aborted).toBe(true);
    expect(received).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it("does not send a credential when selection moves during identity verification", async () => {
  const { service, request, catalog } = fixture();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (input) => {
    const response = await original(input);
    if (input.url.endsWith("/.well-known/opensteer")) catalog.selectedDeploymentId = null;
    return response;
  });
  await expect(service.status()).rejects.toMatchObject({ reason: "invalid-response" });
  expect(request.mock.calls.every(([input]) => input.authorization === null)).toBe(true);
});

describe("OriginDesktopUpdates", () => {
  it("speaks the maintenance contract with the page's own session and no epoch", async () => {
    const status = { supported: true, state: null, operation: null, revision: "host:0" };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(status));
    const updates = new OriginDesktopUpdates("https://studio.example", fetch);
    await expect(updates.status({ after: "a b" })).resolves.toEqual(status);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://studio.example/maintenance/v1/desktop-update?after=a%20b");
    expect(init).toMatchObject({ method: "GET", credentials: "include" });
    expect(new Headers(init?.headers).has(hostApiVersionHeader)).toBe(false);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "unsupported"],
    [409, "conflict"],
    [503, "unavailable"],
  ] as const)("reports %i as %s", async (code, reason) => {
    const updates = new OriginDesktopUpdates(
      "https://studio.example",
      async () => new Response("", { status: code }),
    );
    await expect(updates.status()).rejects.toMatchObject({ reason });
  });

  it("reports a Host it can't reach as offline, and a closed view as itself", async () => {
    const updates = new OriginDesktopUpdates("https://studio.example", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(updates.status()).rejects.toMatchObject({ reason: "offline" });
    const closed = new AbortController();
    const reason = new Error("Updates view closed");
    closed.abort(reason);
    await expect(updates.status({ signal: closed.signal })).rejects.toBe(reason);
  });
});

it("recovers the pinned desktop Deployment while another Deployment is selected", async () => {
  const { service, catalog, maintenance, status, recoverUnauthorized } = fixture(
    hostApiVersion - 1,
    true,
  );
  const other = fixture().connection;
  catalog.deployments.push(other);
  catalog.selectedDeploymentId = other.authority.document.deploymentId;
  maintenance.mockResolvedValueOnce(Response.json({}, { status: 401 }));
  await expect(service.status()).resolves.toEqual(status);
  expect(recoverUnauthorized).toHaveBeenCalledOnce();
});
