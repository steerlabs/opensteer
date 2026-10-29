import { connect, type Socket, type Server } from "node:net";
import { createServer } from "node:http";
import { ignoreForeignTestRequest } from "@opensteer/shared/test-support/serverProbes";

export interface HoldingHop {
  readonly url: URL;
  readonly server: Server;
  counts(): {
    readonly closedBeforeRelease: number;
    readonly forwarded: number;
    readonly held: number;
  };
  hold(): void;
  release(): void;
  target(port: number): void;
  close(): Promise<void>;
}

/**
 * The hop between the Runner's shell relay and the Host. While held, a new
 * connection is accepted and left unanswered — a Host handshake in flight —
 * until release carries on whatever of it is still open.
 */
export async function startHoldingHop(): Promise<HoldingHop> {
  let targetPort = 0;
  let holding = false;
  const open = new Set<Socket>();
  const pending: { readonly chunks: Buffer[]; closed: boolean; readonly socket: Socket }[] = [];
  const counts = { closedBeforeRelease: 0, forwarded: 0, held: 0 };
  const forward = (downstream: Socket, chunks: readonly Buffer[]) => {
    const upstream = connect(targetPort, "127.0.0.1");
    open.add(upstream);
    for (const chunk of chunks) upstream.write(chunk);
    const end = () => {
      downstream.destroy();
      upstream.destroy();
      open.delete(downstream);
      open.delete(upstream);
    };
    downstream.on("error", end);
    upstream.on("error", end);
    downstream.on("close", end);
    upstream.on("close", end);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  };
  const server = createServer((request, response) => {
    if (
      ignoreForeignTestRequest(request, response, (path) => path === "/internal/v1/shell/connect")
    )
      return;
    throw new Error(`Expected a shell WebSocket upgrade on ${request.url}`);
  });
  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => open.delete(socket));
  });
  server.on("upgrade", (request, transport, head) => {
    if ((request.url ?? "").split("?", 1)[0] !== "/internal/v1/shell/connect")
      throw new Error(`Unexpected shell upgrade: ${request.url}`);
    const downstream = transport as Socket;
    downstream.allowHalfOpen = false;
    // The HTTP parser consumed the request head; the held proxy forwards the same wire headers.
    const headers = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2)
      headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    const chunks: Buffer[] = [
      Buffer.from(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`,
      ),
      head,
    ];
    if (!holding) {
      forward(downstream, chunks);
      return;
    }
    counts.held += 1;
    const entry = { chunks, closed: false, socket: downstream };
    pending.push(entry);
    downstream.on("data", (chunk: Buffer) => entry.chunks.push(chunk));
    downstream.on("error", () => undefined);
    downstream.once("close", () => {
      entry.closed = true;
      open.delete(downstream);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The hop is not listening");
  return {
    server,
    close: async () => {
      for (const socket of open) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    counts: () => ({ ...counts }),
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const entry of pending.splice(0)) {
        if (entry.closed) {
          counts.closedBeforeRelease += 1;
          continue;
        }
        counts.forwarded += 1;
        entry.socket.removeAllListeners("data");
        forward(entry.socket, entry.chunks);
      }
    },
    target: (port) => {
      targetPort = port;
    },
    url: new URL(`http://127.0.0.1:${address.port}`),
  };
}
