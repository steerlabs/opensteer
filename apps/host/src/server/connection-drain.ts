import { refuseConnection } from "@opensteer/shared/httpServer";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

/** How often connections that have become idle are closed while the server drains. */
const idleSweepIntervalMs = 50;

const trackedSockets = new WeakMap<Server, Set<Socket>>();

/**
 * Records open sockets on `server` without attaching data listeners so shutdown
 * can close sockets that connected and never sent a byte (such as HTTP client
 * pool pre-connects). Node's `server.closeIdleConnections()` only closes sockets
 * that have finished at least one HTTP request, leaving zero-byte sockets open
 * until the full shutdown grace elapses.
 */
export function trackIdleConnections(server: Server): void {
  if (trackedSockets.has(server)) return;
  const sockets = new Set<Socket>();
  trackedSockets.set(server, sockets);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

function closeUnusedConnections(server: Server): void {
  const sockets = trackedSockets.get(server);
  if (!sockets) return;
  for (const socket of sockets) {
    if (socket.bytesRead === 0 && socket.readableLength === 0) {
      sockets.delete(socket);
      socket.destroy();
    }
  }
}

function closeIdle(server: Server): void {
  server.closeIdleConnections();
  // Only cut zero-byte sockets once the server has stopped listening so a late
  // connection arriving during WebSocket preClose still gets its HTTP answer.
  if (!server.listening) closeUnusedConnections(server);
}

/**
 * Bounds how long a closing server waits for its HTTP connections.
 *
 * Closing closes the connections idle at that moment and waits for the rest.
 * One still serving a request then answers and sits in keep-alive for the whole
 * keep-alive timeout, 72 s by Fastify's default, holding the process open that
 * long. Here connections are closed as they become idle, and any request still
 * unanswered when the grace runs out is cut off.
 */
export function drainConnectionsWithin(server: Server, graceMs: number): void {
  const immediate = setImmediate(() => closeIdle(server));
  const sweep = setInterval(() => closeIdle(server), idleSweepIntervalMs);
  const cutoff = setTimeout(() => server.closeAllConnections(), graceMs);
  immediate.unref();
  sweep.unref();
  cutoff.unref();
  server.once("close", () => {
    clearImmediate(immediate);
    clearInterval(sweep);
    clearTimeout(cutoff);
  });
}

/**
 * Ends every WebSocket when the Host stops. Each is asked to close first, so a
 * live peer hears why; one that has not finished closing by the deadline is
 * terminated. A peer whose transport is already gone never answers a close
 * frame, and waiting out the socket's own thirty-second close timeout would
 * hold a Host restart hostage to the slowest dead connection.
 */
export function closeWebSocketsWithin(
  graceMs: number,
  httpGraceMs: number,
  httpServer?: Server,
): (this: FastifyInstance, done: () => void) => void {
  if (httpServer) trackIdleConnections(httpServer);
  return function preClose(done) {
    // Fastify closes the HTTP server once this finishes; the drain then keeps
    // a request answered mid-shutdown from holding it in keep-alive.
    drainConnectionsWithin(this.server, httpGraceMs);
    // The server still listens until this finishes, and a peer told to go
    // reconnects at once. Fastify answers that upgrade 503 but leaves its socket
    // open, and the server's close would wait on it for as long as the peer does.
    this.server.removeAllListeners("upgrade");
    this.server.on("upgrade", (_request: IncomingMessage, socket: Duplex) =>
      refuseConnection(socket, 503, "Service Unavailable"),
    );
    const server = this.websocketServer;
    for (const client of server.clients) client.close(1001, "Host is shutting down");
    const deadline = setTimeout(() => {
      for (const client of server.clients) client.terminate();
    }, graceMs);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      done();
      setImmediate(() => closeIdle(this.server)).unref();
    });
    if (server.clients.size === 0) {
      clearTimeout(deadline);
    }
  };
}
