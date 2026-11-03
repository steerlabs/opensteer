import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";
import { displayMaxEnvelopeBytes } from "@opensteer/protocol";
import { refuseConnection } from "@opensteer/shared/httpServer";
import type { BrowserVideoHub } from "./browser-video-hub.js";

export function registerBrowserVideoRoutes(
  app: FastifyInstance,
  hub: BrowserVideoHub,
  authenticate: (request: IncomingMessage) => Promise<unknown>,
): void {
  const source = new WebSocketServer({
    noServer: true,
    maxPayload: displayMaxEnvelopeBytes,
    perMessageDeflate: false,
  });
  const viewer = new WebSocketServer({
    noServer: true,
    maxPayload: 16384,
    perMessageDeflate: false,
  });
  const inherited = app.server.listeners("upgrade") as ((
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void)[];
  app.server.removeAllListeners("upgrade");
  app.server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://host.invalid").pathname;
    if (path !== "/internal/v1/browser/video" && path !== "/v1/browser/video") {
      for (const listener of inherited) listener.call(app.server, request, socket, head);
      return;
    }
    socket.on("error", () => undefined);
    if (request.method !== "GET") {
      refuseConnection(socket, 403, "Forbidden");
      return;
    }
    if (path === "/v1/browser/video") {
      if (viewer.clients.size >= 128) {
        refuseConnection(socket, 503, "Unavailable");
        return;
      }
      void (async () => {
        await authenticate(request);
        const match = /^opensteer-video\.([A-Za-z0-9_-]{43})$/.exec(
          request.headers["sec-websocket-protocol"] ?? "",
        );
        if (!match?.[1]) throw new Error("Browser media admission required");
        const admitted = await hub.claimViewer(match[1]);
        if (socket.destroyed || !socket.writable) return;
        viewer.handleUpgrade(request, socket, head, (client) => hub.attachViewer(admitted, client));
      })().catch(() => refuseConnection(socket, 403, "Forbidden"));
      return;
    }
    let claims: ReturnType<BrowserVideoHub["claimSource"]> | undefined;
    let upgraded = false;
    const failed = () => {
      if (claims && !upgraded) hub.failSource(claims);
    };
    try {
      const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? "");
      if (!match?.[1]) throw new Error("Browser data ticket required");
      const admitted = hub.claimSource(match[1]);
      claims = admitted;
      socket.once("close", failed);
      socket.once("error", failed);
      source.handleUpgrade(request, socket, head, (client) => {
        upgraded = true;
        socket.off("close", failed);
        socket.off("error", failed);
        client.on("error", () => undefined);
        hub.attachSource(admitted, client);
      });
      failed();
    } catch {
      failed();
      refuseConnection(socket, 403, "Forbidden");
    }
  });
  app.addHook("preClose", async () => {
    hub.close();
    for (const client of [...source.clients, ...viewer.clients]) {
      client.close(1001, "Host stopping");
      client.terminate();
    }
    await Promise.all([
      new Promise<void>((resolve) => source.close(() => resolve())),
      new Promise<void>((resolve) => viewer.close(() => resolve())),
    ]);
  });
}
