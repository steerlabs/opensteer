import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { createId } from "../packages/core/src/index.js";
import {
  RunnerConnectionFenceSchema,
  type AppRuntimeSpec,
} from "../packages/protocol/src/index.js";
import type { RunnerIdentity } from "../packages/orchestration/src/index.js";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it } from "vitest";
import { openAppTunnel } from "../apps/runner/src/apps/app-tunnel.js";
import { AppTunnelHub } from "../apps/host/src/apps/app-tunnel-hub.js";
import { requestAppHttp } from "../apps/host/src/apps/app-proxy.js";

it("pipes HTTP POST and incremental SSE over one-use WebSocket tickets, fences reconnects and closes upstream on abort", async () => {
  const upstream = createServer((req, res) => {
    req.resume();
    req.once("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: uploaded\n\n");
    });
  });
  const listen = once(upstream, "listening", { signal: AbortSignal.timeout(3_000) });
  upstream.listen(0, "127.0.0.1");
  await listen;
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  const host = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const tunnels = new WebSocketServer({
    server: host,
    maxPayload: 64 * 1_024,
    perMessageDeflate: false,
  });
  const fence = RunnerConnectionFenceSchema.parse({
    runnerId: createId("runner"),
    bootId: `rbt_${crypto.randomUUID()}`,
    connectionGeneration: 1,
    connectionId: `rcn_${crypto.randomUUID()}`,
    connectionLeaseId: `rls_${crypto.randomUUID()}`,
  });
  const environmentId = createId("environment");
  let identity = {
    ...fence,
    fence,
    environmentId,
    environmentIds: [environmentId],
  } as unknown as RunnerIdentity;
  let connection = new AbortController();
  let replaceBeforeDial = false;
  const lifetime = new AbortController();
  const done: Promise<void>[] = [];
  let origin: URL;
  let usedTicket = "";
  const hub = new AppTunnelHub({
    identityForEnvironment: () => identity,
    identityForRunner: () => identity,
    appConnectionSignal: () => connection.signal,
    requestApp: async (_environment, request, signal) => {
      if (request.type !== "host.app.connect") throw new Error("Unexpected control request");
      usedTicket = request.ticket;
      if (replaceBeforeDial)
        identity = { ...identity, fence: { ...fence, connectionGeneration: 2 } };
      const tunnel = await openAppTunnel(
        { hostUrl: origin, mode: "development", controlCaPath: undefined },
        request.ticket,
        address.port,
        lifetime.signal,
        signal,
      );
      done.push(tunnel.done);
      return {
        type: "runner.app.result",
        ok: true,
        appId: request.spec.appId,
        requestId: request.requestId,
        fence: {
          ...fence,
          environmentId,
          bindingGeneration: 1,
        },
        port: address.port,
      };
    },
  });
  tunnels.on("connection", (socket, request) =>
    hub.accept(new URL(request.url ?? "/", "http://host").searchParams.get("ticket")!, socket),
  );
  const hostListening = once(host, "listening", { signal: AbortSignal.timeout(3_000) });
  host.listen(0, "127.0.0.1");
  await hostListening;
  const hostAddress = host.address();
  if (!hostAddress || typeof hostAddress === "string") throw new Error("Missing Host port");
  origin = new URL(`http://127.0.0.1:${hostAddress.port}`);
  const spec: AppRuntimeSpec = {
    appId: `app_${crypto.randomUUID()}`,
    version: 1,
    folder: { computerId: fence.runnerId, path: "/tmp/app-tunnel-test" },
    command: "node server.js",
  };
  try {
    const abort = new AbortController();
    let socket!: import("node:net").Socket;
    const connected = once(upstream, "connection", { signal: AbortSignal.timeout(3_000) }).then(
      ([value]) => {
        socket = value;
      },
    );
    const response = await requestAppHttp({
      method: "POST",
      path: "/events",
      prefix: "/v1/apps/id/dark/token",
      theme: "dark",
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.alloc(300_000, 120)]),
      signal: abort.signal,
      connect: (signal) => hub.connect(spec, signal),
    });
    await connected;
    const reader = response.body[Symbol.asyncIterator]();
    expect(
      String(
        (
          await withTimeout(reader.next(), 2_000, {
            timeoutError: () => new Error("SSE did not arrive before response end"),
          })
        ).value,
      ),
    ).toContain("uploaded");
    const replay = new WebSocket(
      new URL(`/internal/v1/apps/tunnel?ticket=${usedTicket}`, origin)
        .toString()
        .replace("http:", "ws:"),
    );
    const denied = once(replay, "close", { signal: AbortSignal.timeout(2_000) });
    expect((await denied)[0]).toBe(1008);
    const closed = once(socket, "close", { signal: AbortSignal.timeout(2_000) });
    abort.abort();
    await closed;
    const second = await hub.connect(spec, AbortSignal.timeout(3_000));
    const ended = withTimeout(
      new Promise<void>((resolve) => second.stream.once("close", resolve)),
      2_000,
      { timeoutError: () => new Error("Primary connection loss did not close app tunnel") },
    );
    connection.abort();
    await ended;
    // Replacing the connection after ticket minting cannot spend its old ticket.
    connection = new AbortController();
    replaceBeforeDial = true;
    await expect(hub.connect(spec, AbortSignal.timeout(300))).rejects.toThrow();
  } finally {
    lifetime.abort();
    await Promise.all(done);
    for (const socket of tunnels.clients) socket.terminate();
    await withTimeout(
      new Promise<void>((resolve, reject) =>
        tunnels.close((error) => (error ? reject(error) : resolve())),
      ),
      2_000,
      { timeoutError: () => new Error("Tunnel WebSocket server did not close") },
    );
    await closeHttpServerNow(host);
    await closeHttpServerNow(upstream);
  }
});
