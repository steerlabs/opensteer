import type { IncomingMessage, ServerResponse } from "node:http";
import type { MockPersonalHost } from "@opensteer/client/mock";
import { WebSocket } from "ws";

export interface MockPersonalRpcOptions {
  /**
   * Optional `(mockTabId -> runtimeSurfaceId)` alias so a smoke fixture whose
   * real browser runtime allocates its own `surfaceId` exposes that exact ID in
   * `resources.detail.get("tab")` and `tab.activate`.
   */
  readonly pageTabAlias?: {
    readonly from: string;
    readonly to: string;
  };
}

/**
 * Handles a `/v1/rpc/*` request against a `MockPersonalHost`. Returns `true`
 * when the request was handled.
 */
export async function handleMockPersonalRpc(
  host: MockPersonalHost,
  request: IncomingMessage,
  response: ServerResponse,
  options?: MockPersonalRpcOptions,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://fixture");
  if (!url.pathname.startsWith("/v1/rpc/")) return false;
  let body = "";
  if (request.method !== "GET" && request.method !== "HEAD") {
    for await (const chunk of request) body += String(chunk);
  }
  const alias = options?.pageTabAlias;
  const requestBody = alias && body ? body.replaceAll(alias.to, alias.from) : body;
  const reply = await host.fetch(url.toString(), {
    method: request.method ?? "GET",
    ...(requestBody ? { body: requestBody } : {}),
  });
  let text = await reply.text();
  if (alias) text = text.replaceAll(alias.from, alias.to);
  response.statusCode = reply.status;
  response.setHeader("Content-Type", reply.headers.get("content-type") ?? "application/json");
  response.end(text);
  return true;
}

/**
 * Bridges one real WebSocket upgraded on `/v1/realtime` to a `MockPersonalHost`
 * scoped-sync socket.
 */
export function bridgeMockPersonalRealtime(
  host: MockPersonalHost,
  ws: WebSocket,
  options?: MockPersonalRpcOptions,
): void {
  const alias = options?.pageTabAlias;
  const upstream = host.connect();
  upstream.addEventListener("message", (event: { readonly data: string }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(alias ? event.data.replaceAll(alias.from, alias.to) : event.data);
    }
  });
  upstream.addEventListener("close", () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
  ws.on("message", (data) => {
    const raw = data.toString();
    upstream.send(alias ? raw.replaceAll(alias.to, alias.from) : raw);
  });
  ws.on("close", () => upstream.close());
}
