import type { RunnerConfig } from "@opensteer/config";
import {
  ShellConnectErrorSchema,
  ShellRelayRequestSchema,
  ShellRelayResponseSchema,
  shellDataMessageMaxBytes,
  shellDataQueueMaxBytes,
} from "@opensteer/protocol";
import { runnerWebSocketTransport } from "@opensteer/runner-client";
import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import type { IncomingMessage } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import WebSocket, { type RawData } from "ws";
import { shellSentence } from "./shell-transport.js";

const maximumRelayLineBytes = 4 * 1024;
const relayLineTimeoutMs = 10_000;
const noRunSentence = "This Run's access to other computers has ended.";
const unlistedSentence =
  "That computer is not listed for this Run, so it cannot be addressed from it.";

/** One Run's hold on the relay. */
export interface ShellRelayBinding {
  /** Read at each connection, so a refreshed token is the one presented. */
  readonly credentials: { readonly agentControl: string };
  readonly runId: string;
  /** The computers the Run's note lists; any other target is refused here. */
  readonly targets: readonly string[];
}

/**
 * The Unix socket a launch directory's `ssh` reaches the Host through. It
 * lives as long as the engine that was started with that directory, which can
 * be longer than one Run, so it carries one Run's authority at a time: `bind`
 * lends it a Run, `suspend` takes the Run away and ends everything opened
 * under it, and `close` ends it for good. A connection belongs to the binding
 * it was accepted under and proceeds only while that binding still holds.
 */
export class ShellRelay {
  readonly #server: Server;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  readonly #webSockets = new Set<WebSocket>();
  readonly #transport: Pick<RunnerConfig, "controlCaPath" | "hostUrl" | "mode">;
  readonly #validationTarget: string | undefined;
  readonly #drainWaiters: (() => void)[] = [];
  #binding: ShellRelayBinding | undefined;
  /** Advances on every bind and suspend; a connection holds the one it was accepted at. */
  #generation = 0;
  #validationPending = true;
  #closed = false;

