import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { CloudflareDns } from "./cloudflare.js";
import { provisionerFailure, RemoteRequestError } from "./http.js";

const token = "provider_credential_must_never_escape";
const zoneId = "0".repeat(32);
const signal = new AbortController().signal;

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
  const server = createServer((req, res) => {
    void (async () => {
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
    })().catch((error: unknown) => {
      serverError = error;
      res.writeHead(500).end();
    });
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
    domain: "example.com",
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
          path: dnsPath,
          status: 403,
          response: { success: false, errors: [{ message: token }] },
        },
        { method: "GET", path: dnsPath, response: { success: true, result: token } },
      ],
      async (origin) => {
        const c = cloudflare(origin);
        for (const invoke of [
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

it("reports separate Account denial, lease contention, and provider rate-limit events", () => {
  expect(provisionerFailure(new RemoteRequestError("Account", 403))).toMatchObject({
    event: "home-provisioner.account.refused",
    status: 403,
  });
  expect(provisionerFailure(new RemoteRequestError("Account", 409))).toMatchObject({
    event: "home-provisioner.lease.conflict",
    status: 409,
  });
  expect(provisionerFailure(new RemoteRequestError("Google Compute Engine", 429, 4000))).toEqual({
    event: "home-provisioner.provider.rate-limited",
    service: "Google Compute Engine",
    status: 429,
    retryAt: 4000,
  });
});

it("refuses every read and write for a name outside its Cloud Computer domain", async () => {
  await withServer([], async (origin) => {
    const c = cloudflare(origin);
    for (const outside of ["computer.example.org", "example.com", "computer.notexample.com"]) {
      await expect(c.ensureRecords(outside, addresses, signal)).rejects.toThrow(
        "outside its domain",
      );
      await expect(c.removeRecords(outside, signal)).rejects.toThrow("outside its domain");
      await expect(c.observeWrites(outside, signal)).rejects.toThrow("outside its domain");
    }
  });
  expect(
    () => new CloudflareDns({ token, zoneId, domain: "not a domain", timeoutMs: 2000 }),
  ).toThrow("Invalid Cloud Computer DNS domain");
});
