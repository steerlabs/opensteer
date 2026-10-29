import { describe, expect, it, vi } from "vitest";
import { ConnectOperationIdSchema } from "@opensteer/control-plane-protocol";
import { CloudflareConnectProvider } from "./cloudflare-connect-provider.js";

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const tunnelId = "11111111-1111-4111-8111-111111111111";
const dnsRecordId = "c".repeat(32);
const deploymentId = "dep_11111111-1111-4111-8111-111111111111";
const hostname = "d-11111111-1111-4111-8111-111111111111.connect.opensteer.test";
const dnsComment = `Opensteer Connect:${deploymentId}`;

describe("CloudflareConnectProvider", () => {
  it("creates one remote tunnel with path-unrestricted loopback ingress, DNS route, and scoped token", async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ body, method: String(init?.method), url });
      if (url.includes("/cfd_tunnel?") && init?.method === "GET") return envelope([]);
      if (url.endsWith("/cfd_tunnel") && init?.method === "POST") {
        return envelope({
          id: tunnelId,
          name: `opensteer-${deploymentId.slice(4)}`,
          config_src: "cloudflare",
          metadata: { managed_by: "opensteer", deployment_id: deploymentId },
        });
      }
      if (url.endsWith("/configurations")) return envelope({ version: 1 });
      if (url.includes("/dns_records?") && init?.method === "GET") return envelope([]);
      if (url.endsWith("/dns_records")) {
        return envelope({
          id: dnsRecordId,
          name: hostname,
          content: `${tunnelId}.cfargotunnel.com`,
          comment: dnsComment,
          proxied: true,
          type: "CNAME",
        });
      }
      if (url.endsWith("/token")) return envelope("t".repeat(64));
      throw new Error(`unexpected ${url}`);
    });
    const provider = createProvider(fetch);

    await expect(
      provider.ensure({ deploymentId, hostname, localOrigin: "http://127.0.0.1:4310" }),
    ).resolves.toMatchObject({ dnsRecordId, hostname, tunnelId, connectorToken: "t".repeat(64) });
    expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      `GET /client/v4/accounts/${accountId}/cfd_tunnel`,
      `POST /client/v4/accounts/${accountId}/cfd_tunnel`,
      `PUT /client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
      `GET /client/v4/zones/${zoneId}/dns_records`,
      `POST /client/v4/zones/${zoneId}/dns_records`,
      `GET /client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
    ]);
    expect(requests[2]?.body).toEqual({
      config: {
        ingress: [{ hostname, service: "http://127.0.0.1:4310" }, { service: "http_status:404" }],
      },
    });
    expect(requests[4]?.body).toMatchObject({ comment: dnsComment });
    for (const call of fetch.mock.calls) {
      expect((call[1]?.headers as Record<string, string> | undefined)?.authorization).toBe(
        "Bearer api-token-secret-value",
      );
    }
  });

  it("recovers resources created before a lost response by deterministic identity", async () => {
    const methods: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      methods.push(String(init?.method));
      if (url.includes("/cfd_tunnel?")) {
        return envelope([
          {
            id: tunnelId,
            name: `opensteer-${deploymentId.slice(4)}`,
            config_src: "cloudflare",
          },
        ]);
      }
      if (url.endsWith("/configurations")) return envelope({ version: 3 });
      if (url.includes("/dns_records?")) {
        return envelope([
          {
            id: dnsRecordId,
            name: hostname,
            content: `${tunnelId}.cfargotunnel.com`,
            comment: dnsComment,
            proxied: true,
            type: "CNAME",
          },
        ]);
      }
      if (url.endsWith("/token")) return envelope("w".repeat(64));
      throw new Error(`unexpected ${url}`);
    });
    await expect(
      createProvider(fetch).ensure({
        deploymentId,
        hostname,
        localOrigin: "http://127.0.0.1:4310",
      }),
    ).resolves.toMatchObject({ dnsRecordId, tunnelId });
    expect(methods).toEqual(["GET", "PUT", "GET", "GET"]);
  });

  it("reconciles an exact stored resource without creating a second tunnel or DNS record", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/cfd_tunnel/${tunnelId}`)) {
        return envelope({
          id: tunnelId,
          name: `opensteer-${deploymentId.slice(4)}`,
          config_src: "cloudflare",
          metadata: { managed_by: "opensteer", deployment_id: deploymentId },
        });
      }
      if (url.endsWith(`/dns_records/${dnsRecordId}`)) {
        return envelope({
          id: dnsRecordId,
          name: hostname,
          content: `${tunnelId}.cfargotunnel.com`,
          comment: dnsComment,
          proxied: true,
          type: "CNAME",
        });
      }
      if (url.endsWith("/configurations")) return envelope({ version: 2 });
      if (url.endsWith("/token")) return envelope("u".repeat(64));
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const provider = createProvider(fetch);
    await provider.ensure({
      deploymentId,
      expected: {
        dnsRecordId,
        hostname,
        tunnelId,
        tunnelName: `opensteer-${deploymentId.slice(4)}`,
      },
      hostname,
      localOrigin: "http://localhost:4310",
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
  });

  it("creates and reuses an exact no-Worker route above a broader zone route", async () => {
    const workersRouteId = "e".repeat(32);
    const pattern = `${hostname}/*`;
    let routeCreated = false;
    const requests: Array<{ body: unknown; method: string; path: string }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ body, method: String(init?.method), path: new URL(url).pathname });
      if (url.includes("/cfd_tunnel?")) {
        return envelope([
          {
            id: tunnelId,
            name: `opensteer-${deploymentId.slice(4)}`,
            config_src: "cloudflare",
          },
        ]);
      }
      if (url.endsWith("/configurations")) return envelope({ version: 3 });
      if (url.includes("/dns_records?")) {
        return envelope([
          {
            id: dnsRecordId,
            name: hostname,
            content: `${tunnelId}.cfargotunnel.com`,
            comment: dnsComment,
            proxied: true,
            type: "CNAME",
          },
        ]);
      }
      if (url.endsWith("/workers/routes") && init?.method === "GET") {
        return envelope([
          { id: "f".repeat(32), pattern: "*.opensteer.test/*", script: "app-gateway" },
          ...(routeCreated ? [{ id: workersRouteId, pattern }] : []),
        ]);
      }
      if (url.endsWith("/workers/routes") && init?.method === "POST") {
        routeCreated = true;
        return envelope({ id: workersRouteId, pattern });
      }
      if (url.endsWith("/token")) return envelope("w".repeat(64));
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const provider = createProvider(fetch, true);

    await provider.ensure({ deploymentId, hostname, localOrigin: "http://127.0.0.1:4310" });
    await provider.ensure({ deploymentId, hostname, localOrigin: "http://127.0.0.1:4310" });

    const routeCreates = requests.filter(
      (request) => request.path.endsWith("/workers/routes") && request.method === "POST",
    );
    expect(routeCreates).toEqual([
      { body: { pattern }, method: "POST", path: `/client/v4/zones/${zoneId}/workers/routes` },
    ]);
  });

  it("fails closed when the exact Connect hostname is assigned to a Worker", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/cfd_tunnel?")) {
        return envelope([
          {
            id: tunnelId,
            name: `opensteer-${deploymentId.slice(4)}`,
            config_src: "cloudflare",
          },
        ]);
      }
      if (url.endsWith("/configurations")) return envelope({ version: 3 });
      if (url.includes("/dns_records?")) {
        return envelope([
          {
            id: dnsRecordId,
            name: hostname,
            content: `${tunnelId}.cfargotunnel.com`,
            comment: dnsComment,
            proxied: true,
            type: "CNAME",
          },
        ]);
      }
      if (url.endsWith("/workers/routes") && init?.method === "GET") {
        return envelope([{ id: "e".repeat(32), pattern: `${hostname}/*`, script: "other" }]);
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });

    await expect(
      createProvider(fetch, true).ensure({
        deploymentId,
        hostname,
        localOrigin: "http://127.0.0.1:4310",
      }),
    ).rejects.toThrow(/assigned to a Worker/u);
    expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
  });

  it("rotates the tunnel secret, disconnects old connectors, and returns the new token", async () => {
    const methods: string[] = [];
    const rotationSecrets: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      methods.push(String(init?.method));
      if (url.endsWith(`/cfd_tunnel/${tunnelId}`)) {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (init?.method === "PATCH") {
          expect(body.tunnel_secret).toMatch(/^[A-Za-z0-9+/]+=*$/u);
          rotationSecrets.push(body.tunnel_secret);
        }
        return envelope({
          id: tunnelId,
          name: `opensteer-${deploymentId.slice(4)}`,
          config_src: "cloudflare",
        });
      }
      if (url.endsWith("/connections")) return envelope({});
      if (url.endsWith("/token")) return envelope("v".repeat(64));
      throw new Error(`unexpected ${url}`);
    });
    await expect(
      createProvider(fetch).rotateConnectorToken(
        {
          dnsRecordId,
          hostname,
          tunnelId,
          tunnelName: `opensteer-${deploymentId.slice(4)}`,
        },
        ConnectOperationIdSchema.parse("cop_11111111-1111-4111-8111-111111111111"),
      ),
    ).resolves.toBe("v".repeat(64));
    await expect(
      createProvider(fetch).rotateConnectorToken(
        {
          dnsRecordId,
          hostname,
          tunnelId,
          tunnelName: `opensteer-${deploymentId.slice(4)}`,
        },
        ConnectOperationIdSchema.parse("cop_11111111-1111-4111-8111-111111111111"),
      ),
    ).resolves.toBe("v".repeat(64));
    expect(methods).toEqual(["GET", "PATCH", "DELETE", "GET", "GET", "PATCH", "DELETE", "GET"]);
    expect(rotationSecrets).toEqual([rotationSecrets[0], rotationSecrets[0]]);
  });

  it("derives different rotation secrets for the same operation ID on different tunnels", async () => {
    const otherTunnelId = "22222222-2222-4222-8222-222222222222";
    const operationId = ConnectOperationIdSchema.parse("cop_11111111-1111-4111-8111-111111111111");
    const rotationSecrets = new Map<string, string>();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const currentTunnelId = url.includes(otherTunnelId) ? otherTunnelId : tunnelId;
      if (url.endsWith(`/cfd_tunnel/${currentTunnelId}`)) {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as { readonly tunnel_secret: string };
          rotationSecrets.set(currentTunnelId, body.tunnel_secret);
        }
        return envelope({
          id: currentTunnelId,
          name: `opensteer-${currentTunnelId}`,
          config_src: "cloudflare",
        });
      }
      if (url.endsWith("/connections")) return envelope({});
      if (url.endsWith("/token")) return envelope("v".repeat(64));
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const provider = createProvider(fetch);

    for (const currentTunnelId of [tunnelId, otherTunnelId]) {
      await provider.rotateConnectorToken(
        {
          dnsRecordId,
          hostname,
          tunnelId: currentTunnelId,
          tunnelName: `opensteer-${currentTunnelId}`,
        },
        operationId,
      );
    }

    expect(rotationSecrets.get(tunnelId)).not.toBe(rotationSecrets.get(otherTunnelId));
  });

  it("treats already-removed resources as a completed revocation", async () => {
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }));
    await expect(
      createProvider(fetch).delete({
        deploymentId,
        expected: {
          dnsRecordId,
          hostname,
          tunnelId,
          tunnelName: `opensteer-${deploymentId.slice(4)}`,
        },
        hostname,
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("verifies stored resource identity before destructive requests", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      const url = String(input);
      if (url.endsWith(`/cfd_tunnel/${tunnelId}`)) {
        return envelope({
          id: tunnelId,
          name: "someone-elses-tunnel",
          config_src: "cloudflare",
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    await expect(
      createProvider(fetch).delete({
        deploymentId,
        expected: {
          dnsRecordId,
          hostname,
          tunnelId,
          tunnelName: `opensteer-${deploymentId.slice(4)}`,
        },
        hostname,
      }),
    ).rejects.toThrow(/identity/u);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("discovers and removes resources when their create response was lost before persistence", async () => {
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method} ${new URL(url).pathname}`);
      if (url.includes("/cfd_tunnel?") && init?.method === "GET") {
        return envelope([
          {
            id: tunnelId,
            name: `opensteer-${deploymentId.slice(4)}`,
            config_src: "cloudflare",
          },
        ]);
      }
      if (url.includes("/dns_records?") && init?.method === "GET") {
        return envelope([
          {
            id: dnsRecordId,
            name: hostname,
            content: `${tunnelId}.cfargotunnel.com`,
            comment: dnsComment,
            proxied: true,
            type: "CNAME",
          },
        ]);
      }
      if (init?.method === "DELETE") return envelope({});
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    await createProvider(fetch).delete({ deploymentId, hostname });
    expect(requests).toEqual([
      `GET /client/v4/accounts/${accountId}/cfd_tunnel`,
      `GET /client/v4/zones/${zoneId}/dns_records`,
      `DELETE /client/v4/zones/${zoneId}/dns_records/${dnsRecordId}`,
      `DELETE /client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`,
      `DELETE /client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
    ]);
  });

  it("removes the exact no-Worker route while preserving broader Worker routes", async () => {
    const workersRouteId = "e".repeat(32);
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method} ${new URL(url).pathname}`);
      if (url.includes("/cfd_tunnel?")) return envelope([]);
      if (url.includes("/dns_records?")) return envelope([]);
      if (url.endsWith("/workers/routes") && init?.method === "GET") {
        return envelope([
          { id: "f".repeat(32), pattern: "*.opensteer.test/*", script: "app-gateway" },
          { id: workersRouteId, pattern: `${hostname}/*` },
        ]);
      }
      if (url.endsWith(`/workers/routes/${workersRouteId}`) && init?.method === "DELETE") {
        return envelope({});
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });

    await createProvider(fetch, true).delete({ deploymentId, hostname });

    expect(requests).toEqual([
      `GET /client/v4/accounts/${accountId}/cfd_tunnel`,
      `GET /client/v4/zones/${zoneId}/dns_records`,
      `GET /client/v4/zones/${zoneId}/workers/routes`,
      `DELETE /client/v4/zones/${zoneId}/workers/routes/${workersRouteId}`,
    ]);
  });

  it("removes a dangling managed DNS route after its deterministic tunnel is already gone", async () => {
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method} ${new URL(url).pathname}`);
      if (url.includes("/cfd_tunnel?") && init?.method === "GET") return envelope([]);
      if (url.includes("/dns_records?") && init?.method === "GET") {
        return envelope([
          {
            id: dnsRecordId,
            name: hostname,
            content: `${tunnelId}.cfargotunnel.com`,
            comment: dnsComment,
            proxied: true,
            type: "CNAME",
          },
        ]);
      }
      if (init?.method === "DELETE") return envelope({});
      throw new Error(`unexpected ${init?.method} ${url}`);
    });

    await createProvider(fetch).delete({ deploymentId, hostname });

    expect(requests).toEqual([
      `GET /client/v4/accounts/${accountId}/cfd_tunnel`,
      `GET /client/v4/zones/${zoneId}/dns_records`,
      `DELETE /client/v4/zones/${zoneId}/dns_records/${dnsRecordId}`,
    ]);
  });

  it("does not delete an exact hostname without the Deployment ownership marker", async () => {
    const methods: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      methods.push(String(init?.method));
      if (url.includes("/cfd_tunnel?")) return envelope([]);
      if (url.includes("/dns_records?")) {
        return envelope([
          {
            id: dnsRecordId,
            name: hostname,
            content: `${tunnelId}.cfargotunnel.com`,
            comment: "created by someone else",
            proxied: true,
            type: "CNAME",
          },
        ]);
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });

    await expect(createProvider(fetch).delete({ deploymentId, hostname })).rejects.toThrow(
      /another resource/u,
    );
    expect(methods).toEqual(["GET", "GET"]);
  });

  it("rejects non-loopback origins before sending Cloudflare credentials", async () => {
    const fetch = vi.fn();
    await expect(
      createProvider(fetch).ensure({
        deploymentId,
        hostname,
        localOrigin: "http://192.168.1.10:4310",
      }),
    ).rejects.toThrow("loopback");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not surface Cloudflare response bodies or API credentials in errors", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ message: "leaked upstream detail" }] }),
          {
            status: 403,
          },
        ),
    );
    let message = "";
    try {
      await createProvider(fetch).ensure({
        deploymentId,
        hostname,
        localOrigin: "http://127.0.0.1:4310",
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain("leaked upstream detail");
    expect(message).not.toContain("api-token-secret-value");
  });

  it("bounds Cloudflare response bodies before parsing them", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: "x".repeat(1_024 * 1_024), success: true }), {
          status: 200,
        }),
    );
    await expect(
      createProvider(fetch).ensure({
        deploymentId,
        hostname,
        localOrigin: "http://127.0.0.1:4310",
      }),
    ).rejects.toThrow("too large");
  });
});

function createProvider(fetch: typeof globalThis.fetch, workersRouteBypass = false) {
  return new CloudflareConnectProvider({
    accountId,
    apiToken: "api-token-secret-value",
    credentialDerivationSecret: "derivation-secret-value-that-is-at-least-32-bytes",
    fetch,
    workersRouteBypass,
    zoneId,
  });
}

function envelope(result: unknown): Response {
  return Response.json({ errors: [], messages: [], result, success: true });
}
