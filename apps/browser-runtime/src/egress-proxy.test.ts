import {
  ignoreForeignTestRequest,
  observeTestConnection,
  probeTestServer,
  settleTestConnections,
  type TestConnectionObservation,
} from "@opensteer/shared/test-support/serverProbes";
import { createServer, globalAgent, request as httpRequest } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import {
  allClosed,
  connectionRefused,
  holdHttpConnections,
  holdRefusedConnection,
  observeClose,
  settleWithin,
  webSocketUpgradeRequest,
  writeTransportCloseReport,
} from "@opensteer/shared/test-support/httpServer";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PublicBrowserEgressProxy } from "./egress-proxy.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("PublicBrowserEgressProxy", () => {
  it.each([
    "http://host:4310/healthz",
    "http://127.0.0.1:4310/healthz",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fd00::1]/",
  ])("blocks private hosted-browser destination %s", async (target) => {
    const proxy = new PublicBrowserEgressProxy({ port: 0 });
    const address = await proxy.start();
    cleanups.push(() => proxy.close());
    await expect(proxyRequest(address.port, target)).resolves.toMatchObject({ status: 403 });
  });

  it("rechecks redirect targets and subresources as separate pinned requests", async () => {
    const seen: string[] = [];
    const origin = createServer((request, response) => {
      seen.push(request.url ?? "");
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "http://127.0.0.1:4310/private" }).end();
        return;
      }
      if (request.url === "/page") {
        response
          .writeHead(200, { "content-type": "text/html" })
          .end('<img src="http://public.test/asset">');
        return;
      }
      response.writeHead(200).end("asset");
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const originAddress = origin.address() as AddressInfo;
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          origin.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const proxy = new PublicBrowserEgressProxy({
      port: 0,
      resolveAddress: async (hostname) => {
        if (hostname === "public.test") return { address: "127.0.0.1", family: 4 };
        throw new Error("private address denied");
      },
    });
    const proxyAddress = await proxy.start();
    cleanups.push(() => proxy.close());
    const base = `http://public.test:${originAddress.port}`;

    await expect(proxyRequest(proxyAddress.port, `${base}/page`)).resolves.toMatchObject({
      status: 200,
    });
    await expect(proxyRequest(proxyAddress.port, `${base}/asset`)).resolves.toMatchObject({
      body: "asset",
      status: 200,
    });
    const redirected = await proxyRequest(proxyAddress.port, `${base}/redirect`);
    expect(redirected.status).toBe(302);
    await expect(proxyRequest(proxyAddress.port, redirected.location!)).resolves.toMatchObject({
      status: 403,
    });
    expect(seen).toEqual(["/page", "/asset", "/redirect"]);
  });

  it("denies private CONNECT tunnels", async () => {
    const proxy = new PublicBrowserEgressProxy({ port: 0 });
    const address = await proxy.start();
    cleanups.push(() => proxy.close());
    await expect(proxyConnect(address.port, "127.0.0.1:443")).resolves.toBe(403);
  });
});

/*
 * Ways a closing egress proxy can be held open, or keep reaching out:
 * - a CONNECT tunnel lives on for its whole ten-minute lifetime, and the
 *   listener's close waits for it;
 * - one side of a tunnel ends and the other is left open;
 * - a forwarded request the destination never answers keeps its upstream;
 * - a completed request's connection, pooled for reuse, outlives the proxy;
 * - a refused upgrade, request or tunnel is answered and left for its peer
 *   to end, and a peer that never does keeps the close waiting;
 * - an idle, half-sent or never-used connection keeps the close waiting;
 * - a tunnel or request whose name resolves after close began connects anyway;
 * - a close while the proxy is starting leaves it listening.
 */
