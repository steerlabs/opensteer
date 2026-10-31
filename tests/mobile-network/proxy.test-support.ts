import net, { type Socket } from "node:net";

export interface LinkProfile {
  readonly latencyUpMs: number;
  readonly latencyDownMs: number;
  /** Bits/second, decimal units; zero means unlimited. Shared by all connections. */
  readonly upBps: number;
  readonly downBps: number;
  /** A deterministic queue stall, not packet loss. */
  readonly stall?: { readonly everyChunks: number; readonly delayMs: number };
}

export const linkProfiles = {
  lan: { latencyUpMs: 0, latencyDownMs: 0, upBps: 0, downBps: 0 },
  "4g": { latencyUpMs: 50, latencyDownMs: 50, upBps: 3_000_000, downBps: 9_000_000 },
  "weak-cell": { latencyUpMs: 200, latencyDownMs: 200, upBps: 384_000, downBps: 1_000_000 },
  edge: { latencyUpMs: 450, latencyDownMs: 450, upBps: 100_000, downBps: 240_000 },
} as const satisfies Record<string, LinkProfile>;
export type ProfileName = keyof typeof linkProfiles;

export interface ConnectionRecord {
  readonly id: number;
  readonly openedAtMs: number;
  closedAtMs: number | null;
  bytesUp: number;
  bytesDown: number;
}
export interface RequestLine {
  readonly atMs: number;
  readonly connection: number;
  readonly method: string;
  readonly path: string;
  readonly upgrade: boolean;
}

/** Only retains method/path and upgrade presence, never headers, bodies or query values. */
export class RequestLines {
  #buffer = Buffer.alloc(0);
  #bodyLeft = 0;
  #upgraded = false;
  readonly observe: (line: Omit<RequestLine, "atMs" | "connection">) => void;
  constructor(observe: (line: Omit<RequestLine, "atMs" | "connection">) => void) {
    this.observe = observe;
  }
  accept(chunk: Buffer): void {
    if (this.#upgraded) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#bodyLeft) {
        const consumed = Math.min(this.#bodyLeft, this.#buffer.length);
        this.#bodyLeft -= consumed;
        this.#buffer = this.#buffer.subarray(consumed);
        if (this.#bodyLeft) return;
      }
      const end = this.#buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.#buffer.length > 64 * 1024) this.#buffer = Buffer.alloc(0);
        return;
      }
      const header = this.#buffer.subarray(0, end).toString("latin1");
      this.#buffer = this.#buffer.subarray(end + 4);
      const match = /^([A-Z]+) ([^ ]+) HTTP\/1\.[01]\r?$/mu.exec(header);
      if (!match) return;
      const upgrade = /^upgrade:\s*websocket\s*$/imu.test(header);
      this.observe({
        method: match[1]!,
        path: new URL(match[2]!, "http://localhost").pathname,
        upgrade,
      });
      if (upgrade) {
        this.#upgraded = true;
        this.#buffer = Buffer.alloc(0);
        return;
      }
      // The Node/React Native JSON fetches used here send Content-Length, not chunked uploads.
      if (/^transfer-encoding:/imu.test(header))
        throw new Error("Benchmark does not support chunked request uploads");
      this.#bodyLeft = Number(/^content-length:\s*(\d+)/imu.exec(header)?.[1] ?? 0);
      if (!this.#buffer.length) return;
    }
  }
}

/** One serialization queue per direction models a link shared by HTTP and WebSocket. */
export class Direction {
  #availableAt = 0;
  #chunks = 0;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #delivery: { ready: boolean; deliver: () => void }[] = [];
  #pending = new WeakMap<Socket, number>();
  #afterDrain = new WeakMap<Socket, () => void>();
  readonly bps: number;
  readonly latencyMs: number;
  readonly stall: LinkProfile["stall"];
  constructor(bps: number, latencyMs: number, stall: LinkProfile["stall"]) {
    this.bps = bps;
    this.latencyMs = latencyMs;
    this.stall = stall;
  }
  send(source: Socket, target: Socket, chunk: Buffer, delivered: (bytes: number) => void): void {
    this.#pending.set(source, (this.#pending.get(source) ?? 0) + chunk.length);
    if (this.#pending.get(source)! > 1024 * 1024) source.pause();
    for (let offset = 0; offset < chunk.length; offset += 16_384) {
      const part = chunk.subarray(offset, offset + 16_384);
      const now = performance.now();
      const stall =
        this.stall && ++this.#chunks % this.stall.everyChunks === 0 ? this.stall.delayMs : 0;
      this.#availableAt =
        Math.max(now, this.#availableAt) +
        (this.bps ? (part.length * 8_000) / this.bps : 0) +
        stall;
      const delivery = {
        ready: false,
        deliver: () => {
          if (!target.destroyed) {
            delivered(part.length);
            target.write(part);
          }
          const pending = this.#pending.get(source)! - part.length;
          this.#pending.set(source, pending);
          if (pending < 512 * 1024 && !source.destroyed) source.resume();
          if (pending === 0) this.#afterDrain.get(source)?.();
        },
      };
      this.#delivery.push(delivery);
      const timer = setTimeout(
        () => {
          this.#timers.delete(timer);
          delivery.ready = true;
          // Relative timer rounding may reorder readiness, never TCP bytes.
          while (this.#delivery[0]?.ready) this.#delivery.shift()!.deliver();
        },
        Math.max(0, this.#availableAt + this.latencyMs - now),
      );
      this.#timers.add(timer);
    }
  }
  finish(source: Socket, target: Socket): void {
    const end = () => {
      if (!target.destroyed) target.end();
    };
    if ((this.#pending.get(source) ?? 0) === 0) end();
    else this.#afterDrain.set(source, end);
  }
  close(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#delivery.length = 0;
  }
}

export async function startShapingProxy(target: URL, profile: LinkProfile) {
  const started = performance.now();
  const connections: ConnectionRecord[] = [];
  const requests: RequestLine[] = [];
  const sockets = new Set<Socket>();
  const up = new Direction(profile.upBps, profile.latencyUpMs, profile.stall);
  const down = new Direction(profile.downBps, profile.latencyDownMs, profile.stall);
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const record: ConnectionRecord = {
      id: connections.length + 1,
      openedAtMs: performance.now() - started,
      closedAtMs: null,
      bytesUp: 0,
      bytesDown: 0,
    };
    connections.push(record);
    const host = net.connect({
      host: target.hostname,
      port: Number(target.port),
      allowHalfOpen: true,
    });
    const lines = new RequestLines((line) =>
      requests.push({ ...line, connection: record.id, atMs: performance.now() - started }),
    );
    for (const socket of [client, host]) {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on("error", () => {
        client.destroy();
        host.destroy();
      });
      socket.on("close", () => {
        sockets.delete(socket);
        client.destroy();
        host.destroy();
        record.closedAtMs ??= performance.now() - started;
      });
    }
    client.on("data", (chunk: Buffer) => {
      try {
        lines.accept(chunk);
      } catch {
        client.destroy();
        host.destroy();
        return;
      }
      up.send(client, host, chunk, (bytes) => {
        record.bytesUp += bytes;
      });
    });
    host.on("data", (chunk: Buffer) =>
      down.send(host, client, chunk, (bytes) => {
        record.bytesDown += bytes;
      }),
    );
    client.on("end", () => up.finish(client, host));
    host.on("end", () => down.finish(host, client));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not listen");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    connections,
    requests,
    now: () => performance.now() - started,
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      up.close();
      down.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
