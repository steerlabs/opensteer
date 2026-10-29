import type { RunnerConfig } from "@opensteer/config";
import {
  HostToShellModuleMessageSchema,
  ShellAuditEventSchema,
  ShellCloseReasonSchema,
  ShellModuleToHostMessageSchema,
  shellAuditEventCap,
  shellDataMessageMaxBytes,
  shellDataQueueMaxBytes,
  type HostToShellModuleMessage,
  type ShellAuditEvent,
  type ShellCloseReason,
  type ShellSessionId,
} from "@opensteer/protocol";
import { runnerWebSocketTransport, type RunnerModuleStream } from "@opensteer/runner-client";
import { encodeLengthPrefixedJson } from "@opensteer/shared/lengthPrefixedJson";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { type Readable, type Writable } from "node:stream";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import type { RunnerLogger } from "../host/host-connection.js";
import { shellSentence, shellSocketCloseWaitMs } from "./shell-transport.js";

const maximumControlFrameBytes = 1024 * 1024;
const maximumLifecycleLineBytes = 8 * 1024;
const shellHelperCleanupWaitMs = 7_000;

const ShellLifecycleRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({
    channel: z.number().int().nonnegative().max(4_294_967_295),
    kind: z.literal("process.started"),
    processGroupId: z.number().int().positive().max(2_147_483_647),
  }),
  z.strictObject({
    channel: z.number().int().nonnegative().max(4_294_967_295),
    kind: z.literal("process.exited"),
    processGroupId: z.number().int().positive().max(2_147_483_647),
  }),
  z.strictObject({ kind: z.literal("session.end"), reason: ShellCloseReasonSchema }),
  z.strictObject({ count: z.number().int().positive(), kind: z.literal("audit.dropped") }),
]);

interface ShellChild {
  readonly process: ChildProcess;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly lifecycle: Readable;
}

type ShellOutboundReport =
  | { readonly sessionId: ShellSessionId; readonly type: "runner.shell.session.opened" }
  | {
      readonly error: { readonly code: string; readonly message: string };
      readonly sessionId: ShellSessionId;
      readonly type: "runner.shell.session.rejected";
    }
  | {
      readonly auditDropped?: number;
      readonly detail?: string;
      readonly reason: ShellCloseReason;
      readonly sessionId: ShellSessionId;
      readonly type: "runner.shell.session.closed";
    }
  | {
      readonly event: ShellAuditEvent;
      readonly sessionId: ShellSessionId;
      readonly type: "runner.shell.event";
    };

export interface ShellModuleHandlerOptions {
  readonly cleanupWaitMs?: number;
  readonly helperBinary: string;
  readonly hostKeyPath: string;
  /**
   * How long the helper waits for application-channel activity before it ends
   * the session itself. Production leaves it unset so the helper's own 30
   * minutes apply; an end-to-end test that has to observe an idle ending sets
   * a short one, which travels the helper's already-validated init field
   * rather than a second path into the same clock.
   */
  readonly idleTimeoutMs?: number;
  readonly logger: RunnerLogger;
  readonly resolveDataTransport?: typeof runnerWebSocketTransport;
  readonly transport: Pick<RunnerConfig, "controlCaPath" | "hostUrl" | "mode">;
}

export class ShellModuleHandler {
  readonly #options: ShellModuleHandlerOptions;
  readonly #sessions = new Map<ShellSessionId, ShellTargetSession>();
  #stream: RunnerModuleStream | undefined;

  constructor(options: ShellModuleHandlerOptions) {
    this.#options = options;
  }

  get maxPayloadBytes(): number {
    return maximumControlFrameBytes;
  }

  attach(stream: RunnerModuleStream): void {
    this.#stream = stream;
  }

  async detach(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    await Promise.allSettled(
      sessions.map((session) => session.close("machine-disconnected", "Shell module detached")),
    );
    this.#stream = undefined;
  }

