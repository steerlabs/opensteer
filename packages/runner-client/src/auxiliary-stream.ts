import {
  RunnerAuxiliaryWelcomeSchema,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryModule,
  type RunnerBootId,
} from "@opensteer/protocol";
import type { RunnerId } from "@opensteer/core";
import type { RuntimeMode } from "@opensteer/core";
import type { KeyObject } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { answerAuxiliaryChallenge, RunnerAuxiliaryFenceLedger } from "./auxiliary-connection.js";
import {
  FencedInboundDispatcher,
  parseInboundAuxiliaryFrame,
  type InboundAuxiliaryFrame,
} from "./fenced-dispatch.js";
import type { RunnerModuleStream } from "./module-connection.js";
import { runnerWebSocketTransport } from "./transport.js";

const handshakeTimeoutMs = 15_000;
const transportCloseWaitMs = 1_000;

export interface OpenedAuxiliaryStream {
  readonly closed: Promise<void>;
  readonly stream: RunnerModuleStream;
  close(code?: number, reason?: string): void;
  heartbeat(): Promise<void>;
}

/**
 * Opens one module stream beside an already-authenticated primary connection.
 *
 * The ticket came from that primary connection and names it; this proves the
 * Runner key over the Host's fresh challenge so the ticket alone is never
 * enough. Everything after the welcome is the module's own protocol.
 */
