import Fastify, { LogController } from "fastify";
import websocket from "@fastify/websocket";
import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { duplexPair } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { appOriginHeader, appOriginKey } from "@opensteer/shared/appFrame";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { AppGateway, hasAppAuthority } from "./app-gateway.js";
import {
  appGatewayCookieName,
  requestAppHttp,
  appRequestBodyMaxBytes,
  appOriginCookies,
  appOriginSetCookie,
} from "./app-proxy.js";
import { registerResponseCompression } from "../server/response-compression.js";
import { rejectDuplicateCredentialHeaders } from "../identity/request-credential-headers.js";
import { testHostApiContext } from "../server/test-host-api-context.js";

const appId = "app_11111111-1111-4111-8111-111111111111";
const otherApp = "app_22222222-2222-4222-8222-222222222222";
const key = appOriginKey(appId);
const authority = `${key}.localhost:1234`;
const origin = `http://${authority}`;
const signingKey = Buffer.alloc(32, 7);
const session = testHostApiContext(createId("user")).session!;
const secondSession = testHostApiContext(createId("user")).session!;
const deadline = <T>(promise: Promise<T>) =>
  withTimeout(promise, 3_000, { timeoutError: () => new Error("Gateway event did not arrive") });
afterEach(() => vi.useRealTimers());

