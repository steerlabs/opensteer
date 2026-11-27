import websocket from "@fastify/websocket";
import { standardCdpMessageMaxBytes } from "@opensteer/protocol/standard-cdp";
import Fastify from "fastify";
import { once } from "node:events";
import { WebSocket } from "ws";
import { installPersonalVersionGate } from "../server/host-api-registration.js";
import { installHostHttpBoundary } from "../server/host-http-boundary.js";
import type { BrowserService } from "./browser-service.js";
import { registerStandardCdpRoute } from "./standard-cdp-route.js";

/** The Home's Standard CDP endpoint as the Host registers it, and a raw client for it. */
export async function standardCdpEndpoint(
  service: () => BrowserService,
  workingIn?: Parameters<typeof registerStandardCdpRoute>[3],
) {
  const app = Fastify();
  installPersonalVersionGate(app);
  installHostHttpBoundary(app);
  await app.register(websocket, { options: { maxPayload: standardCdpMessageMaxBytes } });
  registerStandardCdpRoute(
    app,
    {
      get standardCdpTickets() {
        return service().standardCdpTickets;
      },
      attachStandardCdpForAgent: (...args) => service().attachStandardCdpForAgent(...args),
    },
    undefined,
    workingIn,
  );
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const open = async (endpoint: string) => {
    const url = new URL(new URL(endpoint).pathname, address.replace(/^http/u, "ws"));
    const socket = new WebSocket(url);
    await once(socket, "open");
    let id = 0;
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (typeof message.id === "number") pending.get(message.id)?.(message);
    });
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error("closed"));
          return;
        }
        const request = ++id;
        pending.set(request, resolve);
        socket.once("close", (code, reason) =>
          reject(new Error(`closed ${code} ${String(reason)}`)),
        );
        socket.send(
          JSON.stringify({ id: request, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
      });
    return { socket, send };
  };
  return { open, close: () => app.close() };
}
