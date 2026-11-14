import type { WebSocket, RawData } from "ws";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { teamPartnerMaxFrameBytes } from "@opensteer/protocol";
import { partnerError } from "./identity.js";

export class PartnerSocket {
  readonly #queue: { frame: unknown; bytes: number }[] = [];
  #bytes = 0;
  #waiting: { resolve: (frame: unknown) => void; reject: (error: Error) => void } | undefined;
  readonly closed: Promise<void>;
  #heartbeat: ReturnType<typeof setInterval>;
  #pong = true;

  readonly socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise((resolve) =>
      socket.once("close", () => {
        clearInterval(this.#heartbeat);
        this.#waiting?.reject(partnerError("partner-disconnected"));
        this.#waiting = undefined;
        this.#queue.length = 0;
        resolve();
      }),
    );
    socket.on("message", (raw: RawData, binary: boolean) => {
      const bytes = Array.isArray(raw)
        ? raw.reduce((n, b) => n + b.length, 0)
        : raw instanceof ArrayBuffer
          ? raw.byteLength
          : raw.length;
      if (
        binary ||
        bytes > teamPartnerMaxFrameBytes ||
        this.#queue.length >= 32 ||
        this.#bytes + bytes > 1024 * 1024
      ) {
        socket.terminate();
        return;
      }
      try {
        const frame: unknown = JSON.parse(raw.toString());
        if (this.#waiting) {
          this.#waiting.resolve(frame);
          this.#waiting = undefined;
        } else {
          this.#queue.push({ frame, bytes });
          this.#bytes += bytes;
        }
      } catch {
        socket.terminate();
      }
    });
    socket.on("error", () => socket.terminate());
    socket.on("pong", () => {
      this.#pong = true;
    });
    this.#heartbeat = setInterval(() => {
      if (!this.#pong) socket.terminate();
      else {
        this.#pong = false;
        socket.ping();
      }
    }, 20_000);
    this.#heartbeat.unref();
  }

  next(): Promise<unknown> {
    const queued = this.#queue.shift();
    if (queued) {
      this.#bytes -= queued.bytes;
      return Promise.resolve(queued.frame);
    }
    if (this.socket.readyState !== 1) return Promise.reject(partnerError("partner-disconnected"));
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  send(frame: unknown): Promise<void> {
    if (this.socket.readyState !== 1 || this.socket.bufferedAmount > 1024 * 1024) {
      this.socket.terminate();
      return Promise.reject(partnerError("partner-disconnected"));
    }
    return new Promise((resolve, reject) =>
      this.socket.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve())),
    );
  }

  async close(frame?: unknown) {
    try {
      if (frame && this.socket.readyState === 1)
        await withTimeout(this.send(frame), 1000, {
          timeoutError: () => partnerError("partner-send-timeout"),
        });
    } catch {
      // Remote notification is best effort; local revocation always closes the socket.
    } finally {
      this.socket.terminate();
    }
    await withTimeout(this.closed, 1000, {
      timeoutError: () => partnerError("partner-close-timeout"),
    });
  }
}
