import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real peers that hold a server's transport in each way that can keep its
 * close waiting, and a record of when the server let each one go.
 */

export type HeldConnectionKind =
  "unused" | "keep-alive" | "partial-headers" | "partial-body" | "upgraded" | "refused";

export interface HeldConnection {
  readonly kind: HeldConnectionKind;
  /** Settles when the connection has closed, whichever side ended it. */
  readonly closed: Promise<void>;
  isClosed(): boolean;
  /** Whether the server sent a WebSocket close frame before it let go. */
  closeFrameReceived(): boolean;
  /** Bytes the server sent after the handshake, in order. */
  readonly received: Buffer[];
  /** Sends one masked WebSocket text frame, as a client does. */
  sendText(text: string): void;
  /** Ends the connection from this side, for a test's own cleanup. */
  destroy(): void;
  report(): HeldConnectionReport;
}

export interface HeldConnectionReport {
  readonly kind: HeldConnectionKind;
  readonly closed: boolean;
  readonly closeFrameReceived: boolean;
  readonly events: readonly { readonly afterMs: number; readonly event: string }[];
}

/**
 * Opens one HTTP connection of each kind a peer can leave a server holding:
 * one that never sends a byte, one idle in keep-alive after a completed
 * request, one stopped partway through its headers and one partway through
 * its body. Settles once the server has answered the last request sent, so it
 * has read what the others sent before it.
 */
