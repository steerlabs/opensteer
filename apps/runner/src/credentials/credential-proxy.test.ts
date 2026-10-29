import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import {
  allClosed,
  connectionRefused,
  holdHttpConnections,
  holdRefusedConnection,
  observeClose,
  settleWithin,
  writeTransportCloseReport,
} from "@opensteer/shared/test-support/httpServer";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CredentialProxy } from "./credential-proxy.js";

/*
 * Ways an engine-facing credential proxy can leak or overreach:
 * - the engine's local secret reaches the Host, or the Host token reaches the engine;
 * - a stream is buffered until it ends, so MCP's server-sent events stall;
 * - a missing or wrong secret, an unknown route, CONNECT, an absolute-form target
 *   or an unexpected method is forwarded anyway;
 * - an upstream redirect is followed, or its Location handed to the engine;
 * - an oversized body is forwarded;
 * - a refreshed Host token is ignored in favour of the one captured at start;
 * - revocation leaves new calls or an open stream working;
 * - a closed proxy still answers;
 * - cookies or hop-by-hop headers cross, while MCP session headers do not;
 * - unbounded concurrent calls;
 * - an upstream that fails partway through a body reads as a complete reply;
 * - a closed proxy keeps an idle, half-sent or never-used connection, or a
 *   call still waiting on the Host;
 * - a refused CONNECT is answered and left for its peer to end, and a peer
 *   that never does keeps the close waiting;
 * - a close while the proxy is starting leaves it listening.
 */
