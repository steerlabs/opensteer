import { randomUUID } from "node:crypto";
import { ConnectOperationIdSchema } from "@opensteer/control-plane-protocol";
import { describe, expect, it } from "vitest";
import {
  CloudflareConnectProvider,
  connectResourceNotFoundMessage,
  type ConnectResourceProvider,
} from "./cloudflare-connect-provider.js";
import { MemoryConnectProvider } from "./memory-connect-provider.test-support.js";

/*
 * One contract, two providers: Cloudflare's, with its HTTP boundary answered by a stateful stand-in
 * for Cloudflare's API (as the provider's own tests answer it), and the in-memory provider the
 * first-run journey hands the account service. Whatever the account service can observe of a
 * provider (what a call returns, what it refuses, what a retry finds) is the same for both.
 */

const deploymentId = "dep_11111111-1111-4111-8111-111111111111";
const hostname = "d-11111111-1111-4111-8111-111111111111.connect.opensteer.test";
const localOrigin = "http://127.0.0.1:4310";
const tunnelName = "opensteer-11111111-1111-4111-8111-111111111111";

const providers: readonly {
  readonly name: string;
  readonly create: () => ConnectResourceProvider;
}[] = [
  {
    name: "CloudflareConnectProvider at its HTTP boundary",
    create: () =>
      new CloudflareConnectProvider({
        accountId: "a".repeat(32),
        apiToken: "api-token-secret-value",
        credentialDerivationSecret: "d".repeat(32),
        fetch: cloudflareApi(),
        zoneId: "b".repeat(32),
      }),
  },
  { name: "MemoryConnectProvider", create: () => new MemoryConnectProvider() },
];

describe.each(providers)("the Connect provider contract: $name", ({ create }) => {
  it("provisions one tunnel and route for a Deployment, and finds the same ones on a retry", async () => {
    const provider = create();
    const first = await provider.ensure({ deploymentId, hostname, localOrigin });
    expect(first).toMatchObject({ hostname, tunnelName });
    expect(first.tunnelId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.dnsRecordId).toMatch(/^[a-f0-9]{32}$/u);
    expect(first.connectorToken.length).toBeGreaterThanOrEqual(32);
    // A lost answer: the next ensure, with nothing stored, adopts what the first one made.
    const retried = await provider.ensure({ deploymentId, hostname, localOrigin });
    expect(retried).toMatchObject({
      dnsRecordId: first.dnsRecordId,
      tunnelId: first.tunnelId,
      tunnelName,
    });
    // With the stored resource, it reconciles that one exactly.
    const { connectorToken: _token, ...stored } = first;
    await expect(
      provider.ensure({ deploymentId, expected: stored, hostname, localOrigin }),
    ).resolves.toMatchObject(stored);
  });

  it("refuses what doesn't belong to the Deployment, or isn't a Connect address", async () => {
    const provider = create();
    const { connectorToken: _token, ...stored } = await provider.ensure({
      deploymentId,
      hostname,
      localOrigin,
    });
    await expect(
      provider.ensure({
        deploymentId,
        expected: { ...stored, hostname: `x${hostname}` },
        hostname,
        localOrigin,
      }),
    ).rejects.toThrow(
      new TypeError("Stored Connect resource does not match the Deployment identity"),
    );
    await expect(
      provider.ensure({ deploymentId, hostname: hostname.toUpperCase(), localOrigin }),
    ).rejects.toThrow(new TypeError("Connect hostname is invalid"));
    await expect(
      provider.ensure({ deploymentId, hostname, localOrigin: "https://example.test:4310" }),
    ).rejects.toThrow(
      new TypeError("Connect local origin must be a bare HTTP loopback origin with a port"),
    );
    await expect(
      provider.ensure({ deploymentId: "dep_not-an-id", hostname, localOrigin }),
    ).rejects.toThrow();
  });

  it("rotates the connector's credential, and reads the current one back", async () => {
    const provider = create();
    const { connectorToken, ...stored } = await provider.ensure({
      deploymentId,
      hostname,
      localOrigin,
    });
    await expect(provider.readConnectorToken(stored)).resolves.toBe(connectorToken);
    const rotated = await provider.rotateConnectorToken(
      stored,
      ConnectOperationIdSchema.parse(`cop_${randomUUID()}`),
    );
    expect(rotated).not.toBe(connectorToken);
    await expect(provider.readConnectorToken(stored)).resolves.toBe(rotated);
  });

  it("deletes the route and tunnel, and says a deleted one is not there", async () => {
    const provider = create();
    const { connectorToken: _token, ...stored } = await provider.ensure({
      deploymentId,
      hostname,
      localOrigin,
    });
    await provider.delete({ deploymentId, expected: stored, hostname });
    await expect(provider.readConnectorToken(stored)).rejects.toThrow(
      connectResourceNotFoundMessage,
    );
    // Deleting again, or with nothing stored, finds nothing to delete and is not a failure.
    await expect(provider.delete({ deploymentId, expected: stored, hostname })).resolves.toBe(
      undefined,
    );
    await expect(provider.delete({ deploymentId, hostname })).resolves.toBe(undefined);
    // A fresh ensure makes a new tunnel.
    const again = await provider.ensure({ deploymentId, hostname, localOrigin });
    expect(again.tunnelId).not.toBe(stored.tunnelId);
  });
});

