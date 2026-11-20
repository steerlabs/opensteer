import { createServer } from "node:http";
import { CloudComputerIdSchema } from "@opensteer/control-plane-protocol";
import { expect, it, vi } from "vitest";
import { CloudflareDns } from "./cloudflare.js";
import { HetznerCloud } from "./hetzner.js";
import { provisionerFailure, RemoteRequestError } from "./http.js";

const token = "provider_credential_must_never_escape";
const zoneId = "0".repeat(32);
const signal = new AbortController().signal;
const id = CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000001");
const labels = {
  "opensteer.com/cloud-computer": id,
  "opensteer.com/generation": "3",
};
const name = `os-${id.replace("_", "-")}-3`;
const baseVm = {
  id: 12,
  labels,
  name,
  status: "off",
  public_net: {
    ipv4: { ip: "192.0.2.1", blocked: false },
    ipv6: { ip: "2001:db8:abcd::/64", blocked: false },
    firewalls: [{ id: 31, status: "applied" }],
  },
};
const createVm = {
  id,
  generation: 3,
  region: "fsn1",
  serverType: "cpx22",
  image: "ubuntu-24.04",
  userData: "#cloud-config",
  firewallId: 31,
};
const meta = (nextPage: number | null = null) => ({ pagination: { next_page: nextPage } });
const action = (status = "success") => ({ action: { id: 19, status } });

interface Exchange {
  method: string;
  path: string;
  matches?: (url: URL, body: unknown) => void;
  status?: number;
  headers?: Record<string, string>;
  response: unknown;
}