  async handleFrame(frame: Buffer, isBinary: boolean): Promise<void> {
    if (isBinary) throw new Error("The shell control stream accepts JSON messages only");
    if (frame.byteLength > maximumControlFrameBytes) {
      throw new Error("Shell control message exceeds its size limit");
    }
    const message = HostToShellModuleMessageSchema.parse(JSON.parse(frame.toString("utf8")));
    switch (message.type) {
      case "host.shell.session.open":
        this.#open(message);
        return;
      case "host.shell.session.close":
        void this.#sessions.get(message.sessionId)?.close(message.reason);
        return;
      case "host.auxiliary.challenge":
      case "host.auxiliary.welcome":
      case "host.auxiliary.rejected":
      case "host.auxiliary.lease-renewed":
        throw new Error("The shell module received an out-of-sequence handshake message");
    }
  }

  #open(
    message: Extract<HostToShellModuleMessage, { readonly type: "host.shell.session.open" }>,
  ): void {
    if (this.#sessions.has(message.sessionId)) {
      void this.#send({
        error: { code: "duplicate-session", message: "This shell session is already open." },
        sessionId: message.sessionId,
        type: "runner.shell.session.rejected",
      });
      return;
    }
    const session = new ShellTargetSession({
      cleanupWaitMs: this.#options.cleanupWaitMs ?? shellHelperCleanupWaitMs,
      helperBinary: this.#options.helperBinary,
      hostKeyPath: this.#options.hostKeyPath,
      ...(this.#options.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: this.#options.idleTimeoutMs }),
      logger: this.#options.logger,
      message,
      onFinished: () => this.#sessions.delete(message.sessionId),
      ...(this.#options.resolveDataTransport
        ? { resolveDataTransport: this.#options.resolveDataTransport }
        : {}),
      send: (report) => this.#send(report),
      transport: this.#options.transport,
    });
    this.#sessions.set(message.sessionId, session);
    void session.start().catch(() => undefined);
  }

  async #send(report: ShellOutboundReport): Promise<void> {
    const stream = this.#stream;
    if (!stream) throw new Error("The shell module stream is detached");
    const message = ShellModuleToHostMessageSchema.parse({ ...stream.fence, ...report });
    await stream.send(JSON.stringify(message), false);
  }
}

interface ShellTargetSessionOptions {
  readonly cleanupWaitMs: number;
  readonly helperBinary: string;
  readonly hostKeyPath: string;
  readonly idleTimeoutMs?: number;
  readonly logger: RunnerLogger;
  readonly message: Extract<HostToShellModuleMessage, { readonly type: "host.shell.session.open" }>;
  readonly onFinished: () => void;
  readonly resolveDataTransport?: typeof runnerWebSocketTransport;
  readonly send: (report: ShellOutboundReport) => Promise<void>;
  readonly transport: Pick<RunnerConfig, "controlCaPath" | "hostUrl" | "mode">;
}

class ShellTargetSession {
  readonly #options: ShellTargetSessionOptions;
  readonly #auditQueue: ShellAuditEvent[] = [];
  readonly #processGroups = new Set<number>();
  readonly #setupAbort = new AbortController();
  readonly #pumps: PumpHandle[] = [];
  #auditDropped = 0;
  #auditDraining: Promise<void> | undefined;
  #child: ShellChild | undefined;
  #closing: Promise<void> | undefined;
  #dataSocket: WebSocket | undefined;
  #lifecycleDrained: Promise<void> = Promise.resolve();
  #lifecycleLossRecorded = false;
  #opened = false;
  #ready = false;
  #setup: Promise<void> | undefined;

  constructor(options: ShellTargetSessionOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#setup) return this.#setup;
    this.#setup = this.#start();
    return this.#setup;
  }