/**
 * Cloudflare's API as `CloudflareConnectProvider` uses it, with state: tunnels, their
 * configuration, their secret, and DNS records, answered in Cloudflare's envelope, and 404 for a
 * resource that is gone. Only the endpoints the provider calls are here.
 */
function cloudflareApi(): typeof globalThis.fetch {
  const tunnels = new Map<string, { id: string; name: string; secret: number }>();
  const records = new Map<
    string,
    { id: string; name: string; content: string; comment: string; proxied: true; type: "CNAME" }
  >();
  const ok = (result: unknown) =>
    new Response(JSON.stringify({ errors: [], messages: [], result, success: true }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  const gone = () =>
    new Response(JSON.stringify({ errors: [{ code: 1000 }], success: false }), { status: 404 });
  const tunnel = (row: { id: string; name: string }) => ({
    config_src: "cloudflare",
    id: row.id,
    metadata: {},
    name: row.name,
  });
  return async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = url.pathname.replace(/^\/client\/v4/u, "");
    let match: RegExpExecArray | null;
    if (/^\/accounts\/[a-f0-9]{32}\/cfd_tunnel$/u.test(path)) {
      if (method === "GET") {
        const name = url.searchParams.get("name");
        return ok([...tunnels.values()].filter((row) => row.name === name).map(tunnel));
      }
      const row = { id: randomUUID(), name: String(body["name"]), secret: 0 };
      tunnels.set(row.id, row);
      return ok(tunnel(row));
    }
    if ((match = /^\/accounts\/[a-f0-9]{32}\/cfd_tunnel\/([^/]+)(\/[a-z]+)?$/u.exec(path))) {
      const row = tunnels.get(match[1]!);
      const rest = match[2];
      if (rest === "/connections" && method === "DELETE") return row ? ok(null) : gone();
      if (!row) return gone();
      if (rest === "/configurations") return ok({ version: 1 });
      if (rest === "/token") return ok(`token-${row.id}-${row.secret}`.padEnd(48, "t"));
      if (method === "PATCH") {
        row.secret += 1;
        return ok(tunnel(row));
      }
      if (method === "DELETE") {
        tunnels.delete(row.id);
        return ok(null);
      }
      return ok(tunnel(row));
    }
    if (/^\/zones\/[a-f0-9]{32}\/dns_records$/u.test(path)) {
      if (method === "GET") {
        const name = url.searchParams.get("name");
        return ok([...records.values()].filter((row) => row.name === name));
      }
      const row = {
        comment: String(body["comment"]),
        content: String(body["content"]),
        id: randomUUID().replaceAll("-", ""),
        name: String(body["name"]),
        proxied: true as const,
        type: "CNAME" as const,
      };
      records.set(row.id, row);
      return ok(row);
    }
    if ((match = /^\/zones\/[a-f0-9]{32}\/dns_records\/([a-f0-9]{32})$/u.exec(path))) {
      const row = records.get(match[1]!);
      if (!row) return gone();
      if (method === "DELETE") {
        records.delete(row.id);
        return ok(null);
      }
      return ok(row);
    }
    throw new Error(
      `The provider asked Cloudflare for something this stand-in lacks: ${method} ${path}`,
    );
  };
}