async function withServer(exchanges: readonly Exchange[], run: (origin: URL) => Promise<void>) {
  let index = 0;
  let serverError: unknown;
  const server = createServer(async (req, res) => {
    try {
      const exchange = exchanges[index++];
      expect(exchange).toBeDefined();
      const url = new URL(req.url ?? "/", "http://localhost");
      expect(req.method).toBe(exchange?.method);
      expect(url.pathname).toBe(exchange?.path);
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      exchange?.matches?.(url, text ? JSON.parse(text) : undefined);
      res
        .writeHead(exchange?.status ?? 200, {
          "content-type": "application/json",
          ...exchange?.headers,
        })
        .end(JSON.stringify(exchange?.response));
    } catch (error) {
      serverError = error;
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No fake HTTP server address");
    await run(new URL(`http://127.0.0.1:${address.port}`));
    if (serverError) throw serverError;
    expect(index).toBe(exchanges.length);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}

function hetzner(origin: URL, wait = vi.fn(async (_ms: number) => {})) {
  return new HetznerCloud({
    token,
    timeoutMs: 2000,
    actionTimeoutMs: 5000,
    baseUrl: new URL("/v1/", origin),
    wait,
  });
}

it("lists all matching VMs and honors Retry-After during a bounded retry", async () => {
  function page(n: number) {
    return (url: URL) => {
      expect(url.searchParams.get("label_selector")).toBe(`opensteer.com/cloud-computer=${id}`);
      expect(url.searchParams.get("page")).toBe(String(n));
    };
  }
  await withServer(
    [
      {
        method: "GET",
        path: "/v1/servers",
        matches: page(1),
        status: 429,
        headers: { "retry-after": "1" },
        response: { error: { message: token } },
      },
      {
        method: "GET",
        path: "/v1/servers",
        matches: page(1),
        response: { servers: [], meta: meta(2) },
      },
      {
        method: "GET",
        path: "/v1/servers",
        matches: page(2),
        response: { servers: [baseVm], meta: meta() },
      },
    ],
    async (origin) => {
      const wait = vi.fn(async (_ms: number) => {});
      await expect(hetzner(origin, wait).find(id, signal)).resolves.toEqual([
        {
          id: 12,
          generation: 3,
          status: "off",
          ipv4: "192.0.2.1",
          ipv6: "2001:db8:abcd::1",
          firewalls: [{ id: 31, status: "applied" }],
        },
      ]);
      expect(wait.mock.calls[0]?.[0]).toBeGreaterThan(0);
      expect(wait.mock.calls[0]?.[0]).toBeLessThanOrEqual(1000);
    },
  );
});

it.each([409, 422])("adopts the deterministically named VM after HTTP %i", async (status) => {
  await withServer(
    [
      { method: "POST", path: "/v1/servers", status, response: { error: { message: token } } },
      {
        method: "GET",
        path: "/v1/servers",
        matches: (url) => {
          expect(url.searchParams.get("label_selector")).toBe(
            `opensteer.com/cloud-computer=${id},opensteer.com/generation=3`,
          );
        },
        response: { servers: [baseVm], meta: meta() },
      },
    ],
    async (origin) => {
      await expect(hetzner(origin).create(createVm, signal)).resolves.toMatchObject({ id: 12 });
    },
  );
});

it("creates a stopped VM, polls actions, powers on, shuts down, and deletes", async () => {
  await withServer(
    [
      {
        method: "POST",
        path: "/v1/servers",
        status: 201,
        matches: (_url, body) =>
          expect(body).toEqual({
            name,
            server_type: "cpx22",
            location: "fsn1",
            image: "ubuntu-24.04",
            user_data: "#cloud-config",
            labels,
            firewalls: [{ firewall: 31 }],
            public_net: { enable_ipv4: true, enable_ipv6: true },
            start_after_create: false,
          }),
        response: {
          server: baseVm,
          ...action("running"),
          next_actions: [{ id: 20, status: "running" }],
          root_password: token,
        },
      },
      { method: "GET", path: "/v1/servers/actions/19", response: action() },
      {
        method: "GET",
        path: "/v1/servers/actions/20",
        response: { action: { id: 20, status: "success" } },
      },
      { method: "GET", path: "/v1/servers/12", response: { server: baseVm } },
      {
        method: "POST",
        path: "/v1/servers/12/actions/poweron",
        status: 201,
        response: action("running"),
      },
      { method: "GET", path: "/v1/servers/actions/19", response: action() },
      { method: "POST", path: "/v1/servers/12/actions/shutdown", status: 201, response: action() },
      {
        method: "GET",
        path: "/v1/servers/12",
        response: { server: { ...baseVm, status: "running" } },
      },
      { method: "GET", path: "/v1/servers/12", response: { server: baseVm } },
      { method: "DELETE", path: "/v1/servers/12", response: action("running") },
      { method: "GET", path: "/v1/servers/actions/19", response: action() },
      {
        method: "GET",
        path: "/v1/servers/12",
        status: 404,
        response: { error: { message: token } },
      },
      {
        method: "DELETE",
        path: "/v1/servers/12",
        status: 404,
        response: { error: { message: token } },
      },
    ],
    async (origin) => {
      const api = hetzner(origin);
      await expect(api.create(createVm, signal)).resolves.toMatchObject({ id: 12, status: "off" });
      await api.powerOn(12, signal);
      await api.powerOff(12, signal);
      await api.delete(12, signal);
      await expect(api.describe(12, signal)).resolves.toBeUndefined();
      await api.delete(12, signal);
    },
  );
});

it("creates and repairs the shared firewall and restores a missing attachment", async () => {
  const firewall = {
    id: 31,
    name: "opensteer-cloud-computers",
    labels: { "opensteer.com/managed-by": "home-provisioner" },
    rules: [],
  };
  const rules = ["80", "443"].map((port) => ({
    direction: "in",
    protocol: "tcp",
    port,
    source_ips: ["0.0.0.0/0", "::/0"],
  }));
  await withServer(
    [
      {
        method: "GET",
        path: "/v1/firewalls",
        matches: (url) => {
          expect(url.searchParams.get("name")).toBe(firewall.name);
        },
        response: { firewalls: [], meta: meta() },
      },
      {
        method: "POST",
        path: "/v1/firewalls",
        status: 201,
        matches: (_url, body) =>
          expect(body).toEqual({ name: firewall.name, labels: firewall.labels, rules }),
        response: { firewall: { ...firewall, rules }, actions: [action("running").action] },
      },
      { method: "GET", path: "/v1/firewalls/actions/19", response: action() },
      { method: "GET", path: "/v1/firewalls", response: { firewalls: [firewall], meta: meta() } },
      {
        method: "POST",
        path: "/v1/firewalls/31/actions/set_rules",
        status: 201,
        matches: (_url, body) => expect(body).toEqual({ rules }),
        response: { actions: [action().action] },
      },
      {
        method: "POST",
        path: "/v1/firewalls/31/actions/apply_to_resources",
        status: 201,
        matches: (_url, body) =>
          expect(body).toEqual({ apply_to: [{ type: "server", server: { id: 12 } }] }),
        response: { actions: [action().action] },
      },
      { method: "GET", path: "/v1/servers/12", response: { server: baseVm } },
    ],
    async (origin) => {
      const api = hetzner(origin);
      await expect(api.ensureFirewall(signal)).resolves.toBe(31);
      await expect(api.ensureFirewall(signal)).resolves.toBe(31);
      await expect(
        api.ensureFirewallAttached(
          { id: 12, generation: 3, status: "off", ipv4: null, ipv6: null, firewalls: [] },
          31,
          signal,
        ),
      ).resolves.toBe(true);
    },
  );
});

const hostname = "computer.example.com";
const dnsPath = `/client/v4/zones/${zoneId}/dns_records`;
const v4Id = "1".repeat(32);
const v6Id = "2".repeat(32);
const dns4 = {
  id: v4Id,
  name: hostname,
  type: "A",
  content: "192.0.2.9",
  proxied: true,
  comment: "Opensteer Cloud Computer",
};
const v6 = "2001:db8::1";
const addresses = { ipv4: "192.0.2.1", ipv6: v6 };
const expectedRecord = { name: hostname, proxied: false, ttl: 1, comment: dns4.comment };
const dns6 = { ...expectedRecord, id: v6Id, type: "AAAA", content: v6 };
const fixed = { ...dns4, content: addresses.ipv4, proxied: false };
const success = (result: unknown) => ({ success: true, result });
function cloudflare(origin: URL) {
  return new CloudflareDns({
    token,
    zoneId,
    timeoutMs: 2000,
    baseUrl: new URL("/client/v4/", origin),
  });
}

it("paginates exact-name lookups, repairs an A record, creates AAAA, and deletes managed records", async () => {
  await withServer(
    [
      {
        method: "GET",
        path: dnsPath,
        matches: (url) => {
          expect(url.searchParams.get("name.exact")).toBe(hostname);
          expect(url.searchParams.get("page")).toBe("1");
        },
        response: { ...success([]), result_info: { total_pages: 2 } },
      },
      {
        method: "GET",
        path: dnsPath,
        matches: (url) => expect(url.searchParams.get("page")).toBe("2"),
        response: { ...success([dns4]), result_info: { total_pages: 2 } },
      },
      {
        method: "PATCH",
        path: `${dnsPath}/${v4Id}`,
        matches: (_url, body) =>
          expect(body).toEqual({ ...expectedRecord, content: addresses.ipv4, type: "A" }),
        response: success(fixed),
      },
      {
        method: "POST",
        path: dnsPath,
        matches: (_url, body) =>
          expect(body).toEqual({ ...expectedRecord, content: v6, type: "AAAA" }),
        response: success(dns6),
      },
      {
        method: "GET",
        path: dnsPath,
        response: success([fixed, { ...dns6, content: "2001:db8:0:0::1" }]),
      },
      { method: "GET", path: dnsPath, response: success([fixed, dns6]) },
      { method: "DELETE", path: `${dnsPath}/${v4Id}`, response: success({ id: v4Id }) },
      { method: "DELETE", path: `${dnsPath}/${v6Id}`, status: 404, response: { success: false } },
      { method: "GET", path: dnsPath, response: success([]) },
    ],
    async (origin) => {
      const api = cloudflare(origin);
      await api.ensureRecords(hostname, addresses, signal);
      await api.ensureRecords(hostname, addresses, signal);
      await api.removeRecords(hostname, signal);
      await api.removeRecords(hostname, signal);
    },
  );
});

it("leaves DNS records owned by someone else alone", async () => {
  const unmanaged = { ...dns4, comment: null };
  await withServer(
    [
      { method: "GET", path: dnsPath, response: success([unmanaged]) },
      { method: "GET", path: dnsPath, response: success([unmanaged]) },
    ],
    async (origin) => {
      const api = cloudflare(origin);
      await expect(api.ensureRecords(hostname, addresses, signal)).rejects.toThrow(
        "DNS name is already in use",
      );
      await api.removeRecords(hostname, signal);
    },
  );
});

it("keeps echoed tokens out of provider errors and logs", async () => {
  const stderr = vi.spyOn(console, "error");
  const stdout = vi.spyOn(console, "log");
  try {
    await withServer(
      [
        {
          method: "GET",
          path: "/v1/servers",
          status: 401,
          response: { error: { message: token } },
        },
        { method: "GET", path: "/v1/servers", response: { servers: token } },
        {
          method: "GET",
          path: dnsPath,
          status: 403,
          response: { success: false, errors: [{ message: token }] },
        },
        { method: "GET", path: dnsPath, response: { success: true, result: token } },
      ],
      async (origin) => {
        const h = hetzner(origin);
        const c = cloudflare(origin);
        for (const invoke of [
          () => h.find(id, signal),
          () => h.find(id, signal),
          () => c.ensureRecords(hostname, addresses, signal),
          () => c.removeRecords(hostname, signal),
        ]) {
          const error = await invoke().catch((error: unknown) => error);
          expect(error).toBeInstanceOf(Error);
          expect(String(error)).not.toContain(token);
          expect(JSON.stringify(error)).not.toContain(token);
        }
      },
    );
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
  }
});

it("recovers a labelled server by recorded ID or deterministic name when its labels drift", async () => {
  const drifted = {
    ...baseVm,
    labels: { "opensteer.com/cloud-computer": "changed" },
    status: "deleting",
  };
  await withServer(
    [
      { method: "GET", path: "/v1/servers", response: { servers: [], meta: meta() } },
      {
        method: "GET",
        path: "/v1/servers",
        matches: (url) => expect(url.searchParams.get("name")).toBe(name),
        response: { servers: [drifted], meta: meta() },
      },
      { method: "GET", path: "/v1/servers", response: { servers: [], meta: meta() } },
      {
        method: "GET",
        path: "/v1/servers",
        matches: (url) => expect(url.searchParams.get("name")).toBe(name),
        response: { servers: [drifted], meta: meta() },
      },
      {
        method: "GET",
        path: "/v1/servers",
        matches: (url) => expect(url.searchParams.has("label_selector")).toBe(false),
        response: { servers: [drifted], meta: meta() },
      },
    ],
    async (origin) => {
      const provider = hetzner(origin);
      const expected = [{ id: 12, generation: 3, status: "deleting" }];
      await expect(
        provider.find(id, signal, { generation: 3, providerServerId: 12 }),
      ).resolves.toMatchObject(expected);
      await expect(provider.find(id, signal, { generation: 3 })).resolves.toMatchObject(expected);
      await expect(provider.listManaged(signal)).resolves.toMatchObject([
        { id, server: expected[0] },
      ]);
    },
  );
});

it("uses forced power-off when graceful shutdown cannot turn the VM off", async () => {
  await withServer(
    [
      { method: "POST", path: "/v1/servers/12/actions/shutdown", response: action() },
      {
        method: "GET",
        path: "/v1/servers/12",
        response: { server: { ...baseVm, status: "running" } },
      },
      {
        method: "GET",
        path: "/v1/servers/12",
        response: { server: { ...baseVm, status: "running" } },
      },
      { method: "POST", path: "/v1/servers/12/actions/poweroff", response: action() },
    ],
    async (origin) => {
      const check = vi.fn(async () => {});
      const wait = vi.fn(async () => {
        throw new DOMException("Grace period elapsed", "TimeoutError");
      });
      await hetzner(origin, wait).powerOff(12, signal, check);
      expect(check).toHaveBeenCalledTimes(2);
    },
  );
});

it("reports separate Account denial, lease contention, and provider rate-limit events", () => {
  expect(provisionerFailure(new RemoteRequestError("Account", 403))).toMatchObject({
    event: "home-provisioner.account.refused",
    status: 403,
  });
  expect(provisionerFailure(new RemoteRequestError("Account", 409))).toMatchObject({
    event: "home-provisioner.lease.conflict",
    status: 409,
  });
  expect(provisionerFailure(new RemoteRequestError("Hetzner", 429, 4000))).toEqual({
    event: "home-provisioner.provider.rate-limited",
    service: "Hetzner",
    status: 429,
    retryAt: 4000,
  });
});
