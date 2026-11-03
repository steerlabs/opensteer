import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { displayMaxEnvelopeBytes } from "@opensteer/protocol";
import { refuseConnection } from "@opensteer/shared/httpServer";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import type { BrowserVideoHub } from "./browser-video-hub.js";

export function registerBrowserVideoRoutes(app: FastifyInstance, hub: BrowserVideoHub): void {
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
      viewer.handleUpgrade(request, socket, head, (client) => {
        const deadline = setTimeout(() => client.close(4003, "Media admission timed out"), 4000);
        deadline.unref();
        client.once("close", () => clearTimeout(deadline));
        client.on("error", () => client.close(1011, "Media transport ended"));
        client.once("message", (raw, binary) => {
          try {
            if (binary) throw new Error("Media admission required");
            const message = z
              .strictObject({
                type: z.literal("video.attach"),
                token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
              })
              .parse(JSON.parse(rawDataBuffer(raw).toString("utf8")));
            // Stop processing additional commands until exact outlet authority is checked.
            client.pause();
            void hub.claimViewer(message.token).then(
              (admitted) => {
                clearTimeout(deadline);
                if (client.readyState !== client.OPEN) return;
                hub.attachViewer(admitted, client);
                client.resume();
              },
              () => client.close(4003, "Browser media admission ended"),
            );
          } catch {
            client.close(4003, "Invalid browser media admission");
          }
        });
      });
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