export async function openRunnerAuxiliaryStream(options: {
  readonly bootId: RunnerBootId;
  readonly controlCaPath?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly hostOrigin: URL;
  readonly maxPayloadBytes?: number;
  readonly module: RunnerAuxiliaryModule;
  readonly mode: RuntimeMode;
  readonly onFrame: (frame: Buffer, isBinary: boolean) => Promise<void>;
  readonly onInvalidated?: (reason: Error) => Promise<void> | void;
  readonly privateKey: KeyObject;
  readonly runnerId: RunnerId;
  readonly signal: AbortSignal;
  readonly ticket: string;
}): Promise<OpenedAuxiliaryStream> {
  const transport = await runnerWebSocketTransport(
    {
      ...(options.controlCaPath ? { controlCaPath: options.controlCaPath } : {}),
      hostOrigin: options.hostOrigin,
      mode: options.mode,
    },
    `/internal/v1/runners/auxiliary/${options.module}`,
  );
  const socket = new WebSocket(transport.url, {
    ...(transport.ca ? { ca: transport.ca } : {}),
    followRedirects: false,
    ...(options.headers ? { headers: { ...options.headers } } : {}),
    ...(options.maxPayloadBytes ? { maxPayload: options.maxPayloadBytes } : {}),
    perMessageDeflate: false,
    rejectUnauthorized: true,
  });
  // Closing a CONNECTING socket emits an error asynchronously, after abort has
  // removed the temporary handshake listeners. Keep an owner for that event;
  // operation listeners still reject their promises on transport failures.
  socket.on("error", () => undefined);
  // The Host speaks first, and its challenge can arrive in the same read as the
  // upgrade response: ws emits it before an `await` on "open" resumes, so the
  // listener is in place before the socket opens.
  const challengeFrame = nextFrame(socket, options.signal, "Host did not challenge the stream");
  challengeFrame.catch(() => undefined);
  await waitForOpen(socket, options.signal);
  const fence = new RunnerAuxiliaryFenceLedger();
  const challenge = await challengeFrame;
  const proof = answerAuxiliaryChallenge(
    {
      bootId: options.bootId,
      module: options.module,
      privateKey: options.privateKey,
      runnerId: options.runnerId,
      ticket: options.ticket,
    },
    parseJson(challenge),
  );
  await send(socket, JSON.stringify(proof), false);
  const welcomeFrame = await nextFrame(socket, options.signal, "Host did not welcome the stream");
  const parsed = parseJson(welcomeFrame);
  const rejection = parsed as { readonly type?: unknown; readonly error?: { message?: string } };
  if (rejection.type === "host.auxiliary.rejected") {
    socket.close(4003, "module stream refused");
    throw new Error(
      `Host refused the ${options.module} stream: ${rejection.error?.message ?? "unknown"}`,
    );
  }
  const welcome = RunnerAuxiliaryWelcomeSchema.parse(parsed);
  fence.adopt(welcome);
  let terminateTimer: NodeJS.Timeout | undefined;
  const dispatcher = new FencedInboundDispatcher({
    accepts: (frameFence: RunnerAuxiliaryFrameFence) => fence.accepts(frameFence),
    fence: (frame: InboundAuxiliaryFrame) => frame.fence,
    handle: async (frame: InboundAuxiliaryFrame) => {
      if (frame.renewal) {
        fence.renew(frame.renewal.streamLeaseExpiresAt);
        return;
      }
      await options.onFrame(frame.frame, false);
    },
  });
  let invalidation: Promise<void> | undefined;
  const invalidate = (reason: Error): Promise<void> => {
    if (invalidation) return invalidation;
    let moduleCleanup: Promise<void>;
    try {
      moduleCleanup = Promise.resolve(options.onInvalidated?.(reason));
    } catch (error) {
      moduleCleanup = Promise.reject(error);
    }
    invalidation = Promise.allSettled([dispatcher.abortAndDrain(reason), moduleCleanup]).then(
      () => undefined,
    );
    return invalidation;
  };
  const closeTransport = (code: number, reason: string): void => {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    if (socket.readyState !== WebSocket.CLOSED && !terminateTimer) {
      terminateTimer = setTimeout(() => socket.terminate(), transportCloseWaitMs);
      terminateTimer.unref();
    }
  };
  // A lease that runs out is this stream ending, not an error a caller has to
  // catch: the ledger that owns the lease says so once, here, and the stream
  // tears down exactly as it would for any other close. Whoever supervises
  // this stream reopens it when the peer comes back.
  fence.onLeaseExpired((reason) => {
    void invalidate(reason);
    closeTransport(4000, "module stream lease expired");
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      fence.release();
      if (terminateTimer) clearTimeout(terminateTimer);
      void invalidate(new Error("Runner auxiliary stream closed")).then(() => resolve());
    });
  });
  socket.on("message", (raw, isBinary) => {
    try {
      const frame = parseInboundAuxiliaryFrame(rawBuffer(raw), isBinary);
      void dispatcher.dispatch(frame).catch(() => {
        const reason = new Error("Runner auxiliary module frame failed");
        void invalidate(reason);
        closeTransport(1011, "module frame failed");
      });
    } catch {
      const reason = new Error("Runner auxiliary module frame was invalid");
      void invalidate(reason);
      closeTransport(1008, "invalid module frame");
    }
  });
  const stream: RunnerModuleStream = {
    ...(welcome.loginText === 1 ? { loginText: 1 } : {}),
    ...(welcome.passwordSignIn === 1 ? { passwordSignIn: 1 } : {}),
    ...(welcome.passkeys === 1 ? { passkeys: 1 } : {}),
    browserAttachPublicKeys: welcome.browserAttachPublicKeys,
    fence: fence.fence,
    send: (frame, binary) => send(socket, frame, binary),
  };
  return {
    close: (code = 1000, reason = "module stream closed") => {
      void invalidate(new Error(reason));
      closeTransport(code, reason);
    },
    closed,
    // Async on purpose: stamping the fence is part of the operation, so a
    // stream whose lease has run out rejects here like any other closed
    // stream. A synchronous throw would escape the caller's heartbeat timer.
    heartbeat: async () => {
      await send(
        socket,
        JSON.stringify({
          ...fence.fence,
          sentAt: fence.heartbeatTimestamp(),
          type: "runner.auxiliary.heartbeat",
        }),
        false,
      );
    },
    stream,
  };
}

function rawBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}

function parseJson(frame: Buffer): unknown {
  try {
    return JSON.parse(frame.toString("utf8"));
  } catch (error) {
    throw new Error("The Host module frame is not valid JSON", { cause: error });
  }
}

function send(socket: WebSocket, frame: Buffer | string, binary: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("The module stream is closed"));
      return;
    }
    socket.send(frame, { binary }, (error) => (error ? reject(error) : resolve()));
  });
}

async function waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      socket.close();
      finish(new Error("The module stream was aborted"));
    };
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      socket.off("open", onOpen);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    signal.addEventListener("abort", abort, { once: true });
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

async function nextFrame(
  socket: WebSocket,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), handshakeTimeoutMs);
    timer.unref();
    const abort = () => finish(new Error("The module stream was aborted"));
    const onMessage = (raw: RawData) => finish(undefined, rawBuffer(raw));
    const onClose = () => finish(new Error("The module stream closed during its handshake"));
    const onError = (error: unknown) =>
      finish(error instanceof Error ? error : new Error("The module stream failed"));
    function finish(error?: Error, frame?: Buffer): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error || !frame) reject(error ?? new Error(timeoutMessage));
      else resolve(frame);
    }
    signal.addEventListener("abort", abort, { once: true });
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}
