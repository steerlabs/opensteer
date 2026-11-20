import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { connect, createServer as createNetServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, createServer as createTlsServer, type TLSSocket } from "node:tls";
import { resolvePublicAddress, type ResolvedPublicAddress } from "@opensteer/access";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readBrowserEgressUpstream } from "./egress-config.js";
import { PublicBrowserEgressProxy } from "./egress-proxy.js";

const credentials = {
  OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME: "proxy-user",
  OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD: "proxy:password",
};
const authorization = "Basic " + Buffer.from("proxy-user:proxy:password").toString("base64");
const host = "127.0.0.1";
const localAddress = { address: host, family: 4 } as const;
const cleanups: Array<() => Promise<void>> = [];
let directory: string;
let caFile: string;
let identity: { ca: Buffer; cert: Buffer; key: Buffer };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "opensteer-egress-tls-"));
  caFile = join(directory, "ca.pem");
  await writeFile(
    join(directory, "server.ext"),
    "subjectAltName=DNS:isp.test,DNS:origin.test\nextendedKeyUsage=serverAuth\n",
  );
  const openssl = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  openssl(
    "req",
    "-x509",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-subj",
    "/CN=Opensteer Egress Test CA",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
  );
  openssl(
    "req",
    "-new",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-subj",
    "/CN=isp.test",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
  );
  openssl(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-set_serial",
    "1",
    "-out",
    "server.pem",
    "-extfile",
    "server.ext",
    "-days",
    "1",
  );
  const [ca, cert, key] = await Promise.all(
    ["ca.pem", "server.pem", "server.key"].map((file) => readFile(join(directory, file))),
  );
  if (!ca || !cert || !key) throw new Error("TLS fixtures are missing.");
  identity = { ca, cert, key };
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("managed browser egress", () => {
  it("tunnels end-to-end TLS through a pinned IP with authentication on the upstream hop", async () => {
    const seen: { sni: string | false | null; authorization: string | undefined }[] = [];
    const origin = await listen(
      createHttpsServer(identity, (request, response) => {
        seen.push({
          sni: (request.socket as TLSSocket).servername,
          authorization: request.headers["proxy-authorization"],
        });
        response.end(`secure ${request.url}`);
      }),
    );
    const isp = await fakeUpstream(tunnelTo(origin.port));
    const port = await startProxy(isp.port);
    const tunnel = await proxyConnect(port, `origin.test:${origin.port}`);
    expect(tunnel.status).toBe(200);
    const reply = await new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: "origin.test",
          path: "/page",
          createConnection: () =>
            tlsConnect({
              socket: tunnel.socket,
              servername: "origin.test",
              ca: identity.ca,
            }),
        },
        (response) => void readReply(response).then(resolve, reject),
      );
      request.once("error", reject);
      request.end();
    });
    expect(reply).toEqual({ status: 200, body: "secure /page" });
    expect(isp.requests).toEqual([
      {
        authority: `${host}:${origin.port}`,
        authorization,
        sni: "isp.test",
      },
    ]);
    expect(seen).toEqual([{ sni: "origin.test", authorization: undefined }]);
  });

  it("forwards an HTTP body and derives Host from the validated authority", async () => {
    const received: unknown[] = [];
    const origin = await listen(
      createServer((request, response) => {
        void (async () => {
          received.push({
            host: request.headers.host,
            authorization: request.headers["proxy-authorization"],
            nominated: request.headers["x-hop"],
            body: await readBody(request),
            method: request.method,
            path: request.url,
          });
          response.end("response body");
        })().catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      }),
    );
    const isp = await fakeUpstream(tunnelTo(origin.port));
    const port = await startProxy(isp.port);
    await expect(
      proxyRequest(port, `http://origin.test:${origin.port}/page?x=1`, "request body"),
    ).resolves.toEqual({ status: 200, body: "response body" });
    expect(isp.requests).toEqual([
      {
        authority: `${host}:${origin.port}`,
        authorization,
        sni: "isp.test",
      },
    ]);
    expect(received).toEqual([
      {
        host: `origin.test:${origin.port}`,
        authorization: undefined,
        nominated: undefined,
        body: "request body",
        method: "POST",
        path: "/page?x=1",
      },
    ]);
  });

  it("preserves the explicit default HTTP port in a CONNECT authority", async () => {
    const isp = await fakeUpstream((socket) => socket.end("HTTP/1.1 200 Established\r\n\r\n"));
    const port = await startProxy(isp.port);
    expect((await proxyConnect(port, "origin.test:80")).status).toBe(200);
    expect(isp.requests).toEqual([{ authority: `${host}:80`, authorization, sni: "isp.test" }]);
  });

  it("brackets IPv6 literals and preserves tunnel bytes read with the CONNECT headers", async () => {
    const isp = await fakeUpstream((socket) => {
      socket.write("HTTP/1.1 200 Established\r\n");
      socket.end("X-Tunnel: ready\r\n\r\nfirst bytes");
    });
    const port = await startProxy(isp.port, {
      destination: { address: "2606:4700::1111", family: 6 },
    });
    const tunnel = await proxyConnect(port, "origin.test:443");
    expect(tunnel.status).toBe(200);
    expect(tunnel.head.toString() + (await readBody(tunnel.socket))).toBe("first bytes");
    expect(isp.requests).toEqual([
      {
        authority: "[2606:4700::1111]:443",
        authorization,
        sni: "isp.test",
      },
    ]);
  });

  it("rejects private destinations before connecting to the upstream", async () => {
    const isp = await fakeUpstream((socket) => socket.destroy());
    const port = await startProxy(isp.port);
    expect((await proxyRequest(port, "http://127.0.0.1:443/")).status).toBe(403);
    expect((await proxyConnect(port, "127.0.0.1:443")).status).toBe(403);
    expect(isp.connections).toHaveLength(0);
  });

  it("rejects a non-public upstream address before connecting", async () => {
    const isp = await fakeUpstream((socket) => socket.destroy());
    const origin = await listen(createNetServer());
    const port = await startProxy(isp.port, { upstreamHostname: host });
    await expectNoDirectEgress(port, origin);
    expect(isp.connections).toHaveLength(0);
  });

  it.each([407, 403, 502])("fails closed when the upstream returns %s", async (status) => {
    const isp = await fakeUpstream((socket) =>
      socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\n\r\n`),
    );
    const origin = await listen(createNetServer());
    await expectNoDirectEgress(await startProxy(isp.port), origin);
    expect(isp.requests).toHaveLength(2);
  });

  it("fails closed when the upstream refuses connections", async () => {
    const unavailable = await listen(createNetServer());
    await unavailable.close();
    const origin = await listen(createNetServer());
    await expectNoDirectEgress(await startProxy(unavailable.port), origin);
  });

  it("shares one deadline between destination DNS and upstream CONNECT", async () => {
    const lookupStarted = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<ResolvedPublicAddress>();
    const connectStarted = Promise.withResolvers<void>();
    const isp = await fakeUpstream(() => connectStarted.resolve());
    const origin = await listen(createNetServer());
    const port = await startProxy(isp.port, {
      resolveDestination: () => {
        lookupStarted.resolve();
        return lookup.promise;
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const reply = proxyConnect(port, `origin.test:${origin.port}`);
      await lookupStarted.promise;
      await vi.advanceTimersByTimeAsync(40_000);
      lookup.resolve(localAddress);
      await connectStarted.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(vi.getTimerCount()).toBe(0);
      expect((await reply).status).toBe(502);
      expect(origin.connections).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when upstream certificate trust is missing", async () => {
    const isp = await fakeUpstream((socket) => socket.destroy());
    const origin = await listen(createNetServer());
    await expectNoDirectEgress(await startProxy(isp.port, { trustCa: false }), origin);
    expect(isp.requests).toHaveLength(0);
  });

  it("fails closed when the upstream certificate belongs to a different hostname", async () => {
    const isp = await fakeUpstream((socket) => socket.destroy());
    const origin = await listen(createNetServer());
    const port = await startProxy(isp.port, { upstreamHostname: "wrong.test" });
    await expectNoDirectEgress(port, origin);
    expect(isp.requests).toHaveLength(0);
  });

  it.each([
    ["oversized", `HTTP/1.1 200 OK\r\nX-Fill: ${"x".repeat(17 * 1024)}\r\n\r\n`],
    ["malformed header", "HTTP/1.1 200 OK\r\nX-Field : value\r\n\r\n"],
    ["malformed status line", "HTTP/1.1 2000 OK\r\n\r\n"],
    ["obsolete line folding", "HTTP/1.1 200 OK\r\nX-Field: value\r\n continued\r\n\r\n"],
  ])("fails closed on an upstream response with %s", async (_label, reply) => {
    const isp = await fakeUpstream((socket) => socket.end(reply));
    const origin = await listen(createNetServer());
    await expectNoDirectEgress(await startProxy(isp.port), origin);
    expect(isp.requests).toHaveLength(2);
  });
});

describe.each(["direct", "managed"])("%s HTTP framing", (mode) => {
  it.each([
    {
      label: "connection-nominated Content-Length",
      inbound: "Connection: close, content-length\r\nContent-Length: 7",
      body: "payload",
      outbound: /^content-length: 7$/imu,
    },
    {
      label: "chunked transfer coding",
      inbound: "Connection: close\r\nTransfer-Encoding: chunked",
      body: "7\r\npayload\r\n0\r\n\r\n",
      outbound: /^transfer-encoding: chunked$/imu,
    },
  ])("writes exactly one framed request for $label", async ({ inbound, body, outbound }) => {
    const wire = Promise.withResolvers<string>();
    const origin = await listen(
      createNetServer((socket) => {
        let received = "";
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString("latin1");
          const headersEnd = received.indexOf("\r\n\r\n");
          if (headersEnd === -1) return;
          const chunked = /\r\ntransfer-encoding: chunked\r\n/iu.test(
            received.slice(0, headersEnd + 2),
          );
          if (!(chunked ? received.endsWith("\r\n0\r\n\r\n") : received.endsWith("payload")))
            return;
          wire.resolve(received);
          socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
      }),
    );
    const isp = mode === "managed" ? await fakeUpstream(tunnelTo(origin.port)) : undefined;
    const port = await startProxy(isp?.port);
    const client = rawRequest(
      port,
      `DELETE http://origin.test:${origin.port}/page HTTP/1.1\r\nHost: conflicting.test\r\n${inbound}\r\n\r\n${body}`,
    );
    expect(await readBody(client)).toMatch(/^HTTP\/1\.1 200 /u);
    const [headers, ...payload] = (await wire.promise).split("\r\n\r\n");
    expect(headers).toMatch(/^DELETE \/page HTTP\/1\.1\r\n/u);
    expect(headers).toMatch(`host: origin.test:${origin.port}`);
    expect(headers).toMatch(outbound);
    expect(payload.join("\r\n\r\n")).toBe(body);
    expect(origin.connections).toHaveLength(1);
  });

  it.each([
    ["GET", "Transfer-Encoding: chunked", "7\r\npayload\r\n0\r\n\r\n"],
    ["HEAD", "Content-Length: 7", "payload"],
    ["POST", "Transfer-Encoding: gzip, chunked", "7\r\npayload\r\n0\r\n\r\n"],
  ])("refuses %s with %s before opening a connection", async (method, framing, body) => {
    const origin = await listen(
      createNetServer((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")),
    );
    const isp = mode === "managed" ? await fakeUpstream(tunnelTo(origin.port)) : undefined;
    const port = await startProxy(isp?.port);
    const client = rawRequest(
      port,
      `${method} http://origin.test:${origin.port}/ HTTP/1.1\r\nHost: origin.test\r\nConnection: close\r\n${framing}\r\n\r\n${body}`,
    );
    expect(await readBody(client)).toMatch(/^HTTP\/1\.1 403 /u);
    expect(origin.connections).toHaveLength(0);
    if (isp) expect(isp.connections).toHaveLength(0);
  });
});