  async #start(): Promise<void> {
    try {
      this.#setupAbort.signal.throwIfAborted();
      const child = spawnShellHelper(this.#options.helperBinary);
      this.#child = child;
      child.stdin.on("error", (error) => {
        if (!this.#closing) {
          void this.close(
            "protocol-error",
            safeMessage(error, { fallback: "Shell helper input failed" }),
          );
        }
      });
      this.#drainDiagnostics(child.stderr);
      this.#lifecycleDrained = this.#drainLifecycle(child.lifecycle);
      child.process.once("exit", () => void this.#handleProcessExit());
      child.process.once("error", (error) => {
        if (!this.#closing) void this.#reject(error);
      });
      await writeInitFrame(
        child.stdin,
        {
          authority: this.#options.message.authority,
          hostKeyPath: this.#options.hostKeyPath,
          machineName: this.#options.message.machineName,
          ...(this.#options.idleTimeoutMs === undefined
            ? {}
            : { idleTimeoutMs: this.#options.idleTimeoutMs }),
          policy: this.#options.message.policy,
        },
        this.#setupAbort.signal,
      );
      this.#setupAbort.signal.throwIfAborted();
      await this.#openDataSocket(this.#setupAbort.signal);
      this.#setupAbort.signal.throwIfAborted();
    } catch (error) {
      if (this.#setupAbort.signal.aborted) return;
      await this.#reject(error);
    }
  }

  async close(reason: ShellCloseReason, detail?: string): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#setupAbort.abort(new Error(`Shell session closing: ${reason}`));
    this.#closing = this.#cleanup(reason, detail);
    return this.#closing;
  }

  async #reject(error: unknown): Promise<void> {
    if (this.#closing) return this.#closing;
    const message = shellSentence(
      safeMessage(error, { fallback: "Shell session setup failed" }),
      "Shell session setup failed",
    );
    await this.#options
      .send({
        error: { code: "open-failed", message: message.slice(0, 512) },
        sessionId: this.#options.message.sessionId,
        type: "runner.shell.session.rejected",
      })
      .catch(() => undefined);
    if (!this.#closing) void this.close("open-failed", message);
  }

  async #openDataSocket(signal: AbortSignal): Promise<void> {
    const transport = await abortable(
      (this.#options.resolveDataTransport ?? runnerWebSocketTransport)(
        {
          ...(this.#options.transport.controlCaPath
            ? { controlCaPath: this.#options.transport.controlCaPath }
            : {}),
          hostOrigin: this.#options.transport.hostUrl,
          mode: this.#options.transport.mode,
        },
        "/internal/v1/shell/data",
      ),
      signal,
    );
    signal.throwIfAborted();
    const socket = new WebSocket(transport.url, {
      ...(transport.ca ? { ca: transport.ca } : {}),
      followRedirects: false,
      headers: { authorization: `Bearer ${this.#options.message.dataTicket}` },
      maxPayload: shellDataMessageMaxBytes,
      perMessageDeflate: false,
      rejectUnauthorized: true,
    });
    this.#dataSocket = socket;
    if (signal.aborted || this.#closing) {
      socket.terminate();
      signal.throwIfAborted();
      return;
    }
    socket.once("open", () => {
      if (this.#closing || signal.aborted) {
        socket.terminate();
        return;
      }
      this.#attachPumps(socket);
      void this.#maybeOpened();
    });
    socket.once("error", (error) => {
      if (!this.#closing) void this.#reject(error);
    });
    socket.once("close", () => {
      if (!this.#closing) {
        void this.#finishAfterLifecycle();
      }
    });
  }

  #attachPumps(socket: WebSocket): void {
    const child = this.#child;
    if (!child) return;
    this.#pumps.push(
      pumpWebSocketToWritable(socket, child.stdin, (error) => {
        if (!this.#closing) {
          void this.close(
            "protocol-error",
            safeMessage(error, { fallback: "Shell input pump failed" }),
          );
        }
      }),
      pumpReadableToWebSocket(child.stdout, socket, (error) => {
        if (!this.#closing) {
          void this.close(
            "protocol-error",
            safeMessage(error, { fallback: "Shell output pump failed" }),
          );
        }
      }),
    );
  }

  #drainDiagnostics(stderr: Readable): void {
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) {
        this.#options.logger.error("Shell helper diagnostic", {
          detail: message.slice(0, 1_000),
          sessionId: this.#options.message.sessionId,
        });
      }
    });
  }

  #drainLifecycle(stream: Readable): Promise<void> {
    let pending = Buffer.alloc(0);
    let resolveDrained: () => void = () => undefined;
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveDrained();
    };
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.byteLength > maximumLifecycleLineBytes && !pending.includes(0x0a)) {
        void this.close("protocol-error", "Shell helper lifecycle line exceeded 8 KiB");
        return;
      }
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline === -1) return;
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (line.byteLength > maximumLifecycleLineBytes) {
          void this.close("protocol-error", "Shell helper lifecycle line exceeded 8 KiB");
          return;
        }
        this.#handleLifecycleLine(line);
      }
    });
    stream.once("end", () => {
      if (pending.byteLength > 0) {
        this.#recordLifecycleLoss();
        if (!this.#closing) {
          void this.close("protocol-error", "Shell helper ended with an incomplete lifecycle line");
        }
      }
      settle();
    });
    stream.once("error", () => {
      this.#recordLifecycleLoss();
      settle();
    });
    return drained;
  }

  #recordLifecycleLoss(): void {
    if (this.#lifecycleLossRecorded) return;
    this.#lifecycleLossRecorded = true;
    this.#auditDropped += 1;
  }

  async #handleProcessExit(): Promise<void> {
    await this.#finishAfterLifecycle();
  }

  async #finishAfterLifecycle(): Promise<void> {
    this.#child?.stdin.end();
    const lifecycleComplete = await lifecycleWithin(
      this.#lifecycleDrained,
      this.#options.cleanupWaitMs,
    );
    if (!lifecycleComplete) {
      this.#recordLifecycleLoss();
      this.#child?.lifecycle.destroy();
    }
    if (this.#closing) return;
    if (this.#opened) await this.close("target-closed");
    else await this.#reject(new Error("Shell helper ended before the session opened"));
  }

  #handleLifecycleLine(line: Buffer): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line.toString("utf8"));
    } catch {
      void this.close("protocol-error", "Shell helper emitted invalid lifecycle JSON");
      return;
    }
    const lifecycle = ShellLifecycleRecordSchema.safeParse(decoded);
    if (lifecycle.success) {
      switch (lifecycle.data.kind) {
        case "ready":
          this.#ready = true;
          void this.#maybeOpened();
          return;
        case "process.started":
          this.#processGroups.add(lifecycle.data.processGroupId);
          return;
        case "process.exited":
          this.#processGroups.delete(lifecycle.data.processGroupId);
          return;
        case "session.end":
          void this.close(lifecycle.data.reason);
          return;
        case "audit.dropped":
          this.#auditDropped += lifecycle.data.count;
          return;
      }
    }
    const audit = ShellAuditEventSchema.safeParse(decoded);
    if (!audit.success || audit.data.kind === "truncated") {
      void this.close("protocol-error", "Shell helper emitted an invalid audit record");
      return;
    }
    this.#enqueueAudit(audit.data);
  }

  async #maybeOpened(): Promise<void> {
    const socket = this.#dataSocket;
    if (this.#opened || this.#closing || !this.#ready || socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.#opened = true;
    try {
      await this.#options.send({
        sessionId: this.#options.message.sessionId,
        type: "runner.shell.session.opened",
      });
    } catch (error) {
      await this.close(
        "machine-disconnected",
        safeMessage(error, { fallback: "Shell control stream closed during activation" }),
      );
    }
  }

  #enqueueAudit(event: ShellAuditEvent): void {
    if (this.#auditQueue.length >= shellAuditEventCap) {
      this.#auditDropped += 1;
      return;
    }
    this.#auditQueue.push(event);
    void this.#startAuditDrain();
  }

  #startAuditDrain(): Promise<void> {
    if (this.#auditDraining) return this.#auditDraining;
    const draining = this.#drainAudit().finally(() => {
      if (this.#auditDraining === draining) this.#auditDraining = undefined;
    });
    this.#auditDraining = draining;
    return draining;
  }

  async #drainAudit(): Promise<void> {
    for (;;) {
      const event = this.#auditQueue.shift();
      if (!event) return;
      try {
        await this.#options.send({
          event,
          sessionId: this.#options.message.sessionId,
          type: "runner.shell.event",
        });
      } catch {
        this.#auditDropped += 1 + this.#auditQueue.length;
        this.#auditQueue.length = 0;
        return;
      }
    }
  }

  async #cleanup(reason: ShellCloseReason, detail?: string): Promise<void> {
    await this.#setup?.catch(() => undefined);
    const child = this.#child;
    const socket = this.#dataSocket;
    for (const pump of this.#pumps.splice(0)) pump.stop();
    stopWebSocket(socket, reason);
    const forceSocketClosed = socket
      ? setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        }, shellSocketCloseWaitMs)
      : undefined;
    forceSocketClosed?.unref();
    child?.stdout.pause();
    child?.stdin.end();

    if (child && child.process.exitCode === null && child.process.signalCode === null) {
      const exited = once(child.process, "exit").then(() => true);
      const graceful = await Promise.race([
        exited,
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), this.#options.cleanupWaitMs);
          timer.unref();
        }),
      ]);
      if (!graceful) {
        for (const processGroupId of this.#processGroups) killProcessGroup(processGroupId);
        child.process.kill("SIGKILL");
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, shellSocketCloseWaitMs);
            timer.unref();
          }),
        ]);
      }
    }
    for (const processGroupId of this.#processGroups) killProcessGroup(processGroupId);
    this.#processGroups.clear();
    const lifecycleComplete = await lifecycleWithin(
      this.#lifecycleDrained,
      this.#options.cleanupWaitMs,
    );
    if (!lifecycleComplete) {
      this.#recordLifecycleLoss();
      child?.lifecycle.destroy();
    }
    await this.#startAuditDrain();
    if (forceSocketClosed) clearTimeout(forceSocketClosed);
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();

    if (this.#auditDropped > 0) {
      this.#options.logger.error("Shell audit records were dropped", {
        count: this.#auditDropped,
        sessionId: this.#options.message.sessionId,
      });
    }
    await this.#options
      .send({
        ...(this.#auditDropped > 0 ? { auditDropped: this.#auditDropped } : {}),
        ...(detail ? { detail: detail.slice(0, 512) } : {}),
        reason,
        sessionId: this.#options.message.sessionId,
        type: "runner.shell.session.closed",
      })
      .catch(() => undefined);
    this.#options.onFinished();
  }
}