describe("PublicBrowserEgressProxy shutdown", () => {
  const cases: Record<string, unknown>[] = [];

  afterAll(async () => {
    await writeTransportCloseReport("browser-egress-proxy", cases);
  });

  it("ends both sides of a live tunnel, an unanswered request and every held connection when it closes", async ({
    signal,
  }) => {
    const destination = await tcpDestination();
    const origin = await testOrigin();
    const proxy = new PublicBrowserEgressProxy({
      port: 0,
      resolveAddress: async () => ({ address: "127.0.0.1", family: 4 }),
    });
    const { port } = await proxy.start();
    cleanups.push(() => proxy.close());
    const tunnel = await rawClient(
      port,
      `CONNECT public.test:${destination.port} HTTP/1.1\r\nHost: public.test:${destination.port}\r\n\r\n`,
    );
    await tunnel.until("200 Connection Established");
    tunnel.socket.write("ping");
    await tunnel.until("ping");
    const forwarded = await rawClient(
      port,
      `GET http://public.test:${origin.port}/hang HTTP/1.1\r\nHost: public.test\r\n\r\n`,
    );
    await waitUntil(() => origin.requests.length === 1);
    // With the unanswered request holding one connection, this one takes
    // another, which stays open and idle for reuse once it is answered: in a
    // pool of the proxy's own, not the process-wide one.
    const completed = await proxyRequest(port, `http://public.test:${origin.port}/done`);
    const usedGlobalPool = Object.keys(globalAgent.freeSockets).some((name) =>
      name.includes(`:${origin.port}:`),
    );
    const held = await holdHttpConnections(port, "/health");

    const closed = await observeClose(proxy.close());
    const clientsClosed = await allClosed([tunnel, forwarded, ...held]);
    const destinationClosed = await allClosed(destination.sockets);
    // Shorter than the five seconds a pooled connection may sit idle, so only
    // the proxy's own close can have ended the completed request's connection.
    const originClosed = await allClosed(origin.connections, 2_000);
    const listenerRefused = await connectionRefused(port);
    await destination.classified(signal);
    cases.push({
      name: "close ends tunnels, forwarded requests and held connections",
      close: closed,
      tunnel: tunnel.report(),
      completed: { status: completed.status, body: completed.body, usedGlobalPool },
      forwarded: forwarded.report(),
      held: held.map((connection) => connection.report()),
      tunnelDestinationClosed: destinationClosed,
      originConnections: origin.connections.length,
      originConnectionsClosed: originClosed,
      listenerRefused,
    });

    expect(completed).toMatchObject({ body: "done", status: 200 });
    expect(usedGlobalPool).toBe(false);
    expect(closed.settled).toBe("closed");
    expect(clientsClosed).toBe(true);
    expect(destinationClosed).toBe(true);
    expect(origin.connections).toHaveLength(2);
    expect(originClosed).toBe(true);
    expect(listenerRefused).toBe(true);
  }, 30_000);

  it("connects nowhere for a tunnel or request whose name resolves after close began", async ({
    signal,
  }) => {
    const destination = await tcpDestination();
    const origin = await testOrigin();
    const lookups: Array<() => void> = [];
    const proxy = new PublicBrowserEgressProxy({
      port: 0,
      resolveAddress: () =>
        new Promise((resolve) => lookups.push(() => resolve({ address: "127.0.0.1", family: 4 }))),
    });
    const { port } = await proxy.start();
    cleanups.push(() => proxy.close());
    const tunnel = await rawClient(
      port,
      `CONNECT slow.test:${destination.port} HTTP/1.1\r\nHost: slow.test:${destination.port}\r\n\r\n`,
    );
    const forwarded = await rawClient(
      port,
      `GET http://slow.test:${origin.port}/page HTTP/1.1\r\nHost: slow.test\r\n\r\n`,
    );
    await waitUntil(() => lookups.length === 2);

    const closed = await observeClose(proxy.close());
    for (const resolveLookup of lookups) resolveLookup();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const clientsClosed = await allClosed([tunnel, forwarded]);
    await destination.classified(signal);
    cases.push({
      name: "names resolved after close began reach nothing",
      close: closed,
      tunnel: tunnel.report(),
      forwarded: forwarded.report(),
      destinationConnections: destination.sockets.length,
      originRequests: origin.requests.length,
    });

    expect(closed.settled).toBe("closed");
    expect(clientsClosed).toBe(true);
    expect(destination.sockets).toHaveLength(0);
    expect(origin.requests).toHaveLength(0);
  }, 30_000);

  it("refuses an upgrade, a malformed request or a private tunnel without waiting on the peer that sent it", async () => {
    const proxy = new PublicBrowserEgressProxy({ port: 0 });
    const { port } = await proxy.start();
    cleanups.push(() => proxy.close());
    const refused = [
      {
        name: "upgrade",
        ...(await holdRefusedConnection(port, webSocketUpgradeRequest(port, "/"))),
      },
      { name: "malformed request", ...(await holdRefusedConnection(port, "BOGUS\r\n\r\n")) },
      {
        name: "private tunnel",
        ...(await holdRefusedConnection(
          port,
          "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n",
        )),
      },
    ];
    try {
      const closed = await observeClose(proxy.close());
      const peersStillHolding = refused.every(({ connection }) => !connection.isClosed());
      cases.push({
        name: "refusals whose peers never end the connection",
        refusals: refused.map(({ connection, name, status }) => ({
          name,
          status,
          ...connection.report(),
        })),
        close: closed,
        peersStillHolding,
      });

      expect(refused.map(({ status }) => status)).toEqual([
        "HTTP/1.1 403 Forbidden",
        "HTTP/1.1 400 Bad Request",
        "HTTP/1.1 403 Forbidden",
      ]);
      expect(closed.settled).toBe("closed");
      expect(peersStillHolding).toBe(true);
    } finally {
      for (const { connection } of refused) connection.destroy();
    }
  }, 30_000);

  it("stops listening when it is closed while still starting", async () => {
    const proxy = new PublicBrowserEgressProxy({ port: 0 });
    cleanups.push(() => proxy.close());
    const starting = settleWithin(proxy.start());
    const closing = observeClose(proxy.close());
    const [started, observed] = await Promise.all([starting, closing]);
    const listenerRefused =
      started.settled !== "fulfilled" || (await connectionRefused(started.value.port));
    cases.push({ name: "close during startup", started, close: observed, listenerRefused });

    expect(started.settled).not.toBe("still waiting");
    expect(observed.settled).toBe("closed");
    expect(listenerRefused).toBe(true);
  }, 30_000);
});