async function fixture() {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url!, headers: req.headers });
    if (req.url === "/upgrade-refused") {
      res.writeHead(401, {
        "set-cookie": "login=expired; Path=/x",
        "content-type": "text/plain",
        "x-frame-options": "DENY",
      });
      res.end("App login required");
    } else if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: ready\n\n");
    } else if (req.url === "/upload") {
      let length = 0;
      req.on("data", (chunk: Buffer) => (length += chunk.length));
      req.once("end", () => res.end(String(length)));
    } else if (req.url === "/redirect" || req.url === "/redirect-relative-loopback") {
      res.writeHead(307, {
        location:
          req.url === "/redirect"
            ? "http://localhost:1/login?q=1#here"
            : "//[::1]:1/login?q=1#here",
        "cache-control": "public, max-age=20",
      });
      res.end();
    } else if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "public, max-age=900" });
      res.end("<h1>App</h1>");
    } else {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "public, max-age=20",
        "content-security-policy": "default-src 'none'",
        "clear-site-data": '"*"',
        "x-frame-options": "DENY",
        "set-cookie": [
          "login=yes; Domain=localhost; Path=/private; HttpOnly; Max-Age=30; SameSite=Strict",
          "opensteer-app=evil",
          `${appGatewayCookieName}=evil`,
        ],
      });
      res.end(JSON.stringify({ app: "a".repeat(4_000) }));
    }
  });
  const wsServer = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (req, socket, head) => {
    socket.on("error", () => undefined);
    if (req.url === "/upgrade-refused") {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nSet-Cookie: login=expired; Path=/x\r\nX-Frame-Options: DENY\r\nContent-Length: 18\r\n\r\nApp login required",
      );
    } else wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws, req));
  });
  wsServer.on("connection", (socket, req) => {
    seen.push({ path: req.url!, headers: req.headers });
    socket.send("server-head");
    socket.on("message", (data) => socket.send(data));
  });
  const up = once(upstream, "listening", { signal: AbortSignal.timeout(3_000) });
  upstream.listen(0, "127.0.0.1");
  await up;
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No app port");
  const streams = new Set<import("node:stream").Duplex>();
  const dial = async (signal: AbortSignal) => {
    const [host, runner] = duplexPair();
    const tcp = connect({ host: "127.0.0.1", port: address.port, signal });
    for (const stream of [host, runner, tcp]) {
      streams.add(stream);
      stream.on("error", () => undefined);
      stream.once("close", () => streams.delete(stream));
    }
    host.once("close", () => {
      runner.destroy();
      tcp.destroy();
    });
    tcp.once("close", () => {
      runner.destroy();
      host.destroy();
    });
    runner.pipe(tcp).pipe(runner);
    return { stream: host, port: address.port };
  };
  let member = true;
  const ended = new Set<string>();
  const get = vi.fn(async () => {
    if (!member) throw new Error("Membership ended");
    return {} as never;
  });
  const apps = {
    get,
    connect: async (_appId: string, _userId: string, signal: AbortSignal) => dial(signal),
    response: (input: Parameters<import("./app-service.js").AppService["response"]>[0]) =>
      requestAppHttp({ ...input, connect: dial }),
  };
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      level: "info",
      stream: new (await import("node:stream")).Writable({
        write(chunk, _encoding, done) {
          logs.push(String(chunk));
          done();
        },
      }),
    },
    logController: new LogController({
      disableRequestLogging: (req) => hasAppAuthority(req.headers),
    }),
  });
  const makeGateway = () =>
    new AppGateway({
      apps,
      identity: { isSessionCurrent: async (sessionId) => !ended.has(sessionId) },
      signingKey,
      canonicalOrigin: "http://127.0.0.1:1234",
    });
  const gateway = makeGateway();
  gateway.installHttp(app);
  app.addHook("onRequest", rejectDuplicateCredentialHeaders);
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("x-host-only", "yes");
  });
  await registerResponseCompression(app);
  await app.register(websocket);
  const hostRoute = vi.fn(async () => ({ host: true }));
  const completed = vi.fn();
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-host-send", "yes");
    return payload;
  });
  app.get(
    "/v1/rpc/bootstrap.get",
    {
      onResponse: async () => {
        completed();
      },
      preValidation: () => {
        throw new Error("Host validation reached");
      },
    },
    hostRoute,
  );
  app.post("/v1/rpc/bootstrap.get", hostRoute);
  let inheritedUpgrades = 0;
  const inherited = app.server.listeners("upgrade");
  app.server.removeAllListeners("upgrade");
  app.server.on("upgrade", (req, socket, head) => {
    inheritedUpgrades++;
    for (const listener of inherited) listener.call(app.server, req, socket, head);
  });
  gateway.installUpgrades(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const hostAddress = app.server.address();
  if (!hostAddress || typeof hostAddress === "string") throw new Error("No Host port");
  const entry = (value = session, id = appId) =>
    gateway.entryUrl(id, value, "dark", { host: "127.0.0.1:1234" })!;
  const inject = (path: string, cookie?: string, extra: IncomingHttpHeaders = {}) =>
    app.inject({
      url: path,
      headers: { host: authority, ...(cookie ? { cookie } : {}), ...extra },
    });
  return {
    app,
    gateway,
    entry,
    inject,
    seen,
    get,
    logs,
    ended,
    hostRoute,
    completed,
    hostPort: hostAddress.port,
    makeGateway,
    removeMember: () => {
      member = false;
    },
    inheritedUpgrades: () => inheritedUpgrades,
    close: async () => {
      await app.close();
      for (const client of wsServer.clients) client.terminate();
      for (const stream of streams) stream.destroy();
      await closeHttpServerNow(upstream);
    },
  };
}
function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw]).find(
    (value) => typeof value === "string" && value.startsWith(`${appGatewayCookieName}=`),
  );
  if (typeof cookie !== "string") throw new Error("Missing gateway cookie");
  return cookie.split(";")[0]!;
}

