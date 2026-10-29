import { once } from "node:events";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  ignoreForeignTestRequest,
  observeTestConnection,
  probeTestServer,
  settleTestConnections,
  type TestConnectionObservation,
} from "./serverProbes.test-support.js";

it("excludes foreign GETs while preserving every owned-path request and wrong method", async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    if (ignoreForeignTestRequest(request, response, (path) => path.startsWith("/owned"))) return;
    seen.push(`${request.method} ${request.url}`);
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await probeTestServer(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TCP required");
    for (const [method, path] of [
      ["GET", "/unserved"],
      ["GET", "/owned?x=1"],
      ["DELETE", "/owned"],
      ["POST", "/unserved"],
    ] as const) {
      await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
    }
    expect(seen).toEqual(["GET /owned?x=1", "DELETE /owned", "POST /unserved"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("raw counters exclude acknowledged probes and retain idle, partial and dropped real peers", async ({
  signal,
}) => {
  const observations: TestConnectionObservation[] = [];
  const bySocket = new Map<Socket, TestConnectionObservation>();
  const open = new Set<Socket>();
  const clients = new Set<Socket>();
  const server = createTcpServer((socket) => {
    open.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => open.delete(socket));
    const observation = observeTestConnection(socket);
    observations.push(observation);
    bySocket.set(socket, observation);
    socket.on("data", (chunk) => {
      if (!observation.foreignProbe) socket.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP required");
  const peer = async () => {
    const accepted = Promise.withResolvers<Socket>();
    const match = (socket: Socket) => {
      if (socket.remotePort !== client.localPort) return;
      server.off("connection", match);
      accepted.resolve(socket);
    };
    server.prependListener("connection", match);
    const client = connect(address.port, "127.0.0.1");
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.on("error", () => client.destroy());
    await once(client, "connect");
    const socket = await accepted.promise;
    return { client, observation: bySocket.get(socket)! };
  };
  const owned = () => observations.filter((item) => !item.foreignProbe);
  try {
    await probeTestServer(server);
    await settleTestConnections(observations, signal);
    expect(owned()).toHaveLength(0);
    const idle = await peer();
    expect(owned()).toContain(idle.observation);
    const cancelled = new AbortController();
    const waiting = settleTestConnections(observations, cancelled.signal);
    cancelled.abort(new Error("idle peer remains unclassified"));
    await expect(waiting).rejects.toThrow("idle peer remains unclassified");
    const echoed = once(idle.client, "data");
    idle.client.write("ping");
    await echoed;
    await settleTestConnections(observations, signal);
    const closed = once(idle.client, "close");
    idle.client.resetAndDestroy();
    await closed;
    expect(owned()).toContain(idle.observation);

    const partial = await peer();
    const prefix = once(partial.client, "data");
    partial.client.write("GE");
    await prefix; // Server receipt and echo acknowledge the incomplete protocol prefix.
    expect(owned()).toContain(partial.observation);
    partial.client.write("T / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await partial.observation.classified;
    expect(partial.observation.foreignProbe).toBe(true);
    expect(owned()).not.toContain(partial.observation);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const clientCloses = [...clients].map(
      (client) => new Promise<void>((resolve) => client.once("close", () => resolve())),
    );
    for (const socket of open) socket.destroy();
    for (const client of clients) client.destroy();
    await Promise.all([closed, ...clientCloses]);
  }
});

it("acknowledges a fixture that rejects a probe before reading its protocol", async ({
  signal,
}) => {
  const server = createTcpServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.destroy();
  });
  const stop = () => server.close();
  signal.addEventListener("abort", stop, { once: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await probeTestServer(server);
  } finally {
    signal.removeEventListener("abort", stop);
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
