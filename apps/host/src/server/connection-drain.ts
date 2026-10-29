import type { Server } from "node:http";

/** How often connections that have become idle are closed while the server drains. */
const idleSweepIntervalMs = 50;

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
  const sweep = setInterval(() => server.closeIdleConnections(), idleSweepIntervalMs);
  const cutoff = setTimeout(() => server.closeAllConnections(), graceMs);
  sweep.unref();
  cutoff.unref();
  server.once("close", () => {
    clearInterval(sweep);
    clearTimeout(cutoff);
  });
}