it("hijacks app authorities before Host hooks, matched routes, parsing and compression, including refusals", async () => {
  const f = await fixture();
  try {
    const url = new URL(f.entry());
    const first = await f.inject(url.pathname + url.search);
    const cookie = cookieOf(first);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    for (const path of [
      "/v1/rpc/bootstrap.get",
      "/missing",
      "/v1/shell/connect",
      "/v1/computer-use/display",
    ]) {
      const result = await f.inject(path, cookie, { "accept-encoding": "gzip" });
      expect(result.statusCode).toBe(200);
      expect(result.headers["content-encoding"]).toBeUndefined();
      expect(result.headers.vary).toBeUndefined();
      expect(result.headers["x-host-only"]).toBeUndefined();
      expect(result.headers["x-host-send"]).toBeUndefined();
      expect(result.headers["clear-site-data"]).toBeUndefined();
      expect(result.headers["x-frame-options"]).toBeUndefined();
      expect(result.headers["content-security-policy"]).toBe(
        "frame-ancestors app://opensteer http://localhost:1234 http://127.0.0.1:1234 http://[::1]:1234",
      );
      expect(result.headers["cache-control"]).toBe("private, max-age=20");
      expect(result.headers["referrer-policy"]).toBe("same-origin");
    }
    const body = "not json";
    const post = await f.app.inject({
      method: "POST",
      url: "/v1/rpc/bootstrap.get",
      headers: {
        host: authority,
        cookie,
        "content-type": "application/json",
        authorization: "Basic app-login",
      },
      payload: body,
    });
    expect(post.statusCode).toBe(200);
    for (const path of ["/v1/rpc/bootstrap.get", "/missing"]) {
      const refusal = await f.inject(path);
      expect(refusal.statusCode).toBe(403);
      expect(refusal.body).toContain("opensteer-app:ready");
      expect(refusal.headers["x-host-only"]).toBeUndefined();
      expect(refusal.headers["cache-control"]).toBe("private, no-store");
    }
    const upperHost = await f.inject("/v1/rpc/bootstrap.get", cookie, {
      host: authority.toUpperCase(),
    });
    expect(upperHost.statusCode).toBe(200);
    expect(upperHost.headers["x-host-only"]).toBeUndefined();
    const invalid = await f.inject("/v1/rpc/bootstrap.get", cookie, {
      [appOriginHeader]: "invalid",
    });
    expect(invalid.statusCode).toBe(403);
    expect(f.hostRoute).not.toHaveBeenCalled();
    expect(f.completed).toHaveBeenCalled();
    expect(f.logs.join("")).not.toContain(url.searchParams.get("opensteer-ticket"));
    const ordinary = await f.app.inject({ url: "/missing" });
    expect(ordinary.headers["x-host-only"]).toBe("yes");
  } finally {
    await f.close();
  }
});

it("uses one-use, expiring, bounded tickets ahead of cookies and binds restart-safe signatures to app and exact origin", async () => {
  const f = await fixture();
  try {
    const ticket = new URL(f.entry());
    const entryPath = ticket.pathname + ticket.search;
    const first = await f.inject(entryPath);
    const cookie = cookieOf(first);
    expect(first.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/HttpOnly; Secure; SameSite=None; Partitioned; Path=\//u),
      ]),
    );
    expect(f.seen.at(-1)?.path).toBe("/");
    expect((await f.inject(entryPath)).statusCode).toBe(403);
    expect((await f.inject(entryPath, cookie)).statusCode).toBe(200);
    expect((await f.inject(`/cookies${ticket.search}`, cookie)).headers["cache-control"]).toBe(
      "private, no-store",
    );
    const replacement = new URL(f.entry(secondSession));
    const replaced = await f.inject(replacement.pathname + replacement.search, cookie);
    const nextCookie = cookieOf(replaced);
    expect(nextCookie).not.toBe(cookie);
    f.ended.add(session.id);
    expect((await f.inject("/", cookie)).statusCode).toBe(403);
    expect((await f.inject("/", nextCookie)).statusCode).toBe(200);
    expect((await f.inject("/", nextCookie + "x")).statusCode).toBe(403);
    expect(
      (await f.inject("/", nextCookie, { host: `${appOriginKey(otherApp)}.localhost:1234` }))
        .statusCode,
    ).toBe(403);
    expect((await f.inject("/", nextCookie, { host: `${key}.localhost:9999` })).statusCode).toBe(
      403,
    );
    const restarted = Fastify();
    f.makeGateway().installHttp(restarted);
    try {
      expect(
        (await restarted.inject({ url: "/", headers: { host: authority, cookie: nextCookie } }))
          .statusCode,
      ).toBe(200);
    } finally {
      await restarted.close();
    }
    const expiredTicket = new URL(f.entry(secondSession));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_001);
    expect((await f.inject(expiredTicket.pathname + expiredTicket.search)).statusCode).toBe(403);
    expect(
      (await f.inject(expiredTicket.pathname + expiredTicket.search, nextCookie)).statusCode,
    ).toBe(200);
    const oldest = new URL(f.entry(secondSession));
    for (let n = 0; n < 4_096; n++) f.entry(secondSession);
    expect((await f.inject(oldest.pathname + oldest.search)).statusCode).toBe(403);
    vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    expect((await f.inject("/", nextCookie)).statusCode).toBe(403);
  } finally {
    await f.close();
  }
});

