import websocket from "@fastify/websocket";
import { withTimeout } from "@opensteer/shared/withTimeout";
import Fastify, { type FastifyInstance } from "fastify";
import { once } from "node:events";
import { createServer, request, Agent, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeWebSocketsWithin, drainConnectionsWithin } from "./connection-drain.js";

/*
 * Ways a closing server can hold its process open:
 * - a connection serving a request when closing begins is not idle then, so it
 *   is not closed; once it answers it sits in keep-alive for the whole
 *   keep-alive timeout (72 s by Fastify's default) and the server waits;
 * - a request that never answers holds the server forever.
 */
describe("closing a server with connections in use", () => {
  const servers: Server[] = [];
  const agents: Agent[] = [];

  afterEach(() => {
    for (const agent of agents.splice(0)) agent.destroy();
    for (const server of servers.splice(0)) server.closeAllConnections();
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const server = createServer(handler);
    server.keepAliveTimeout = 72_000;
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The server did not bind");
    return address.port;
  }

  function get(port: number, agent: Agent): Promise<number> {
    return new Promise((resolve, reject) => {
      const outgoing = request({ agent, host: "127.0.0.1", path: "/", port }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  function closed(server: Server): Promise<number> {
    const started = Date.now();
    return new Promise((resolve) => server.close(() => resolve(Date.now() - started)));
  }

  it("closes a connection that answers after closing began instead of keeping it alive", async () => {
    const port = await listen((_request, response) => {
      setTimeout(() => response.end("done"), 200);
    });
    const server = servers[0]!;
    const agent = new Agent({ keepAlive: true });
    agents.push(agent);
    const answered = get(port, agent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    drainConnectionsWithin(server, 5_000);
    const closing = closed(server);
    server.closeIdleConnections();

    await expect(answered).resolves.toBe(200);
    expect(await closing).toBeLessThan(2_000);
  });

  it("cuts off a request still unanswered once the grace has passed", async () => {
    const port = await listen(() => undefined);
    const server = servers[0]!;
    const agent = new Agent({ keepAlive: true });
    agents.push(agent);
    const unanswered = get(port, agent).catch(() => "cut off");
    await new Promise((resolve) => setTimeout(resolve, 50));

    drainConnectionsWithin(server, 300);
    const elapsed = await closed(server);

    expect(elapsed).toBeLessThan(2_000);
    await expect(unanswered).resolves.toBe("cut off");
  });
});

describe("closing the Host's WebSockets", () => {
  const sockets: Socket[] = [];
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    // A reset, as a plain end would leave a socket the Host failed to end half open.
    for (const socket of sockets.splice(0)) socket.resetAndDestroy();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  /** Opens a raw connection, asks to upgrade, and resolves with the start of the answer. */
  async function upgrade(port: number): Promise<{ answer: string; socket: Socket }> {
    const socket = connect(port, "127.0.0.1");
    sockets.push(socket);
    socket.write(
      "GET /socket HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    const [chunk] = (await withTimeout(once(socket, "data"), 2_000, {
      timeoutError: () => new Error("The upgrade was never answered"),
    })) as [Buffer];
    return { answer: chunk.toString("latin1"), socket };
  }

  it("refuses and ends an upgrade that arrives while the Host is closing", async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(websocket, { preClose: closeWebSocketsWithin(300, 5_000) });
    app.get("/socket", { websocket: true }, () => undefined);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("The Host did not bind");
    // A peer that never answers the close frame keeps the Host closing for the whole grace.
    const silent = await upgrade(address.port);
    expect(silent.answer).toMatch(/^HTTP\/1\.1 101 /);
    const told = once(silent.socket, "data");
    const closing = app.close();
    await withTimeout(told, 2_000, {
      timeoutError: () => new Error("The open WebSocket was never told the Host is closing"),
    });

    const late = await upgrade(address.port);

    expect(late.answer).toMatch(/^HTTP\/1\.1 503 /);
    await withTimeout(closing, 2_000, {
      timeoutError: () => new Error("The Host's HTTP server never closed"),
    });
  });
});
