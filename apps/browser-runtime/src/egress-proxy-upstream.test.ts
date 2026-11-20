import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { connect, createServer as createNetServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, createServer as createTlsServer, type TLSSocket } from "node:tls";
import { resolvePublicAddress } from "@opensteer/access";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readBrowserEgressUpstream } from "./egress-config.js";
import { PublicBrowserEgressProxy } from "./egress-proxy.js";

const credentials = {
  OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME: "proxy-user",
  OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD: "proxy:password",
};
const authorization = "Basic " + Buffer.from("proxy-user:proxy:password").toString("base64");
const host = "127.0.0.1";
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

  it("forwards an HTTP body and strips hop-by-hop headers while preserving Host", async () => {
    const received: unknown[] = [];
    const origin = await listen(
      createServer(async (request, response) => {
        received.push({
          host: request.headers.host,
          authorization: request.headers["proxy-authorization"],
          nominated: request.headers["x-hop"],
          body: await readBody(request),
          method: request.method,
          path: request.url,
        });
        response.end("response body");
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
        host: "original-host.test:80",
        authorization: undefined,
        nominated: undefined,
        body: "request body",
        method: "POST",
        path: "/page?x=1",
      },
    ]);
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

  it("fails closed when the upstream does not answer CONNECT before the deadline", async () => {
    const pending = Promise.withResolvers<void>();
    const isp = await fakeUpstream(() => pending.resolve());
    const origin = await listen(createNetServer());
    const port = await startProxy(isp.port);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const reply = proxyConnect(port, `origin.test:${origin.port}`);
      await pending.promise;
      await vi.advanceTimersByTimeAsync(60_000);
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
  ispPort: number,
  options: {
    trustCa?: boolean;
    destination?: Awaited<ReturnType<typeof resolvePublicAddress>>;
    upstreamHostname?: string;
  } = {},
) {
  const upstreamHostname = options.upstreamHostname ?? "isp.test";
  const upstream = await readBrowserEgressUpstream({
    ...credentials,
    OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL: `https://${upstreamHostname}:${ispPort}`,
    ...(options.trustCa === false ? {} : { OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE: caFile }),
  });
  if (!upstream) throw new Error("Missing test upstream configuration.");
  const proxy = new PublicBrowserEgressProxy({
    port: 0,
    upstream,
    resolveAddress: (hostname) => {
      if (hostname === upstreamHostname && hostname !== host)
        return Promise.resolve({ address: host, family: 4 });
      if (hostname === "origin.test")
        return Promise.resolve(options.destination ?? { address: host, family: 4 });
      return resolvePublicAddress(hostname);
    },
  });
  cleanups.push(() => proxy.close());
  return (await proxy.start()).port;
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