it("rewrites only exact cookie prefixes, strips planted and gateway cookies, reserves its cookie and forwards app authorization", async () => {
  expect(
    appOriginCookies(
      "planted=x; __host-a=b; %5f%5fHost-a=b;  __Host-spaced=x; __Host-good=raw%3D; __Host-opensteer-app=secret",
    ),
  ).toBe("good=raw%3D");
  expect(
    appOriginSetCookie(
      "a=b; Path=/x; Domain=other; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Max-Age=3; SameSite=Strict",
    ),
  ).toBe(
    "__Host-a=b; Path=/; Secure; SameSite=None; Partitioned; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Max-Age=3",
  );
  for (const value of [
    "opensteer-app=x",
    "__Host-opensteer-app=x",
    " opensteer-app=x",
    "a b=x",
    "noequals",
  ])
    expect(appOriginSetCookie(value)).toBeUndefined();
  const f = await fixture();
  try {
    const url = new URL(f.entry());
    const cookie = cookieOf(await f.inject(url.pathname + url.search));
    const result = await f.inject(
      "/cookies",
      `${cookie}; planted=x; __Host-login=yes; __host-fake=x`,
      { authorization: "Basic app-login" },
    );
    expect(f.seen.at(-1)?.headers.cookie).toBe("login=yes");
    expect(f.seen.at(-1)?.headers.authorization).toBe("Basic app-login");
    expect(result.headers["set-cookie"]).toEqual([
      "__Host-login=yes; Path=/; Secure; SameSite=None; Partitioned; HttpOnly; Max-Age=30",
    ]);
  } finally {
    await f.close();
  }
});