interface ClosingSocket {
  readonly closed: Promise<void>;
}

/** A TCP destination that echoes what a tunnel carries, and records each connection. */
async function tcpDestination(): Promise<{
  readonly port: number;
  readonly sockets: ClosingSocket[];
  classified(signal: AbortSignal): Promise<void>;
}> {
  const sockets: (ClosingSocket & { observation: TestConnectionObservation })[] = [];
  const observations: TestConnectionObservation[] = [];
  const open = new Set<Socket>();
  const server = createNetServer((socket) => {
    const observation = observeTestConnection(socket);
    observations.push(observation);
    open.add(socket);
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => undefined);
    sockets.push({
      observation,
      closed: new Promise((resolve) =>
        socket.once("close", () => {
          open.delete(socket);
          resolve();
        }),
      ),
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await probeTestServer(server);
  return {
    port: (server.address() as AddressInfo).port,
    get sockets() {
      return sockets.filter((item) => !item.observation.foreignProbe);
    },
    classified: (signal) => settleTestConnections(observations, signal),
  };
}

/**
 * An origin that answers `/done` and keeps its connection open for reuse, and
 * takes every other request without answering it.
 */
async function testOrigin(): Promise<{
  readonly connections: ClosingSocket[];
  readonly port: number;
  readonly requests: ClosingSocket[];
}> {
  const connections: ClosingSocket[] = [];
  const requests: ClosingSocket[] = [];
  const recorded = new Set<Socket>();
  const server = createServer((request, response) => {
    if (
      ignoreForeignTestRequest(request, response, (path) =>
        ["/page", "/done", "/hang"].includes(path),
      )
    )
      return;
    if (!recorded.has(request.socket)) {
      recorded.add(request.socket);
      connections.push({
        closed: new Promise((resolve) => request.socket.once("close", () => resolve())),
      });
    }
    if (request.url === "/done") {
      response.end("done");
      return;
    }
    requests.push({
      closed: new Promise((resolve) => request.socket.once("close", () => resolve())),
    });
  });
  server.keepAliveTimeout = 60_000;
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await probeTestServer(server);
  return { connections, port: (server.address() as AddressInfo).port, requests };
}

/** A client that sends one request's bytes and reads whatever comes back. */
async function rawClient(port: number, request: string) {
  const started = performance.now();
  const events: { afterMs: number; event: string }[] = [];
  const note = (event: string) =>
    events.push({ afterMs: Math.round(performance.now() - started), event });
  const socket = connect({ host: "127.0.0.1", port });
  let received = "";
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("latin1");
    note(`received ${chunk.byteLength} bytes`);
  });
  socket.on("error", (error: NodeJS.ErrnoException) => note(`error ${error.code ?? ""}`));
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => {
      note("closed");
      resolve();
    }),
  );
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(request);
  note("sent request");
  return {
    closed,
    report: () => ({ events: [...events] }),
    socket,
    until: (text: string) => waitUntil(() => received.includes(text)),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for egress test state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function proxyRequest(
  proxyPort: number,
  target: string,
): Promise<{ body: string; location: string | undefined; status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", method: "GET", path: target, port: proxyPort },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            location: response.headers.location,
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function proxyConnect(proxyPort: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      method: "CONNECT",
      path: target,
      port: proxyPort,
    });
    request.once("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.once("response", (response) => resolve(response.statusCode ?? 0));
    request.once("error", reject);
    request.end();
  });
}
