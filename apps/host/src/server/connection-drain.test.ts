import { createServer, request, Agent, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { drainConnectionsWithin } from "./connection-drain.js";

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