describe("credential proxy", () => {
  const servers: Server[] = [];
  const proxies: CredentialProxy[] = [];
  const closeCases: Record<string, unknown>[] = [];

  afterAll(async () => {
    await writeTransportCloseReport("credential-proxy", closeCases);
  });

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) await proxy.close();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  interface Seen {
    readonly method: string;
    readonly url: string;
    readonly headers: IncomingMessage["headers"];
    readonly body: string;
  }

  async function upstream(
    handler: (request: IncomingMessage, response: import("node:http").ServerResponse) => void,
  ) {
    const seen: Seen[] = [];
    const server = createServer((request, response) => {
      if (
        ignoreForeignTestRequest(
          request,
          response,
          (path) => path === "/internal/v1/mcp" || path === "/internal/v1/integration-mcp",
        )
      )
        return;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          body: Buffer.concat(chunks).toString("utf8"),
          headers: request.headers,
          method: request.method ?? "",
          url: request.url ?? "",
        });
        handler(request, response);
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await probeTestServer(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No upstream address");
    return { origin: `http://127.0.0.1:${address.port}`, seen };
  }

  async function proxyFor(origin: string, token: { current: string }, maxCalls?: number) {
    const proxy = new CredentialProxy({
      ...(maxCalls ? { maxCalls } : {}),
      maxBodyBytes: 1_024,
      routes: {
        "agent-tools": { token: () => token.current, upstream: `${origin}/internal/v1/mcp` },
        "integration-tools": {
          token: () => token.current,
          upstream: `${origin}/internal/v1/integration-mcp`,
        },
      },
      transport: { mode: "development" },
    });
    proxies.push(proxy);
    return { proxy, ...(await proxy.start()) };
  }

  it("forwards with the Host token and never passes the engine's secret on", async () => {
    const host = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    const { secret, urls } = await proxyFor(host.origin, { current: "host-token" });
    expect(urls["agent-tools"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
    expect(secret).not.toContain("host-token");

    const response = await fetch(urls["agent-tools"], {
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        cookie: "session=steal",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": "s-1",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("s-1");
    expect(await response.json()).toEqual({ id: 1, jsonrpc: "2.0", result: {} });
    expect(host.seen).toHaveLength(1);
    const [forwarded] = host.seen;
    expect(forwarded!.url).toBe("/internal/v1/mcp");
    expect(forwarded!.headers.authorization).toBe("Bearer host-token");
    expect(forwarded!.headers["mcp-session-id"]).toBe("s-1");
    expect(forwarded!.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(forwarded!.headers.cookie).toBeUndefined();
    expect(JSON.stringify(forwarded!.headers)).not.toContain(secret);
  });

  it("relays a server-sent event stream as it arrives", async () => {
    let finish!: () => void;
    const host = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      finish = () => response.end("data: last\n\n");
    });
    const { secret, urls } = await proxyFor(host.origin, { current: "host-token" });
    const response = await fetch(urls["agent-tools"], {
      headers: { accept: "text/event-stream", authorization: `Bearer ${secret}` },
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: first");
    finish();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toContain("data: last");
  });

  it("breaks the engine's connection when the Host fails partway through a body", async () => {
    const host = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"jsonrpc":"2.0","id":1,"result":{"partial":');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    const { secret, urls } = await proxyFor(host.origin, { current: "host-token" });
    const response = await fetch(urls["agent-tools"], {
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });

  it("refuses a missing or wrong secret without contacting the Host", async () => {
    const host = await upstream((_request, response) => response.end("{}"));
    const { secret, urls } = await proxyFor(host.origin, { current: "host-token" });
    const missing = await fetch(urls["agent-tools"], { body: "{}", method: "POST" });
    const wrong = await fetch(urls["agent-tools"], {
      body: "{}",
      headers: { authorization: `Bearer ${secret}x` },
      method: "POST",
    });
    expect([missing.status, wrong.status]).toEqual([401, 401]);
    expect(host.seen).toEqual([]);
  });

  it("refuses unknown routes, unexpected methods, CONNECT and absolute-form targets", async () => {
    const host = await upstream((_request, response) => response.end("{}"));
    const { secret, urls } = await proxyFor(host.origin, { current: "host-token" });
    const authorization = `Bearer ${secret}`;
    const base = new URL(urls["agent-tools"]);
    const unknown = await fetch(new URL("/elsewhere", base), {
      headers: { authorization },
    });
    const put = await fetch(urls["agent-tools"], {
      body: "{}",
      headers: { authorization },
      method: "PUT",
    });
    const raw = (line: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(Number(base.port), "127.0.0.1", () => {
          socket.write(`${line}\r\nHost: 127.0.0.1\r\nAuthorization: ${authorization}\r\n\r\n`);
        });
        let reply = "";
        socket.on("data", (chunk) => {
          reply += chunk.toString("utf8");
          socket.end();
        });
        socket.on("end", () => resolve(reply));
        socket.on("error", reject);
      });
    const tunnel = await raw(`CONNECT ${new URL(host.origin).host} HTTP/1.1`);
    const absolute = await raw(`GET ${host.origin}/internal/v1/mcp HTTP/1.1`);
    expect(unknown.status).toBe(404);
    expect(put.status).toBe(405);
    expect(tunnel).toMatch(/^HTTP\/1\.1 4\d\d/u);
    expect(absolute).toMatch(/^HTTP\/1\.1 4\d\d/u);
    expect(host.seen).toEqual([]);
  });

  it("does not follow an upstream redirect or reveal where it pointed", async () => {
    const host = await upstream((_request, response) => {
      response.writeHead(302, { location: "https://elsewhere.example/steal" });
      response.end();
    });
    const { secret, urls } = await proxyFor(host.origin, { current: "host-token" });
    const response = await fetch(urls["agent-tools"], {
      body: "{}",
      headers: { authorization: `Bearer ${secret}` },
      method: "POST",
      redirect: "manual",
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(host.seen).toHaveLength(1);
  });

  it("refuses a body over its limit without forwarding it", async () => {
    const host = await upstream((_request, response) => response.end("{}"));
    const { secret, urls } = await proxyFor(host.origin, { current: "host-token" });
    const response = await fetch(urls["agent-tools"], {
      body: "x".repeat(2_048),
      headers: { authorization: `Bearer ${secret}` },
      method: "POST",
    });
    expect(response.status).toBe(413);
    expect(host.seen).toEqual([]);
  });

  it("sends the Host token current at each call", async () => {
    const host = await upstream((_request, response) => response.end("{}"));
    const token = { current: "first" };
    const { secret, urls } = await proxyFor(host.origin, token);
    const call = () =>
      fetch(urls["integration-tools"], {
        body: "{}",
        headers: { authorization: `Bearer ${secret}` },
        method: "POST",
      }).then((response) => response.arrayBuffer());
    await call();
    token.current = "refreshed";
    await call();
    expect(host.seen.map(({ headers }) => headers.authorization)).toEqual([
      "Bearer first",
      "Bearer refreshed",
    ]);
    expect(host.seen.map(({ url }) => url)).toEqual([
      "/internal/v1/integration-mcp",
      "/internal/v1/integration-mcp",
    ]);
  });

  it("refuses new calls and cuts open streams once revoked", async () => {
    const host = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: open\n\n");
    });
    const { proxy, secret, urls } = await proxyFor(host.origin, { current: "host-token" });
    const stream = await fetch(urls["agent-tools"], {
      headers: { accept: "text/event-stream", authorization: `Bearer ${secret}` },
    });
    const reader = stream.body!.getReader();
    await reader.read();
    proxy.revoke();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return "ended";
      })(),
    ).resolves.toBe("ended");
    const after = await fetch(urls["agent-tools"], {
      body: "{}",
      headers: { authorization: `Bearer ${secret}` },
      method: "POST",
    });
    expect(after.status).toBe(403);
    expect(host.seen).toHaveLength(1);
  });

  it("stops answering once closed", async () => {
    const host = await upstream((_request, response) => response.end("{}"));
    const { proxy, secret, urls } = await proxyFor(host.origin, { current: "host-token" });
    await proxy.close();
    await expect(
      fetch(urls["agent-tools"], {
        body: "{}",
        headers: { authorization: `Bearer ${secret}` },
        method: "POST",
      }),
    ).rejects.toThrow();
  });

  it("ends a call still waiting on the Host and every held connection once closed", async () => {
    const host = await upstream(() => undefined);
    const { proxy, secret, urls } = await proxyFor(host.origin, { current: "host-token" });
    const port = Number(new URL(urls["agent-tools"]).port);
    const waiting = fetch(urls["agent-tools"], {
      body: "{}",
      headers: { authorization: `Bearer ${secret}` },
      method: "POST",
    }).then(
      (response) => response.status,
      () => "connection ended",
    );
    await expect.poll(() => host.seen.length).toBe(1);
    const held = await holdHttpConnections(port);

    const closed = await observeClose(proxy.close());
    const everyConnectionClosed = await allClosed(held);
    const waitingCall = await waiting;
    const listenerRefused = await connectionRefused(port);
    closeCases.push({
      name: "close ends a waiting call and held connections",
      close: closed,
      waitingCall,
      connections: held.map((connection) => connection.report()),
      listenerRefused,
    });

    expect(closed.settled).toBe("closed");
    expect(waitingCall).toBe(403);
    expect(everyConnectionClosed).toBe(true);
    expect(listenerRefused).toBe(true);
  }, 30_000);

  it("refuses a tunnel without waiting on the peer that asked for it", async () => {
    const host = await upstream((_request, response) => response.end("{}"));
    const { proxy, urls } = await proxyFor(host.origin, { current: "host-token" });
    const port = Number(new URL(urls["agent-tools"]).port);
    const refused = await holdRefusedConnection(
      port,
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
    );
    try {
      const closed = await observeClose(proxy.close());
      const peerStillHolding = !refused.connection.isClosed();
      closeCases.push({
        name: "refused tunnel whose peer never ends the connection",
        status: refused.status,
        peer: refused.connection.report(),
        close: closed,
        peerStillHolding,
      });

      expect(refused.status).toBe("HTTP/1.1 405 Method Not Allowed");
      expect(closed.settled).toBe("closed");
      expect(peerStillHolding).toBe(true);
    } finally {
      refused.connection.destroy();
    }
  }, 30_000);

  it("stops listening when it is closed while still starting", async () => {
    const proxy = new CredentialProxy({
      routes: {
        "agent-tools": { token: () => "host-token", upstream: "http://127.0.0.1:9/mcp" },
        "integration-tools": { token: () => "host-token", upstream: "http://127.0.0.1:9/mcp" },
      },
      transport: { mode: "development" },
    });
    proxies.push(proxy);
    const starting = settleWithin(proxy.start());
    const closing = observeClose(proxy.close());
    const [started, observed] = await Promise.all([starting, closing]);
    const listenerRefused =
      started.settled !== "fulfilled" ||
      (await connectionRefused(Number(new URL(started.value.urls["agent-tools"]).port)));
    closeCases.push({
      name: "close during startup",
      started: started.settled === "fulfilled" ? started.value.urls["agent-tools"] : started,
      close: observed,
      listenerRefused,
    });

    expect(started.settled).not.toBe("still waiting");
    expect(observed.settled).toBe("closed");
    expect(listenerRefused).toBe(true);
  }, 30_000);

  it("bounds concurrent calls", async () => {
    const held: (() => void)[] = [];
    const host = await upstream((_request, response) => {
      held.push(() => response.end("{}"));
    });
    const { secret, urls } = await proxyFor(host.origin, { current: "host-token" }, 2);
    const call = () =>
      new Promise<number>((resolve, reject) => {
        const target = new URL(urls["agent-tools"]);
        const outgoing = httpRequest(
          {
            agent: false,
            headers: { authorization: `Bearer ${secret}`, "content-length": 2 },
            host: "127.0.0.1",
            method: "POST",
            path: target.pathname,
            port: Number(target.port),
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        outgoing.on("error", reject);
        outgoing.end("{}");
      });
    const first = call();
    const second = call();
    await expect.poll(() => held.length).toBe(2);
    expect(await call()).toBe(503);
    for (const release of held) release();
    expect(await Promise.all([first, second])).toEqual([200, 200]);
  });
});