  constructor(options: {
    readonly socketPath: string;
    readonly transport: Pick<RunnerConfig, "controlCaPath" | "hostUrl" | "mode">;
    /** The setup probe's target, answered here once whether or not a Run holds the relay. */
    readonly validationTarget: string | undefined;
  }) {
    this.#socketPath = options.socketPath;
    this.#transport = options.transport;
    this.#validationTarget = options.validationTarget;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolveStart, reject) => {
      const onError = (error: Error) => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#socketPath, () => {
        this.#server.off("error", onError);
        resolveStart();
      });
    });
    await setPrivateFileMode(this.#socketPath, 0o600);
  }

  bind(binding: ShellRelayBinding): void {
    if (this.#closed) throw new Error("A closed shell relay cannot carry a Run");
    if (this.#binding) throw new Error("The shell relay already carries a Run");
    this.#binding = binding;
    this.#generation += 1;
  }

  /**
   * Takes the relay from its Run at once — nothing new proceeds, every
   * connection and Host handshake opened under it ends — and resolves once
   * all of them are gone.
   */
  suspend(): Promise<void> {
    this.#binding = undefined;
    this.#generation += 1;
    for (const socket of this.#sockets) socket.destroy();
    for (const webSocket of this.#webSockets) webSocket.terminate();
    return this.#drained();
  }

  async close(): Promise<void> {
    this.#closed = true;
    const drained = this.suspend();
    await new Promise<void>((resolveClose) => this.#server.close(() => resolveClose()));
    await drained;
  }

  /** Whether the setup probe's request line was answered on this socket. */
  get validationAnswered(): boolean {
    return !this.#validationPending;
  }

  #holder(generation: number): ShellRelayBinding | undefined {
    return !this.#closed && generation === this.#generation ? this.#binding : undefined;
  }

  #drained(): Promise<void> {
    if (this.#sockets.size === 0 && this.#webSockets.size === 0) return Promise.resolve();
    return new Promise((resolveDrain) => this.#drainWaiters.push(resolveDrain));
  }

  #settle(): void {
    if (this.#sockets.size > 0 || this.#webSockets.size > 0) return;
    for (const waiter of this.#drainWaiters.splice(0)) waiter();
  }

  #accept(socket: Socket): void {
    if (this.#closed) {
      socket.destroy();
      return;
    }
    const generation = this.#generation;
    this.#sockets.add(socket);
    socket.pause();
    socket.once("close", () => {
      this.#sockets.delete(socket);
      this.#settle();
    });
    socket.on("error", () => socket.destroy());
    void readRelayLine(socket)
      .then(({ request, remainder }) =>
        this.#connect(socket, generation, request.target, remainder),
      )
      .catch((error: unknown) =>
        refuse(
          socket,
          shellSentence(
            safeMessage(error, { fallback: "Invalid shell relay request" }),
            "Invalid shell relay request",
          ),
        ),
      );
    socket.resume();
  }

  async #connect(
    socket: Socket,
    generation: number,
    target: string,
    remainder: Buffer,
  ): Promise<void> {
    if (this.#validationPending && target === this.#validationTarget) {
      this.#validationPending = false;
      socket.end(relayResponseLine({ ok: true }));
      return;
    }
    const binding = this.#holder(generation);
    if (!binding) {
      refuse(socket, noRunSentence);
      return;
    }
    if (!binding.targets.includes(target)) {
      refuse(socket, unlistedSentence);
      return;
    }
    const transport = await runnerWebSocketTransport(
      {
        ...(this.#transport.controlCaPath ? { controlCaPath: this.#transport.controlCaPath } : {}),
        hostOrigin: this.#transport.hostUrl,
        mode: this.#transport.mode,
      },
      "/internal/v1/shell/connect",
    );
    // Reading the control CA yields; the Run may have let go meanwhile, and
    // the next one's token must never open a connection accepted under this one.
    if (this.#holder(generation) !== binding || socket.destroyed) {
      refuse(socket, noRunSentence);
      return;
    }
    transport.url.searchParams.set("target", target);
    let answered = false;
    let pumps: RelayPumpHandle[] = [];
    const stopPumps = () => {
      for (const pump of pumps) pump.stop();
      pumps = [];
    };
    const upstream = new WebSocket(transport.url, {
      ...(transport.ca ? { ca: transport.ca } : {}),
      followRedirects: false,
      headers: { authorization: `Bearer ${binding.credentials.agentControl}` },
      maxPayload: shellDataMessageMaxBytes,
      perMessageDeflate: false,
      rejectUnauthorized: true,
    });
    this.#webSockets.add(upstream);
    upstream.once("close", () => {
      stopPumps();
      this.#webSockets.delete(upstream);
      socket.destroy();
      this.#settle();
    });
    socket.once("close", () => {
      stopPumps();
      if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
    });
    upstream.once("unexpected-response", (_request, response) => {
      answered = true;
      void readRejectionMessage(response)
        .then((message) => refuse(socket, message))
        .finally(() => upstream.terminate());
    });
    upstream.once("error", (error) => {
      if (!answered && upstream.readyState !== WebSocket.OPEN) {
        answered = true;
        refuse(socket, shellSentence(error.message, "Host connection failed"));
      }
    });
    upstream.once("open", () => {
      answered = true;
      const callerToHost = pumpSocketToWebSocket(socket, upstream, remainder, () =>
        upstream.close(),
      );
      const hostToCaller = pumpWebSocketToSocket(upstream, socket, () => socket.destroy());
      pumps = [callerToHost, hostToCaller];
      socket.write(relayResponseLine({ ok: true }), (error) => {
        if (error) {
          stopPumps();
          upstream.terminate();
          return;
        }
        callerToHost.activate();
        hostToCaller.activate();
      });
    });
  }
}

function refuse(socket: Socket, message: string): void {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(relayResponseLine({ message, ok: false }));
}

async function readRelayLine(socket: Socket): Promise<{
  readonly remainder: Buffer;
  readonly request: ReturnType<typeof ShellRelayRequestSchema.parse>;
}> {
  return new Promise((resolveLine, reject) => {
    let pending = Buffer.alloc(0);
    const timer = setTimeout(
      () => finish(new Error("Shell relay request timed out")),
      relayLineTimeoutMs,
    );
    timer.unref();
    const onClose = () => finish(new Error("Shell relay client disconnected"));
    const onError = (error: Error) => finish(error);
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline === -1) {
        if (pending.byteLength > maximumRelayLineBytes)
          finish(new Error("Shell relay request exceeds 4 KiB"));
        return;
      }
      socket.pause();
      if (newline + 1 > maximumRelayLineBytes) {
        finish(new Error("Shell relay request exceeds 4 KiB"));
        return;
      }
      try {
        const request = ShellRelayRequestSchema.parse(
          JSON.parse(pending.subarray(0, newline).toString("utf8")),
        );
        finish(undefined, { remainder: pending.subarray(newline + 1), request });
      } catch {
        finish(new Error("Shell relay request is invalid"));
      }
    };
    function finish(
      error?: Error,
      result?: {
        readonly remainder: Buffer;
        readonly request: ReturnType<typeof ShellRelayRequestSchema.parse>;
      },
    ): void {
      clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("error", onError);
      socket.off("data", onData);
      if (error || !result) reject(error ?? new Error("Shell relay request failed"));
      else resolveLine(result);
    }
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.on("data", onData);
  });
}

function relayResponseLine(value: unknown): string {
  return `${JSON.stringify(ShellRelayResponseSchema.parse(value))}\n`;
}

interface RelayPumpHandle {
  activate(): void;
  stop(): void;
}

function pumpSocketToWebSocket(
  source: Socket,
  destination: WebSocket,
  initial: Buffer,
  failed: () => void,
): RelayPumpHandle {
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let sending = false;
  let active = false;
  let stopped = false;
  const enqueue = (raw: Buffer) => {
    if (stopped) return;
    for (let offset = 0; offset < raw.byteLength; offset += shellDataMessageMaxBytes) {
      const chunk = raw.subarray(offset, offset + shellDataMessageMaxBytes);
      if (queuedBytes + chunk.byteLength > shellDataQueueMaxBytes) {
        failed();
        return;
      }
      queue.push(chunk);
      queuedBytes += chunk.byteLength;
    }
    source.pause();
    if (active) drain();
  };
  const drain = () => {
    if (!active || stopped || sending) return;
    const chunk = queue.shift();
    if (!chunk) {
      source.resume();
      return;
    }
    sending = true;
    destination.send(chunk, { binary: true }, (error) => {
      if (stopped) return;
      sending = false;
      queuedBytes -= chunk.byteLength;
      if (error) failed();
      else drain();
    });
  };
  const onError = () => failed();
  const onEnd = () => destination.close();
  source.on("data", enqueue);
  source.once("error", onError);
  source.once("end", onEnd);
  if (initial.byteLength > 0) enqueue(initial);
  return {
    activate: () => {
      if (active || stopped) return;
      active = true;
      drain();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      source.off("data", enqueue);
      source.off("error", onError);
      source.off("end", onEnd);
      source.pause();
      queue.length = 0;
      queuedBytes = 0;
    },
  };
}

function pumpWebSocketToSocket(
  source: WebSocket,
  destination: Socket,
  failed: () => void,
): RelayPumpHandle {
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let writing = false;
  let active = false;
  let stopped = false;
  const drain = () => {
    if (!active || stopped || writing) return;
    const chunk = queue.shift();
    if (!chunk) {
      source.resume();
      return;
    }
    writing = true;
    destination.write(chunk, (error) => {
      if (stopped) return;
      writing = false;
      queuedBytes -= chunk.byteLength;
      if (error) failed();
      else drain();
    });
  };
  const onMessage = (raw: RawData, isBinary: boolean) => {
    if (stopped) return;
    if (!isBinary) {
      failed();
      return;
    }
    const chunk = rawDataBuffer(raw);
    if (
      chunk.byteLength > shellDataMessageMaxBytes ||
      queuedBytes + chunk.byteLength > shellDataQueueMaxBytes
    ) {
      failed();
      return;
    }
    queue.push(chunk);
    queuedBytes += chunk.byteLength;
    source.pause();
    if (active) drain();
  };
  source.on("message", onMessage);
  return {
    activate: () => {
      if (active || stopped) return;
      active = true;
      drain();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      source.off("message", onMessage);
      source.pause();
      queue.length = 0;
      queuedBytes = 0;
    },
  };
}

async function readRejectionMessage(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of response) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > 16 * 1024) return "The Host rejected the shell connection.";
    chunks.push(chunk);
  }
  try {
    return ShellConnectErrorSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).error
      .message;
  } catch {
    return "The Host rejected the shell connection.";
  }
}