describe("browser egress setup limits", () => {
  it("times out a stalled destination lookup and disregards its late result", async () => {
    const started = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<ResolvedPublicAddress>();
    const origin = await listen(createNetServer());
    const port = await startProxy(undefined, {
      resolveDestination: () => {
        started.resolve();
        return lookup.promise;
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const reply = proxyRequest(port, `http://origin.test:${origin.port}/`);
      await started.promise;
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await reply).status).toBe(502);
      lookup.resolve(localAddress);
      expect((await proxyRequest(port, "/health")).status).toBe(200);
      expect(origin.connections).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits only one setup per pipelined client connection", async () => {
    const lookup = Promise.withResolvers<ResolvedPublicAddress>();
    const started = Promise.withResolvers<void>();
    const resolveDestination = vi.fn(() => {
      started.resolve();
      return lookup.promise;
    });
    const origin = await listen(createServer((_request, response) => response.end("one")));
    const port = await startProxy(undefined, { resolveDestination });
    const client = rawRequest(
      port,
      `GET http://origin.test:${origin.port}/one HTTP/1.1\r\nHost: origin.test\r\n\r\n` +
        `GET http://origin.test:${origin.port}/two HTTP/1.1\r\nHost: origin.test\r\nConnection: close\r\n\r\n`,
    );
    const reply = readBody(client);
    await started.promise;
    lookup.resolve(localAddress);
    expect((await reply).match(/HTTP\/1\.1 \d{3}/gu)).toEqual(["HTTP/1.1 200", "HTTP/1.1 502"]);
    expect(resolveDestination).toHaveBeenCalledTimes(1);
    expect(origin.connections).toHaveLength(1);
  });

  it("counts outstanding DNS after clients disconnect and discards their late results", async () => {
    const started = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<ResolvedPublicAddress>();
    const resolveDestination = vi.fn(() => {
      if (resolveDestination.mock.calls.length === 2) started.resolve();
      return lookup.promise;
    });
    const origin = await listen(createNetServer((socket) => socket.destroy()));
    const port = await startProxy(undefined, { resolveDestination, maxConnections: 2 });
    const request = `GET http://origin.test:${origin.port}/ HTTP/1.1\r\nHost: origin.test\r\n\r\n`;
    const tunnel = `CONNECT origin.test:${origin.port} HTTP/1.1\r\nHost: origin.test\r\n\r\n`;
    const clients = [rawRequest(port, request), rawRequest(port, tunnel)];
    await started.promise;
    await Promise.all(
      clients.map(async (client) => {
        const closed = once(client, "close");
        client.end();
        client.resume();
        await closed;
      }),
    );
    expect((await proxyRequest(port, `http://origin.test:${origin.port}/`)).status).toBe(502);
    expect(resolveDestination).toHaveBeenCalledTimes(2);
    lookup.resolve(localAddress);
    expect((await proxyRequest(port, "/health")).status).toBe(200);
    expect(origin.connections).toHaveLength(0);
  });
});

describe("browser egress upstream configuration", () => {
  const validUrl = "https://isp.test:443";

  it.each([
    "http://isp.test:443",
    "https://user:secret@isp.test:443",
    "https://isp.test:443/secret",
    "https://isp.test:443/",
    "https://isp.test:443?secret",
    "https://isp.test:443#secret",
    "https://isp.test",
    "",
  ])("rejects an invalid URL with a redacted error", async (url) => {
    await expect(
      readBrowserEgressUpstream({
        ...credentials,
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL: url,
      }),
    ).rejects.toThrow(
      /^OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL must be https:\/\/host:port without credentials or a path\.$/u,
    );
  });

  it.each([
    ["USERNAME", { OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD: "secret" }],
    ["PASSWORD", { OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME: "secret" }],
  ])("requires the %s credential", async (name, provided) => {
    await expect(
      readBrowserEgressUpstream({
        ...provided,
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL: validUrl,
      }),
    ).rejects.toThrow(
      `OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL requires OPENSTEER_BROWSER_EGRESS_UPSTREAM_${name} or OPENSTEER_BROWSER_EGRESS_UPSTREAM_${name}_FILE.`,
    );
  });

  it("rejects an unreadable credential file without returning its path or credential values", async () => {
    await expect(
      readBrowserEgressUpstream({
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL: validUrl,
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME: "secret-user",
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE: join(directory, "secret-path"),
      }),
    ).rejects.toThrow(
      /^Could not read the file configured by OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE\.$/u,
    );
  });

  it("loads credentials from files and preserves the explicit default port", async () => {
    const userPath = join(directory, "proxy-username");
    const passwordPath = join(directory, "proxy-password");
    await Promise.all([
      writeFile(userPath, "proxy-user\n", { mode: 0o600 }),
      writeFile(passwordPath, "proxy:password\r\n", { mode: 0o600 }),
    ]);
    await expect(
      readBrowserEgressUpstream({
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL: validUrl,
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME_FILE: userPath,
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE: passwordPath,
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE: caFile,
      }),
    ).resolves.toMatchObject({ hostname: "isp.test", port: 443, authorization });
  });

  it.each([
    "OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME",
    "OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME_FILE",
    "OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD",
    "OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE",
    "OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE",
  ])("requires the upstream URL when %s is set", async (name) => {
    await expect(readBrowserEgressUpstream({ [name]: "placeholder-secret" })).rejects.toThrow(
      `${name} requires OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL.`,
    );
  });

  it.each([
    ["non-PEM text", () => "placeholder-secret"],
    [
      "a bad certificate after a valid one",
      () =>
        `${identity.ca.toString()}\n-----BEGIN CERTIFICATE-----\nYmFk\n-----END CERTIFICATE-----\n`,
    ],
  ])("rejects an upstream CA bundle with %s at startup", async (_label, content) => {
    const path = join(directory, "invalid-upstream-ca");
    await writeFile(path, content());
    await expect(
      readBrowserEgressUpstream({
        ...credentials,
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL: validUrl,
        OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE: path,
      }),
    ).rejects.toThrow(
      /^OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE must contain PEM certificates\.$/u,
    );
  });
});

async function listen(server: Server) {
  const connections: Socket[] = [];
  const active = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.push(socket);
    active.add(socket);
    socket.once("close", () => active.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address.");
  const close = async () => {
    for (const socket of active) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(close);
  return { close, port: address.port, connections };
}

async function fakeUpstream(reply: (socket: Duplex, head: Buffer) => void) {
  const requests: {
    authority: string | undefined;
    authorization: string | undefined;
    sni: unknown;
  }[] = [];
  const parser = createServer();
  parser.on("connect", (request, socket, head) => {
    socket.on("error", () => undefined);
    requests.push({
      authority: request.url,
      authorization: request.headers["proxy-authorization"],
      sni: (socket as TLSSocket).servername,
    });
    reply(socket, head);
  });
  const server = await listen(
    createTlsServer(identity, (socket) => parser.emit("connection", socket)),
  );
  return { ...server, requests };
}

function tunnelTo(port: number) {
  return (socket: Duplex, head: Buffer) => {
    const target = connect({ host, port }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    socket.once("close", () => target.destroy());
    target.once("error", () => socket.destroy());
  };
}

async function startProxy(
  ispPort: number | undefined,
  options: {
    trustCa?: boolean;
    destination?: ResolvedPublicAddress;
    maxConnections?: number;
    resolveDestination?: () => Promise<ResolvedPublicAddress>;
    upstreamHostname?: string;
  } = {},
) {
  const upstreamHostname = options.upstreamHostname ?? "isp.test";
  const upstream =
    ispPort === undefined
      ? undefined
      : await readBrowserEgressUpstream({
          ...credentials,
          OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL: `https://${upstreamHostname}:${ispPort}`,
          ...(options.trustCa === false
            ? {}
            : { OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE: caFile }),
        });
  const proxy = new PublicBrowserEgressProxy({
    port: 0,
    ...(upstream ? { upstream } : {}),
    ...(options.maxConnections ? { maxConnections: options.maxConnections } : {}),
    resolveAddress: (hostname) => {
      if (hostname === upstreamHostname && hostname !== host)
        return Promise.resolve({ address: host, family: 4 });
      if (hostname === "origin.test")
        return (
          options.resolveDestination?.() ?? Promise.resolve(options.destination ?? localAddress)
        );
      return resolvePublicAddress(hostname);
    },
  });
  cleanups.push(() => proxy.close());
  return (await proxy.start()).port;
}

function rawRequest(port: number, request: string): Socket {
  const socket = connect({ host, port });
  socket.write(request);
  cleanups.push(async () => {
    socket.destroy();
  });
  return socket;
}

async function expectNoDirectEgress(port: number, origin: Awaited<ReturnType<typeof listen>>) {
  expect((await proxyRequest(port, `http://origin.test:${origin.port}/`)).status).toBe(502);
  expect((await proxyConnect(port, `origin.test:${origin.port}`)).status).toBe(502);
  expect(origin.connections).toHaveLength(0);
}

function proxyRequest(port: number, path: string, body?: string) {
  return new Promise<Awaited<ReturnType<typeof readReply>>>((resolve, reject) => {
    const request = httpRequest(
      {
        host,
        port,
        path,
        method: body ? "POST" : "GET",
        headers: {
          host: "original-host.test:80",
          "proxy-authorization": "Basic browser-credentials",
          connection: "close, x-hop",
          "x-hop": "strip",
        },
      },
      (response) => void readReply(response).then(resolve, reject),
    );
    request.once("error", reject);
    request.end(body);
  });
}

function proxyConnect(port: number, path: string) {
  return new Promise<{ status: number; socket: Duplex; head: Buffer }>((resolve, reject) => {
    const request = httpRequest({ host, port, path, method: "CONNECT" });
    request.once("connect", (response, socket, head) => {
      cleanups.push(async () => {
        socket.destroy();
      });
      const status = response.statusCode ?? 0;
      if (status !== 200) socket.destroy();
      resolve({ status, socket, head });
    });
    request.once("error", reject);
    request.end();
  });
}

async function readReply(response: IncomingMessage) {
  return { status: response.statusCode, body: await readBody(response) };
}

async function readBody(stream: Duplex | IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