function spawnShellHelper(binary: string): ShellChild {
  const child = spawn(binary, ["shell-serve"], {
    env: shellHelperEnvironment(process.env),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  const lifecycle = child.stdio[3];
  if (!stdin || !stdout || !stderr || !lifecycle || typeof lifecycle === "number") {
    child.kill("SIGKILL");
    throw new Error("The shell helper did not expose its required pipes");
  }
  return { lifecycle: lifecycle as Readable, process: child, stderr, stdin, stdout };
}

async function lifecycleWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return withTimeout(promise, timeoutMs, {
    timeoutError: () => new Error("Shell helper lifecycle pipe did not close"),
  }).then(
    () => true,
    () => false,
  );
}

export function shellHelperEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && !name.startsWith("OPENSTEER_")) output[name] = value;
  }
  return output;
}

export async function writeInitFrame(
  stdin: Writable,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> {
  await writeChunk(stdin, encodeLengthPrefixedJson(value, shellDataMessageMaxBytes), signal);
}

function writeChunk(destination: Writable, chunk: Buffer, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("Shell helper initialization was aborted"));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      destination.write(chunk, (error) => finish(error ?? undefined));
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Shell helper initialization failed"));
    }
  });
}

export interface PumpHandle {
  stop(): void;
}

export function pumpWebSocketToWritable(
  source: WebSocket,
  destination: Writable,
  failed: (error: Error) => void,
): PumpHandle {
  let queuedBytes = 0;
  let waitingForDrain = false;
  let writing = false;
  let stopped = false;
  const queue: Buffer[] = [];
  const onDrain = () => {
    waitingForDrain = false;
    drain();
  };
  const waitForDrain = () => {
    source.pause();
    if (!waitingForDrain) {
      waitingForDrain = true;
      destination.once("drain", onDrain);
    }
  };
  const drain = () => {
    if (stopped || writing) return;
    if (destination.writableNeedDrain) {
      waitForDrain();
      return;
    }
    const chunk = queue.shift();
    if (!chunk) {
      if (!destination.writableNeedDrain) source.resume();
      return;
    }
    writing = true;
    try {
      const acceptsMore = destination.write(chunk, (error) => {
        if (stopped) return;
        writing = false;
        queuedBytes -= chunk.byteLength;
        if (error) failed(error);
        else drain();
      });
      if (!acceptsMore || destination.writableNeedDrain) waitForDrain();
    } catch (error) {
      writing = false;
      failed(error instanceof Error ? error : new Error("Shell input pump failed"));
    }
  };
  const onMessage = (raw: RawData, isBinary: boolean) => {
    if (stopped) return;
    if (!isBinary) {
      failed(new Error("Shell data sockets accept binary messages only"));
      return;
    }
    const chunk = rawDataBuffer(raw);
    if (
      chunk.byteLength > shellDataMessageMaxBytes ||
      queuedBytes + chunk.byteLength > shellDataQueueMaxBytes
    ) {
      failed(new Error("Shell input exceeded its bounded queue"));
      return;
    }
    queue.push(chunk);
    queuedBytes += chunk.byteLength;
    if (queuedBytes >= shellDataQueueMaxBytes || destination.writableNeedDrain) source.pause();
    drain();
  };
  source.on("message", onMessage);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      source.off("message", onMessage);
      destination.off("drain", onDrain);
      source.pause();
      queue.length = 0;
      queuedBytes = 0;
    },
  };
}