it("enforces Fetch Metadata and Origin isolation and emits Connect and Safari-aware entry URLs", async () => {
  const f = await fixture();
  try {
    const url = new URL(f.entry());
    const cookie = cookieOf(await f.inject(url.pathname + url.search));
    const cases = [
      ["GET", { "sec-fetch-site": "same-origin" }, 200],
      ["POST", { "sec-fetch-site": "none" }, 200],
      ["GET", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }, 200],
      ["HEAD", { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" }, 200],
      ["GET", { "sec-fetch-site": "same-site" }, 403],
      ["POST", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }, 403],
      ["GET", { origin: "null" }, 403],
      ["POST", { origin: "https://other.test" }, 403],
      ["POST", { origin }, 200],
    ] as const;
    for (const [method, headers, status] of cases)
      expect(
        (
          await f.app.inject({
            method,
            url: "/api",
            headers: { host: authority, cookie, ...headers },
          })
        ).statusCode,
      ).toBe(status);
    const entry = (host: string, agent = "") =>
      f.gateway.entryUrl(appId, session, "light", { host, "user-agent": agent });
    expect(entry("127.0.0.1:1234", "Version/18 Safari/605")).toBeUndefined();
    expect(entry("127.0.0.1:1234", "Chrome/130 Safari/605")).toContain(origin);
    expect(entry("localhost:1234")).toContain(".localhost:1234/?");
    expect(entry("localhost:9999")).toBeUndefined();
    expect(entry("192.168.1.2:1234")).toBeUndefined();
    expect(entry("server.example.test")).toBeUndefined();
    const connectEntry = entry(
      "connect-11111111-2222-4333-8444-555555555555.example.test",
      "Safari/605",
    )!;
    const connected = new URL(connectEntry);
    expect(connected.origin).toBe(`https://${key}-11111111222243338444555555555555.example.test`);
    const response = await f.inject(connected.pathname + connected.search, undefined, {
      [appOriginHeader]: connected.origin,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toBe(
      "frame-ancestors app://opensteer https://connect-11111111-2222-4333-8444-555555555555.example.test",
    );
  } finally {
    await f.close();
  }
});

it("streams at the upload cap and preserves loopback redirects", async () => {
  const f = await fixture();
  try {
    const url = new URL(f.entry());
    const cookie = cookieOf(await f.inject(url.pathname + url.search));
    const upload = await f.app.inject({
      method: "POST",
      url: "/upload",
      headers: { host: authority, cookie, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(appRequestBodyMaxBytes),
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.body).toBe(String(appRequestBodyMaxBytes));
    for (const path of ["/redirect", "/redirect-relative-loopback"])
      expect((await f.inject(path, cookie)).headers.location).toBe("/login?q=1#here");
  } finally {
    await f.close();
  }
});

it.each(["membership", "session", "shutdown"] as const)(
  "ends live SSE and real WebSockets over a fake runner stream on %s",
  async (reason) => {
    const f = await fixture();
    try {
      const url = new URL(f.entry());
      const cookie = cookieOf(await f.inject(url.pathname + url.search));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const openStream = async () => {
        const req = request({
          host: "127.0.0.1",
          port: f.hostPort,
          path: "/events",
          headers: { host: authority, cookie },
          signal: AbortSignal.timeout(5_000),
        });
        req.on("error", () => undefined);
        const response = once(req, "response", { signal: AbortSignal.timeout(3_000) });
        req.end();
        const [res] = await response;
        const data = await once(res, "data", { signal: AbortSignal.timeout(3_000) });
        expect(String(data[0])).toContain("data: ready");
        return res as IncomingMessage;
      };
      const stream = await openStream();
      const ws = new WebSocket(`ws://127.0.0.1:${f.hostPort}/v1/shell/connect`, {
        headers: { host: authority, cookie, origin },
        handshakeTimeout: 3_000,
      });
      const initial = once(ws, "message", { signal: AbortSignal.timeout(3_000) });
      await once(ws, "open", { signal: AbortSignal.timeout(3_000) });
      expect(String((await initial)[0])).toBe("server-head");
      const echo = once(ws, "message", { signal: AbortSignal.timeout(3_000) });
      ws.send("browser-data");
      expect(String((await echo)[0])).toBe("browser-data");
      expect(f.inheritedUpgrades()).toBe(0);
      const badWs = new WebSocket(`ws://127.0.0.1:${f.hostPort}/v1/shell/connect`, {
        headers: { host: authority, cookie, origin: "https://sibling.test" },
        handshakeTimeout: 3_000,
      });
      badWs.on("error", () => undefined);
      const rejected = once(badWs, "unexpected-response", { signal: AbortSignal.timeout(3_000) });
      expect((await rejected)[1].statusCode).toBe(403);
      badWs.terminate();
      const streamClosed = new Promise<void>((resolve) => stream.once("close", resolve));
      const wsClosed = once(ws, "close");
      stream.on("error", () => undefined);
      if (reason === "shutdown") {
        vi.useRealTimers();
        await deadline(f.app.close());
      } else {
        if (reason === "session") f.ended.add(session.id);
        else f.removeMember();
        await vi.advanceTimersByTimeAsync(30_000);
        vi.useRealTimers();
        expect((await f.inject("/api", cookie)).statusCode).toBe(403);
      }
      await deadline(Promise.all([streamClosed, wsClosed]));
    } finally {
      await f.close();
    }
  },
);

it("forwards upgrade head bytes and rewritten cookies before inheriting any Host listener", async () => {
  const f = await fixture();
  let tcp: ReturnType<typeof connect> | undefined;
  try {
    const url = new URL(f.entry());
    const cookie = cookieOf(await f.inject(url.pathname + url.search));
    tcp = connect({ host: "127.0.0.1", port: f.hostPort });
    tcp.on("error", () => undefined);
    const received = deadline(
      new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        tcp!.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          const bytes = Buffer.concat(chunks);
          if (bytes.includes(Buffer.from([0x82, 4, ...Buffer.from("head")]))) resolve(bytes);
        });
      }),
    );
    const frame = Buffer.from([
      0x81,
      0x84,
      1,
      2,
      3,
      4,
      ...[...Buffer.from("head")].map((byte, n) => byte ^ (n + 1)),
    ]);
    tcp.write(
      Buffer.concat([
        Buffer.from(
          `GET /v1/shell/connect HTTP/1.1\r\nHost: ${authority}\r\nOrigin: ${origin}\r\nCookie: ${cookie}; __Host-login=app; planted=evil\r\nAuthorization: Basic app-login\r\nAuthorization: Basic second\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: YWJjZGVmZ2hpamtsbW5vcA==\r\n\r\n`,
        ),
        frame,
      ]),
    );
    const bytes = await received;
    expect(bytes.toString()).toContain("101 Switching Protocols");
    expect(bytes.toString()).toContain("server-head");
    expect(f.seen.at(-1)?.headers.cookie).toBe("login=app");
    expect(f.seen.at(-1)?.headers.authorization).toBe("Basic app-login");
    expect(f.inheritedUpgrades()).toBe(0);
  } finally {
    tcp?.destroy();
    await f.close();
  }
});

