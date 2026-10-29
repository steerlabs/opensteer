import { once } from "node:events";
import { setImmediate } from "node:timers";
import { connect as connectTls } from "node:tls";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect, type Socket, type Server } from "node:net";

/** Only foreign GETs are excluded. Unexpected requests on owned paths still reach assertions. */
export function ignoreForeignTestRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ownsPath: (path: string) => boolean,
): boolean {
  // Keep the raw path: URL normalization could hide an unexpected dot-segment request.
  const path = (request.url ?? "/").split("?", 1)[0] ?? "/";
  if (request.method !== "GET" || ownsPath(path)) return false;
  request.resume();
  response.writeHead(404, { connection: "close" }).end();
  return true;
}

/** Inject the coding harness's HTTP and TLS probes, awaiting server-side receipt, not a sleep. */
export async function probeTestServer(server: Server): Promise<void> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP fixture");
  for (const protocol of ["http", "tls"] as const) {
    const received = Promise.withResolvers<void>();
    let peerClosed: Promise<void> | undefined;
    const observe = (socket: Socket) => {
      if (socket.remotePort !== client.localPort) return;
      peerClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      // An immediate refusal is also an acknowledged probe, even without a data event.
      void peerClosed.then(() => received.resolve());
      if (!http) socket.once("data", () => setImmediate(() => received.resolve()));
    };
    const http = "setTimeout" in server;
    const requestReceived = (request: IncomingMessage) => {
      if (request.socket.remotePort === client.localPort) setImmediate(() => received.resolve());
    };
    const tlsReceived = (_error: Error, socket: Socket) => {
      const ours = socket.remotePort === client.localPort;
      socket.destroy();
      if (ours) received.resolve();
    };
    if (http) {
      if (protocol === "http") server.prependListener("request", requestReceived);
      else server.on("clientError", tlsReceived);
    }
    server.prependListener("connection", observe);
    const client =
      protocol === "tls"
        ? connectTls({ host: "127.0.0.1", port: address.port, rejectUnauthorized: false })
        : connect({ host: "127.0.0.1", port: address.port });
    client.on("error", () => undefined);
    client.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      });
      if (protocol === "http")
        client.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      await received.promise;
    } finally {
      server.removeListener("connection", observe);
      server.removeListener("request", requestReceived);
      server.removeListener("clientError", tlsReceived);
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      client.destroy();
      if (!client.closed) await closed;
      await peerClosed;
    }
  }
}

/** Reset only after a protocol acknowledgement, and wait until the server has observed the drop.
 * Does not install an error listener on the accepted socket: its owner must handle ECONNRESET.
 */
export async function resetTestServer(
  server: Server,
  acknowledge: (client: Socket) => Promise<void>,
): Promise<void> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Reset probes require TCP");
  const accepted = Promise.withResolvers<{ socket: Socket; closed: Promise<void> }>();
  const observe = (socket: Socket) => {
    if (socket.remotePort !== client.localPort) return;
    accepted.resolve({
      socket,
      closed: new Promise((resolve) => socket.once("close", () => resolve())),
    });
  };
  server.prependListener("connection", observe);
  const client = connect({ host: "127.0.0.1", port: address.port });
  const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  client.on("error", () => client.destroy());
  try {
    await once(client, "connect");
    const peer = await accepted.promise;
    if (client.destroyed || peer.socket.destroyed)
      throw new Error("Reset peer closed before protocol acknowledgement");
    await Promise.race([
      acknowledge(client),
      closed.then(() => {
        throw new Error("Reset peer closed during protocol acknowledgement");
      }),
    ]);
    if (client.destroyed || peer.socket.destroyed)
      throw new Error("Reset peer closed before reset");
    client.resetAndDestroy();
    await Promise.all([closed, peer.closed]);
  } finally {
    server.off("connection", observe);
    client.destroy();
    await closed;
  }
}

export interface TestConnectionObservation {
  readonly foreignProbe: boolean;
  readonly classified: Promise<void>;
}

/** For plain test peers, exclude only identified probes; idle, partial and other peers still count. */
export function observeTestConnection(socket: Socket): TestConnectionObservation {
  let foreign = false;
  let settled = false;
  let prefix = Buffer.alloc(0);
  const classified = Promise.withResolvers<void>();
  const finish = (probe: boolean) => {
    if (settled) return;
    settled = true;
    foreign = probe;
    prefix = Buffer.alloc(0);
    socket.off("data", receive);
    socket.off("close", closed);
    classified.resolve();
    if (probe) socket.destroy();
  };
  const closed = () => finish(false);
  const receive = (chunk: Buffer) => {
    prefix = Buffer.concat([prefix, chunk]);
    const text = prefix.toString("latin1");
    if (prefix[0] === 0x16 || text.startsWith("GET / ")) finish(true);
    else if (!"GET / ".startsWith(text)) finish(false);
  };
  socket.on("data", receive);
  socket.once("close", closed);
  return {
    get foreignProbe() {
      return foreign;
    },
    classified: classified.promise,
  };
}

/** An acknowledged classification barrier, bounded by the test's own cancellation signal. */
export async function settleTestConnections(
  observations: readonly TestConnectionObservation[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    let count = 0;
    while (count < observations.length) {
      const batch = observations.slice(count);
      count = observations.length;
      await Promise.race([Promise.all(batch.map((item) => item.classified)), cancelled.promise]);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