export async function holdHttpConnections(port: number, path = "/"): Promise<HeldConnection[]> {
  const unused = await open("unused", port);
  const headers = await open("partial-headers", port);
  headers.socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n`);
  const body = await open("partial-body", port);
  body.socket.write(
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: 1024\r\n\r\npartial`,
  );
  const keepAlive = await open("keep-alive", port);
  keepAlive.socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`,
  );
  await keepAlive.firstData;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return [unused, keepAlive, headers, body].map((connection) => connection.held);
}

/**
 * Upgrades one connection to a WebSocket and then never answers anything,
 * a close frame included, while still reading what the server sends.
 */
export async function holdUpgradedConnection(
  port: number,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<HeldConnection> {
  const connection = await open("upgraded", port);
  connection.socket.write(webSocketUpgradeRequest(port, path, headers));
  await connection.upgraded;
  return connection.held;
}

/**
 * The bytes of a WebSocket upgrade request; without `key`, a malformed one
 * that no WebSocket server accepts.
 */
export function webSocketUpgradeRequest(
  port: number,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  options: { readonly key?: boolean } = {},
): string {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    ...(options.key === false ? [] : [`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`]),
    "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");
}

/**
 * Sends a request the server refuses outside its HTTP connections, such as an
 * upgrade or CONNECT, reads the refusal and then keeps its own side open: it
 * never answers the server's end of the connection. Settles with the
 * refusal's status line.
 */
export async function holdRefusedConnection(
  port: number,
  request: string,
): Promise<{ readonly connection: HeldConnection; readonly status: string }> {
  const connection = await open("refused", port, { allowHalfOpen: true });
  connection.socket.write(request);
  await connection.firstData;
  const status = connection.response().split("\r\n")[0] ?? "";
  return { connection: connection.held, status };
}

/**
 * Completes a WebSocket upgrade on a raw socket and nothing more, so the peer
 * behind it never answers a close frame. False when the request is not one.
 */
export function acceptUpgrade(socket: Socket, request: string): boolean {
  const key = /^sec-websocket-key:\s*(\S+)\s*$/imu.exec(request)?.[1];
  if (!key) return false;
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return true;
}

/** Whether nothing accepts connections on the port any longer. */
export function connectionRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"));
  });
}

export type Settled<Value> =
  | { readonly settled: "fulfilled"; readonly value: Value; readonly ms: number }
  | { readonly settled: "rejected"; readonly reason: string; readonly ms: number }
  | { readonly settled: "still waiting"; readonly ms: number };

/**
 * How a promise settled within a bound far beyond any transport's own work;
 * the bound is how a test tells an operation that waits on its peers, not a
 * deadline the owner keeps.
 */
export async function settleWithin<Value>(
  promise: Promise<Value>,
  boundMs = 5_000,
): Promise<Settled<Value>> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(
      (value): Settled<Value> => ({ settled: "fulfilled", value, ms: elapsed() }),
      (error: unknown): Settled<Value> => ({
        settled: "rejected",
        reason: error instanceof Error ? error.message : String(error),
        ms: elapsed(),
      }),
    ),
    new Promise<Settled<Value>>((resolve) => {
      timer = setTimeout(() => resolve({ settled: "still waiting", ms: elapsed() }), boundMs);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

export interface ObservedClose {
  readonly settled: "closed" | "rejected" | "still waiting";
  readonly ms: number;
}

/** Times an owner's close against the same kind of bound. */
export async function observeClose(
  closing: Promise<unknown>,
  boundMs = 5_000,
): Promise<ObservedClose> {
  const result = await settleWithin(closing, boundMs);
  return {
    settled: result.settled === "fulfilled" ? "closed" : result.settled,
    ms: result.ms,
  };
}

/** Waits for every connection to close, up to the same kind of bound. */
export async function allClosed(
  connections: readonly { readonly closed: Promise<void> }[],
  boundMs = 5_000,
): Promise<boolean> {
  const observed = await observeClose(
    Promise.all(connections.map((connection) => connection.closed)),
    boundMs,
  );
  return observed.settled === "closed";
}

/**
 * Writes one owner's cases where the run keeps its artifacts, outside the
 * checkout: `OPENSTEER_TRANSPORT_CLOSE_ARTIFACT_DIR`, else the temporary
 * directory.
 */
export async function writeTransportCloseReport(
  name: string,
  cases: readonly Readonly<Record<string, unknown>>[],
): Promise<string> {
  const directory =
    process.env.OPENSTEER_TRANSPORT_CLOSE_ARTIFACT_DIR ??
    join(tmpdir(), "opensteer-transport-close");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${name}.json`);
  await writeFile(
    file,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, cases }, null, 2)}\n`,
  );
  return file;
}

async function open(
  kind: HeldConnectionKind,
  port: number,
  options: { readonly allowHalfOpen?: boolean } = {},
) {
  const started = performance.now();
  const events: { afterMs: number; event: string }[] = [];
  const note = (event: string) =>
    events.push({ afterMs: Math.round(performance.now() - started), event });
  const socket = connect({
    allowHalfOpen: options.allowHalfOpen ?? false,
    host: "127.0.0.1",
    port,
  });
  const received: Buffer[] = [];
  let closed = false;
  let closeFrame = false;
  let handshake = Buffer.alloc(0);
  let upgradedNow = false;
  let resolveFirstData: () => void = () => undefined;
  const firstData = new Promise<void>((resolve) => {
    resolveFirstData = resolve;
  });
  let resolveUpgraded: () => void = () => undefined;
  let rejectUpgraded: (error: Error) => void = () => undefined;
  const upgraded = new Promise<void>((resolve, reject) => {
    resolveUpgraded = resolve;
    rejectUpgraded = reject;
  });
  // A test that only opens a plain connection never awaits the upgrade.
  upgraded.catch(() => undefined);
  socket.on("data", (chunk: Buffer) => {
    note(`received ${chunk.byteLength} bytes`);
    resolveFirstData();
    if (upgradedNow) {
      received.push(chunk);
      closeFrame ||= containsCloseFrame(Buffer.concat(received));
      return;
    }
    handshake = Buffer.concat([handshake, chunk]);
    if (kind !== "upgraded") return;
    const end = handshake.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = handshake.subarray(0, end).toString("latin1");
    if (!head.startsWith("HTTP/1.1 101")) {
      rejectUpgraded(new Error(`The upgrade was refused: ${head.split("\r\n")[0] ?? ""}`));
      return;
    }
    upgradedNow = true;
    note("upgraded");
    const rest = handshake.subarray(end + 4);
    if (rest.byteLength > 0) {
      received.push(rest);
      closeFrame = containsCloseFrame(rest);
    }
    resolveUpgraded();
  });
  socket.on("error", (error: NodeJS.ErrnoException) =>
    note(`error ${error.code ?? error.message}`),
  );
  socket.on("end", () => note("ended by server"));
  const closedPromise = new Promise<void>((resolve) => {
    socket.once("close", () => {
      closed = true;
      note("closed");
      rejectUpgraded(new Error("The connection closed before it upgraded."));
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      note("connected");
      resolve();
    });
    socket.once("error", reject);
  });
  const held: HeldConnection = {
    kind,
    closed: closedPromise,
    isClosed: () => closed,
    closeFrameReceived: () => closeFrame,
    received,
    sendText: (text) => {
      socket.write(maskedTextFrame(text));
      note(`sent ${Buffer.byteLength(text)} byte text frame`);
    },
    destroy: () => socket.destroy(),
    report: () => ({ kind, closed, closeFrameReceived: closeFrame, events: [...events] }),
  };
  return {
    firstData,
    held,
    response: () => handshake.toString("latin1"),
    socket,
    upgraded,
  };
}

/** Whether the frames a server sent, from the first, include a close frame. */
function containsCloseFrame(chunk: Buffer): boolean {
  let offset = 0;
  while (offset + 2 <= chunk.byteLength) {
    const opcode = chunk[offset]! & 0x0f;
    if (opcode === 0x8) return true;
    let length = chunk[offset + 1]! & 0x7f;
    let header = 2;
    if (length === 126) {
      if (offset + 4 > chunk.byteLength) return false;
      length = chunk.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (offset + 10 > chunk.byteLength) return false;
      length = Number(chunk.readBigUInt64BE(offset + 2));
      header = 10;
    }
    offset += header + length;
  }
  return false;
}

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const length =
    payload.byteLength < 126
      ? Buffer.from([0x80 | payload.byteLength])
      : Buffer.from([0x80 | 126, payload.byteLength >> 8, payload.byteLength & 0xff]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
  return Buffer.concat([Buffer.from([0x81]), length, mask, masked]);
}