it("tracks every active response when requests share a pipelined socket", async () => {
  const f = await fixture();
  let tcp: ReturnType<typeof connect> | undefined;
  try {
    const url = new URL(f.entry());
    const cookie = cookieOf(await f.inject(url.pathname + url.search));
    tcp = connect({ host: "127.0.0.1", port: f.hostPort });
    tcp.on("error", () => undefined);
    const streaming = deadline(
      new Promise<void>((resolve) => {
        tcp!.on("data", (chunk: Buffer) => {
          if (chunk.includes("data: ready")) resolve();
        });
      }),
    );
    tcp.write(
      ["/api", "/events"]
        .map((path) => `GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nCookie: ${cookie}\r\n\r\n`)
        .join(""),
    );
    await streaming;
    await deadline(f.app.close());
  } finally {
    tcp?.destroy();
    await f.close();
  }
});

it.each([undefined, "null", "https://sibling.test", origin])(
  "requires an exact WebSocket Origin and preserves an app's upgrade refusal for %s",
  async (from) => {
    const f = await fixture();
    let socket: WebSocket | undefined;
    try {
      const url = new URL(f.entry());
      const cookie = cookieOf(await f.inject(url.pathname + url.search));
      socket = new WebSocket(`ws://127.0.0.1:${f.hostPort}/upgrade-refused`, {
        headers: { host: authority, cookie, ...(from ? { origin: from } : {}) },
        handshakeTimeout: 3_000,
      });
      socket.on("error", () => undefined);
      const [, response] = await once(socket, "unexpected-response", {
        signal: AbortSignal.timeout(3_000),
      });
      expect(response.statusCode).toBe(from === origin ? 401 : 403);
      if (from === origin) {
        expect(response.headers["set-cookie"]).toEqual([
          "__Host-login=expired; Path=/; Secure; SameSite=None; Partitioned",
        ]);
        expect(response.headers["x-frame-options"]).toBeUndefined();
      }
      response.resume();
    } finally {
      socket?.terminate();
      await f.close();
    }
  },
);
