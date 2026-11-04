import { expect, it, vi } from "vitest";
import { HostSessionExchange, type NativeOAuthManager } from "@opensteer/client/auth";
import { DeploymentCatalogSchema } from "@opensteer/client/connections";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { testDeploymentConnection } from "../../test-support/deployment-fixtures.js";
import { MemorySecureStore } from "../platform/memory-secure-store.js";
import { createSecureRecordStore } from "../platform/secure-record-store.js";
import { createPersonalSessionStore } from "./personal-session-store.js";
import { createNetworkHostPort } from "./host-port.js";

it.each([false, true])(
  "recovers an expired maintenance session across an epoch mismatch; wrong identity=%s",
  async (wrongIdentity) => {
    const connection = testDeploymentConnection({ kind: "personal", route: { kind: "connect" } });
    if (connection.reachability !== "routed") throw new Error("Expected route");
    const deploymentId = connection.authority.document.deploymentId;
    const sessions = createPersonalSessionStore(
      createSecureRecordStore({
        secureStore: new MemorySecureStore(),
        keyPrefix: "maintenance-test",
      }),
    );
    const token = `${"a".repeat(43)}.${"b".repeat(43)}=`;
    await sessions.save({
      deploymentId,
      token,
      expiresAt: "2020-01-01T00:00:00.000Z",
      absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    const authority = wrongIdentity
      ? testDeploymentConnection({
          kind: "personal",
          deploymentId: "dep_0192f4a1-4444-4000-8000-000000000004",
        }).authority
      : connection.authority;
    const status = { supported: true, state: null, operation: null, revision: "host:0" };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/personal-access-route"))
        return Response.json(connection.personalAccessRoute);
      if (url.endsWith("/.well-known/opensteer"))
        return Response.json({
          authority,
          apiVersion: hostApiVersion - 1,
          bootstrapMethods: ["connect-grant"],
          capabilities: [],
        });
      return new Headers(init?.headers).has("authorization")
        ? Response.json(status)
        : Response.json({}, { status: 401 });
    });
    const exchange = new HostSessionExchange({
      application: "mobile",
      account: { issuePersonalHostSessionGrant: vi.fn() },
      fetch: (_id, input, init) => fetch(input, init),
    });
    const establish = vi.spyOn(exchange, "establish").mockResolvedValue({
      credentialDelivery: "header",
      credential: {
        token,
        expiresAt: "2099-01-01T00:00:00.000Z",
        absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    } as Awaited<ReturnType<HostSessionExchange["establish"]>>);
    const oauth = {
      subscribeHostCredentials: () => () => {},
      authorizationHeader: vi.fn(),
    } as unknown as NativeOAuthManager;
    const port = createNetworkHostPort({
      fetch,
      now: () => new Date(),
      lifecycle: {
        getSnapshot: () => ({ network: "online", visibility: "foreground" }),
        onBackground: () => () => {},
        onForeground: () => () => {},
        onNetworkChange: () => () => {},
      },
      openWebSocket: vi.fn(),
    })({ oauth, sessions, sessionExchange: exchange });
    const updates = port.desktopUpdates({
      deploymentId,
      catalog: {
        load: async () =>
          DeploymentCatalogSchema.parse({
            schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
            revision: 1,
            deployments: [connection],
            selectedDeploymentId: deploymentId,
            updatedAt: new Date().toISOString(),
          }),
        subscribe: () => () => {},
      },
    });
    if (wrongIdentity) {
      await expect(updates.status()).rejects.toMatchObject({ reason: "invalid-response" });
      expect(establish).not.toHaveBeenCalled();
      expect(
        fetch.mock.calls.every(([, init]) => !new Headers(init?.headers).has("authorization")),
      ).toBe(true);
    } else {
      await expect(updates.status()).resolves.toEqual(status);
      expect(establish).toHaveBeenCalledOnce();
      expect(await sessions.authorization(deploymentId, new Date())).toContain(token);
    }
  },
);