interface WebSocketBinaryDestination {
  send(data: Buffer, options: { readonly binary: true }, callback: (error?: Error) => void): void;
}

export function pumpReadableToWebSocket(
  source: Readable,
  destination: WebSocketBinaryDestination,
  failed: (error: Error) => void,
): PumpHandle {
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let sending = false;
  let stopped = false;
  const drain = () => {
    if (stopped || sending) return;
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
      if (error) failed(error);
      else drain();
    });
  };
  const onData = (raw: Buffer) => {
    if (stopped) return;
    for (let offset = 0; offset < raw.byteLength; offset += shellDataMessageMaxBytes) {
      const chunk = raw.subarray(offset, offset + shellDataMessageMaxBytes);
      if (queuedBytes + chunk.byteLength > shellDataQueueMaxBytes) {
        failed(new Error("Shell output exceeded its bounded queue"));
        return;
      }
      queue.push(chunk);
      queuedBytes += chunk.byteLength;
    }
    source.pause();
    drain();
  };
  const onError = (error: Error) => {
    if (!stopped) failed(error);
  };
  source.on("data", onData);
  source.on("error", onError);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      source.off("data", onData);
      source.off("error", onError);
      source.pause();
      queue.length = 0;
      queuedBytes = 0;
    },
  };
}

function stopWebSocket(socket: WebSocket | undefined, reason: ShellCloseReason): void {
  if (!socket) return;
  if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  else if (socket.readyState === WebSocket.OPEN) socket.close(1000, reason);
}

function killProcessGroup(processGroupId: number): void {
  if (process.platform === "win32") return;
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch {
    // The helper may have reaped the group between its last lifecycle record and cleanup.
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(signal.reason ?? new Error("Shell session setup was aborted"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void operation.then((value) => finish(undefined, value), finish);
  });
}
