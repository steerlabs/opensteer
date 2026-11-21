/**
 * Review G7 of the pool agent: a name with several public addresses (an IPv6 one first, on a
 * host that cannot reach IPv6) is reached through the first address that connects, in order.
 * When the first address connects, nothing changes: no other address is tried.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { PublicBrowserEgressProxy } from "./egress-proxy.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function serve(host: string, port = 0): Promise<{ port: number; connections: () => number }> {
  let count = 0;
  const server: Server = createServer((_request, response) => response.end("reached"));
  server.on("connection", () => (count += 1));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, connections: () => count };
}

async function proxyWith(addresses: { address: string; family: 4 | 6 }[]) {
  const proxy = new PublicBrowserEgressProxy({
    port: 0,
    resolveAddresses: async () => addresses,
  });
  const { port } = await proxy.start();
  cleanups.push(() => proxy.close());
  return port;
}

function tunnel(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    let head = "";
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.destroy();
      resolve(head.split("\r\n")[0]!);
    });
    socket.on("error", reject);
  });
}

function forward(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port: proxyPort, path: url, headers: { host: new URL(url).host } },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString()));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

it("tunnels through the next public address when the first does not connect", async () => {
  const site = await serve("127.0.0.1");
  // The IPv6 address comes first and does not connect (nothing listens there, or no IPv6
  // route at all, as in a pool slot): the IPv4 one is tried next.
  const port = await proxyWith([
    { address: "::1", family: 6 },
    { address: "127.0.0.1", family: 4 },
  ]);
  expect(await tunnel(port, `site.example:${site.port}`)).toMatch(/^HTTP\/1\.1 200/u);
  expect(site.connections()).toBe(1);
});

it("forwards a plain request through the next public address when the first does not connect", async () => {
  const site = await serve("127.0.0.1");
  const port = await proxyWith([
    { address: "::1", family: 6 },
    { address: "127.0.0.1", family: 4 },
  ]);
  expect(await forward(port, `http://site.example:${site.port}/`)).toEqual({
    status: 200,
    body: "reached",
  });
});

it("tries no other address when the first connects", async () => {
  const first = await serve("127.0.0.1");
  // The same port on the IPv6 loopback, where a host has one: it must never be reached.
  const second = await serve("::1", first.port).catch(() => ({ connections: () => 0 }));
  const port = await proxyWith([
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ]);
  expect(await tunnel(port, `site.example:${first.port}`)).toMatch(/^HTTP\/1\.1 200/u);
  expect(await forward(port, `http://site.example:${first.port}/`)).toMatchObject({ status: 200 });
  expect(first.connections()).toBe(2);
  expect(second.connections()).toBe(0);
});

it("tells a debug listener why a tunnel was refused, and nothing for one that opened", async () => {
  const site = await serve("127.0.0.1");
  const events: unknown[] = [];
  const proxy = new PublicBrowserEgressProxy({
    port: 0,
    // One address for every name; nothing listens on port 9 there.
    resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
    onRefusal: (event) => events.push(event),
  });
  const { port } = await proxy.start();
  cleanups.push(() => proxy.close());
  expect(await tunnel(port, `open.test:${site.port}`)).toContain("200");
  expect(events).toEqual([]);
  expect(await tunnel(port, "closed.test:9")).not.toContain("200");
  expect(events).toEqual([
    expect.objectContaining({ kind: "tunnel", host: "closed.test:9", error: expect.any(String) }),
  ]);
});
