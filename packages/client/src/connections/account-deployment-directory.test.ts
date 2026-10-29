import {
  AccountDeploymentDirectoryEntrySchema,
  ControlPlaneAccountIdSchema,
  type AccountDeploymentDirectoryEntry,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import {
  hostKeyFingerprint,
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { describe, expect, it, vi } from "vitest";
import { AccountDeploymentDirectoryService } from "./account-deployment-directory.js";
import { DeploymentCatalogStore } from "./deployment-catalog.js";
import {
  MemoryPrivateFilesystem,
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
  testHostDescriptor,
} from "../test-support/index.js";

const deploymentId = createId("deployment");
const hostInstanceId = createId("hostInstance");
const canonicalOrigin = "https://d-11111111-1111-4111-8111-111111111111.opensteer.test";
const catalogPath = "/private/deployment-catalog.json";
const discoveryKeys = testHostAuthorityKeys();
const discoveryFingerprint = hostKeyFingerprint(discoveryKeys.spki);
const accountSubject = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
const accountSource = {
  issuer: "https://accounts.opensteer.test",
  kind: "account" as const,
  subject: accountSubject,
};

function accountAuthorization(
  header: string | null = "Bearer account",
  controller = new AbortController(),
) {
  return {
    accountAuthorizationLease: async () =>
      header === null
        ? null
        : {
            authorization: header,
            issuer: accountSource.issuer,
            signal: controller.signal,
            subject: accountSource.subject,
          },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
const discovery: HostDiscoveryDocument = {
  canonicalOrigin,
  deploymentId,
  hostInstanceId,
  hostKey: { algorithm: "Ed25519" },
  deploymentShape: {
    defaultWorkspaceBacking: "portablefs",
    kind: "server" as const,
  },
};
const personalDeploymentId = createId("deployment");
const personalHostInstanceId = createId("hostInstance");
const personalCanonicalOrigin = "http://127.0.0.1:4310";
const personalKeys = testHostAuthorityKeys();
const personalFingerprint = hostKeyFingerprint(personalKeys.spki);
const personalDiscovery: HostDiscoveryDocument = {
  canonicalOrigin: personalCanonicalOrigin,
  deploymentId: personalDeploymentId,
  hostInstanceId: personalHostInstanceId,
  hostKey: { algorithm: "Ed25519" },
  deploymentShape: {
    defaultWorkspaceBacking: "local-directory",
    kind: "personal" as const,
  },
};
describe("AccountDeploymentDirectoryService", () => {
  it("uses Account metadata only as a hint and stores a separately verified Host", async () => {
    const reconcileAccountDeployments = vi.fn();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      if (url === "https://accounts.opensteer.test/v1/account/deployments") {
        expect(headers?.authorization).toBe("Bearer account");
        return json({ deployments: [directoryDeployment()] }, url);
      }
      expect(url).toBe(`${canonicalOrigin}/.well-known/opensteer`);
      expect(headers?.authorization).toBeUndefined();
      expect(init?.credentials).toBe("omit");
      return json(testHostDescriptor(signDiscovery(discovery), ["password"]), url);
    });
    const service = new AccountDeploymentDirectoryService({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: accountAuthorization(),
      catalog: { reconcileAccountDeployments },
      fetch,
    });

    await expect(service.sync()).resolves.toEqual({
      syncedDeploymentIds: [deploymentId],
      unavailable: [],
    });
    expect(reconcileAccountDeployments).toHaveBeenCalledWith({
      connections: [
        {
          accountAccess: "owner",
          authority: signDiscovery(discovery),
          bootstrapMethods: ["password"],
          capabilities: [],
          endpoints: [expect.objectContaining({ kind: "canonical", origin: canonicalOrigin })],
          kind: "self-hosted",
          name: "Home",
          reachability: "canonical",
          source: accountSource,
        },
      ],
      directoryDeployments: [directoryDeployment()],
      source: accountSource,
    });
  });

  it("never commits a directory result after its Account authorization is invalidated", async () => {
    const authorization = new AbortController();
    const response = deferred<Response>();
    const reconcileAccountDeployments = vi.fn();
    const fetch = vi.fn(() => response.promise);
    const service = new AccountDeploymentDirectoryService({
      accountOrigin: accountSource.issuer,
      authorization: accountAuthorization("Bearer account", authorization),
      catalog: { reconcileAccountDeployments },
      fetch,
    });

    const sync = service.sync();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    authorization.abort(new Error("Account signed out."));
    response.resolve(json({ deployments: [] }, `${accountSource.issuer}/v1/account/deployments`));

    await expect(sync).rejects.toThrow(/Account signed out/u);
    expect(reconcileAccountDeployments).not.toHaveBeenCalled();
  });

  it("verifies a Personal Connect route without treating loopback as remotely reachable", async () => {
    const route = personalAccessRoute("https://studio.connect.opensteer.test", 7);
    const deployment = personalDirectoryDeployment(route, "ready");
    const reconcileAccountDeployments = vi.fn();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://accounts.opensteer.test/v1/account/deployments") {
        return json({ deployments: [deployment] }, url);
      }
      expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
      return url.endsWith("/personal-access-route")
        ? json(route, url)
        : json(testHostDescriptor(signDiscovery(personalDiscovery), ["connect-grant"]), url);
    });
    const service = new AccountDeploymentDirectoryService({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: accountAuthorization(),
      catalog: { reconcileAccountDeployments },
      fetch,
    });

    await expect(service.sync()).resolves.toEqual({
      syncedDeploymentIds: [personalDeploymentId],
      unavailable: [],
    });
    expect(reconcileAccountDeployments).toHaveBeenCalledWith({
      connections: [
        expect.objectContaining({
          authority: expect.objectContaining({ document: personalDiscovery }),
          endpoints: [
            expect.objectContaining({ kind: "direct", origin: route.document.route.origin }),
          ],
          kind: "personal" as const,
          personalAccessRoute: route,
          source: accountSource,
          preferredEndpointOrigin: route.document.route.origin,
        }),
      ],
      directoryDeployments: [deployment],
      source: accountSource,
    });
  });

  it("keeps a linked Personal deployment listed when remote access is disabled", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    const catalog = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles });
    const route = personalAccessRoute("https://studio.connect.opensteer.test", 7);
    let deployment = personalDirectoryDeployment(route, "offline");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toBe("https://accounts.opensteer.test/v1/account/deployments");
      return json({ deployments: [deployment] }, url);
    });
    const service = new AccountDeploymentDirectoryService({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: accountAuthorization(),
      catalog,
      fetch,
    });

    await expect(service.sync()).resolves.toEqual({
      syncedDeploymentIds: [personalDeploymentId],
      unavailable: [],
    });
    const restarted = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles });
    await expect(restarted.load()).resolves.toMatchObject({
      deployments: [
        {
          accountLivenessExpiresAt: "2026-08-11T20:02:00.000Z",
          endpoints: [{ kind: "canonical", origin: personalCanonicalOrigin }],
          kind: "personal" as const,
          personalAccessRoute: route,
          source: accountSource,
          preferredEndpointOrigin: null,
        },
      ],
      selectedDeploymentId: personalDeploymentId,
    });

    deployment = personalDirectoryDeployment(route, "disabled");
    await expect(service.sync()).resolves.toEqual({
      syncedDeploymentIds: [personalDeploymentId],
      unavailable: [],
    });
    await expect(restarted.load()).resolves.toMatchObject({
      deployments: [
        {
          authority: expect.objectContaining({ document: personalDiscovery }),
          createdAt: expect.any(String),
          endpoints: [
            {
              kind: "canonical",
              origin: personalCanonicalOrigin,
              verifiedAt: "2026-08-11T20:00:00.000Z",
            },
          ],
          kind: "personal" as const,
          lastUsedAt: null,
          name: "Studio Mac",
          personalAccessRoute: null,
          preferredEndpointOrigin: null,
          source: accountSource,
          updatedAt: expect.any(String),
        },
      ],
      selectedDeploymentId: personalDeploymentId,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("offers only routed entries to the platform's Personal projection", async () => {
    const personal = personalDirectoryDeployment(
      personalAccessRoute("https://unused.connect.opensteer.test", 1),
      "disabled",
    );
    const cloud = directoryDeployment();
    const reconcileAccountDeployments = vi.fn();
    // The projection is the owner computer's local metadata maintenance, and
    // it owns its own failures; this service only decides which entries reach
    // it and must reconcile every other listing regardless.
    const personalProjection = vi.fn(async () => undefined);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${accountSource.issuer}/v1/account/deployments`) {
        return json({ deployments: [personal, cloud] }, url);
      }
      expect(url).toBe(`${canonicalOrigin}/.well-known/opensteer`);
      return json(testHostDescriptor(signDiscovery(discovery), ["password"]), url);
    });
    const service = new AccountDeploymentDirectoryService({
      accountOrigin: accountSource.issuer,
      authorization: accountAuthorization(),
      catalog: { reconcileAccountDeployments },
      fetch,
      personalProjection,
    });

    await expect(service.sync()).resolves.toEqual({
      syncedDeploymentIds: [personalDeploymentId, deploymentId],
      unavailable: [],
    });
    expect(personalProjection).toHaveBeenCalledExactlyOnceWith(
      personal,
      accountSource,
      expect.any(AbortSignal),
    );
    expect(reconcileAccountDeployments).toHaveBeenCalledWith({
      connections: [
        expect.objectContaining({ kind: "personal" as const, name: "Studio Mac" }),
        expect.objectContaining({ kind: "self-hosted", name: "Home" }),
      ],
      directoryDeployments: [personal, cloud],
      source: accountSource,
    });
  });

  it("atomically replaces a rotated Personal route instead of retaining stale direct access", async () => {
    const catalog = new DeploymentCatalogStore({
      filePath: catalogPath,
      privateFiles: new MemoryPrivateFilesystem(),
    });
    let route = personalAccessRoute("https://old.connect.opensteer.test", 7);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://accounts.opensteer.test/v1/account/deployments") {
        return json({ deployments: [personalDirectoryDeployment(route, "ready")] }, url);
      }
      return url.endsWith("/personal-access-route")
        ? json(route, url)
        : json(testHostDescriptor(signDiscovery(personalDiscovery), ["connect-grant"]), url);
    });
    const service = new AccountDeploymentDirectoryService({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: accountAuthorization(),
      catalog,
      fetch,
    });

    await service.sync();
    const staleOrigin = route.document.route.origin;
    route = personalAccessRoute("https://new.connect.opensteer.test", 8);
    await service.sync();

    const persisted = await catalog.load();
    expect(persisted.deployments[0]).toMatchObject({
      endpoints: [{ kind: "direct", origin: route.document.route.origin }],
      personalAccessRoute: route,
      preferredEndpointOrigin: route.document.route.origin,
    });
    expect(JSON.stringify(persisted)).not.toContain(staleOrigin);
  });

  it("refuses a reachable route whose signing key is not pinned by Account", async () => {
    const reconcileAccountDeployments = vi.fn();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes("/v1/account/deployments")
        ? json(
            {
              deployments: [
                directoryDeployment({
                  hostKeyFingerprint: `sha256:${"b".repeat(43)}`,
                }),
              ],
            },
            url,
          )
        : json(testHostDescriptor(signDiscovery(discovery), ["password"]), url);
    });
    const service = new AccountDeploymentDirectoryService({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: accountAuthorization(),
      catalog: { reconcileAccountDeployments },
      fetch,
    });

    await expect(service.sync()).resolves.toEqual({
      syncedDeploymentIds: [],
      unavailable: [
        { accountAccess: "owner", deploymentId, name: "Home", reason: "identity-mismatch" },
      ],
    });
    expect(reconcileAccountDeployments).toHaveBeenCalledWith({
      connections: [],
      directoryDeployments: [
        directoryDeployment({ hostKeyFingerprint: `sha256:${"b".repeat(43)}` }),
      ],
      source: accountSource,
    });
  });

  it("distinguishes a Host on another protocol epoch from one that did not answer", async () => {
    const reconcileAccountDeployments = vi.fn();
    const directoryFetch = (descriptor: Readonly<Record<string, unknown>>) =>
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        return url.includes("/v1/account/deployments")
          ? json({ deployments: [directoryDeployment()] }, url)
          : json(descriptor, url);
      });
    const service = (descriptor: Readonly<Record<string, unknown>>) =>
      new AccountDeploymentDirectoryService({
        accountOrigin: "https://accounts.opensteer.test",
        authorization: accountAuthorization(),
        catalog: { reconcileAccountDeployments },
        fetch: directoryFetch(descriptor),
      });
    const compatible = testHostDescriptor(signDiscovery(discovery), ["password"]);

    await expect(
      service({ ...compatible, apiVersion: compatible.apiVersion + 1 }).sync(),
    ).resolves.toMatchObject({ unavailable: [{ deploymentId, reason: "client-too-old" }] });
    await expect(
      service({ authority: compatible.authority, bootstrapMethods: ["password"] }).sync(),
    ).resolves.toMatchObject({ unavailable: [{ deploymentId, reason: "host-too-old" }] });
  });

  it("carries the Account's access on an entry it could not verify", async () => {
    // Access decides the one move left on an unreachable listing, so it has to
    // survive verification failure — the entry never reaches the catalog.
    const reconcileAccountDeployments = vi.fn();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes("/v1/account/deployments")
        ? json(
            {
              deployments: [
                directoryDeployment({
                  access: "member",
                  hostKeyFingerprint: `sha256:${"b".repeat(43)}`,
                }),
              ],
            },
            url,
          )
        : json(testHostDescriptor(signDiscovery(discovery), ["password"]), url);
    });
    const service = new AccountDeploymentDirectoryService({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: accountAuthorization(),
      catalog: { reconcileAccountDeployments },
      fetch,
    });

    await expect(service.sync()).resolves.toEqual({
      syncedDeploymentIds: [],
      unavailable: [
        { accountAccess: "member", deploymentId, name: "Home", reason: "identity-mismatch" },
      ],
    });
  });

  it("requires Account authorization, bounds responses, and serializes concurrent sync", async () => {
    const unsigned = new AccountDeploymentDirectoryService({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: accountAuthorization(null),
      catalog: { reconcileAccountDeployments: vi.fn() },
      fetch: vi.fn(),
    });
    await expect(unsigned.sync()).rejects.toThrow("Sign in");

    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      await pending;
      return json({ deployments: [] }, String(input));
    });
    const service = new AccountDeploymentDirectoryService({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: accountAuthorization(),
      catalog: { reconcileAccountDeployments: vi.fn() },
      fetch,
    });
    const first = service.sync();
    const second = service.sync();
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { syncedDeploymentIds: [], unavailable: [] },
      { syncedDeploymentIds: [], unavailable: [] },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);

    const oversized = new AccountDeploymentDirectoryService({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: accountAuthorization(),
      catalog: { reconcileAccountDeployments: vi.fn() },
      fetch: async () =>
        new Response("x".repeat(1_024 * 1_024 + 1), {
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(oversized.sync()).rejects.toThrow("too large");
  });
});

function directoryDeployment(
  overrides: { access?: "member" | "owner"; hostKeyFingerprint?: string } = {},
) {
  const authority = discovery;
  return AccountDeploymentDirectoryEntrySchema.parse({
    access: overrides.access ?? "owner",
    authorityEnvelope: signDiscovery(authority),
    authority: {
      canonicalOrigin: authority.canonicalOrigin,
      deploymentId: authority.deploymentId,
      hostInstanceId: authority.hostInstanceId,
      hostKeyFingerprint: overrides.hostKeyFingerprint ?? discoveryFingerprint,
    },
    canonicalOrigin: authority.canonicalOrigin,
    generation: 1,
    id: deploymentId,
    lifecycle: "active",
    name: "Home",
    reachability: "canonical",
    updatedAt: "2026-08-11T20:00:00.000Z",
  });
}

function personalDirectoryDeployment(
  route: PersonalHostAccessRouteEnvelope,
  state: "disabled" | "offline" | "ready",
): AccountDeploymentDirectoryEntry {
  const reachable = state === "offline" || state === "ready";
  return AccountDeploymentDirectoryEntrySchema.parse({
    access: "owner",
    accountLink: {
      generation: "a".repeat(43),
      issuer: accountSource.issuer,
      subject: accountSource.subject,
    },
    authorityEnvelope: signDiscovery(personalDiscovery),
    authority: {
      canonicalOrigin: personalDiscovery.canonicalOrigin,
      deploymentId: personalDiscovery.deploymentId,
      hostInstanceId: personalDiscovery.hostInstanceId,
      hostKeyFingerprint: personalFingerprint,
    },
    connectResourceState: reachable ? "ready" : "disabled",
    connectRoute: reachable ? route : null,
    generation: 1,
    id: personalDeploymentId,
    lastSeenAt: reachable
      ? {
          expiresAt: state === "ready" ? "2099-08-11T20:02:00.000Z" : "2026-08-11T20:02:00.000Z",
          observedAt: "2026-08-11T20:00:00.000Z",
        }
      : null,
    lifecycle: "active",
    name: "Studio Mac",
    reachability: "routed",
    updatedAt: "2026-08-11T20:00:00.000Z",
  });
}

function personalAccessRoute(origin: string, generation: number): PersonalHostAccessRouteEnvelope {
  const document = {
    authority: personalDiscovery,
    documentVersion: 2 as const,
    purpose: "opensteer-personal-access-route" as const,
    route: { generation, kind: "connect" as const, origin },
  };
  return signTestPersonalAccessRoute(document, personalKeys);
}

function json(value: unknown, url: string): Response {
  const response = Response.json(value);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function signDiscovery(document: HostDiscoveryDocument): HostDiscoveryEnvelope {
  return signTestDiscoveryEnvelope(
    document,
    document.deploymentId === personalDeploymentId ? personalKeys : discoveryKeys,
  );
}
