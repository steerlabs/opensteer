import type { RuntimeMode } from "@opensteer/core";
import {
  HostToRunnerMessageSchema,
  RunnerAuxiliaryRequestIdSchema,
  RunnerAuxiliaryWelcomeSchema,
  type HostToRunnerMessage,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryModule,
  type RunnerBootId,
  type RunnerConnectionFence,
  type RunnerDescriptor,
  type RunnerModuleReadinessReport,
} from "@opensteer/protocol";
import { delay } from "@opensteer/shared/delay";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { answerAuxiliaryChallenge, RunnerAuxiliaryFenceLedger } from "./auxiliary-connection.js";
import { RunnerConnectionFenceLedger } from "./fence-ledger.js";
import {
  FencedInboundDispatcher,
  parseInboundAuxiliaryFrame,
  type InboundAuxiliaryFrame,
} from "./fenced-dispatch.js";
import type { FileRunnerIdentityStore, RunnerIdentity } from "./identity.js";
import { runnerEnrollmentCredential, runnerIdentityProof } from "./proof.js";
import { runnerWebSocketTransport } from "./transport.js";

const handshakeTimeoutMs = 15_000;
const maximumReconnectDelayMs = 30_000;

type PostAuthenticationHostMessage = Exclude<
  HostToRunnerMessage,
  { readonly type: "host.challenge" | "host.error" }
>;

export interface RunnerModuleLogger {
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface RunnerModuleStream {
  readonly browserWireVersion?: 1;
  readonly passkeys?: 1;
  readonly loginText?: 1;
  readonly passwordSignIn?: 1;
  readonly fence: RunnerAuxiliaryFrameFence;
  /** Present on a browser stream so the relay can verify attach tickets. */
  readonly browserAttachPublicKeys:
    readonly { readonly keyId: string; readonly publicKeyPem: string }[] | undefined;
  send(frame: Buffer | string, binary: boolean): Promise<void>;
}

export interface RunnerModuleConnectionOptions {
  readonly bootId: RunnerBootId;
  readonly controlCaPath?: string | undefined;
  readonly descriptor: (identity: RunnerIdentity) => RunnerDescriptor;
  readonly enrollmentToken?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly hostOrigin: URL;
  readonly identity: RunnerIdentity;
  readonly identityStore: Pick<FileRunnerIdentityStore, "acceptHostConnection">;
  readonly logger: RunnerModuleLogger;
  readonly module: RunnerAuxiliaryModule;
  readonly mode: RuntimeMode;
  /** Called once the module's own stream is open and fenced. */
  readonly onStream: (stream: RunnerModuleStream) => Promise<void> | void;
  readonly onStreamFrame: (frame: Buffer, isBinary: boolean, signal: AbortSignal) => Promise<void>;
  readonly onStreamClosed?: () => Promise<void> | void;
  readonly readiness: () => RunnerModuleReadinessReport;
}

/**
 * A Runner whose whole job is one module.
 *
 * It still holds a primary connection, because that is where the machine's
 * identity lives: the module stream beside it is authorized by a ticket that
 * primary connection asked for, and dies with it. The browser and messaging
 * runtimes differ only in what travels on the module stream, so everything up
 * to that point lives here once.
 */
export class RunnerModuleConnection {
  readonly #options: RunnerModuleConnectionOptions;
  readonly #primaryFence = new RunnerConnectionFenceLedger();
  readonly #auxiliaryFence = new RunnerAuxiliaryFenceLedger();
  #identity: RunnerIdentity;
  #enrolled: boolean;

  constructor(options: RunnerModuleConnectionOptions) {
    this.#options = options;
    this.#identity = options.identity;
    this.#enrolled = options.identity.lastConnectionGeneration > 0;
  }

  get identity(): RunnerIdentity {
    return this.#identity;
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.#connectOnce(signal);
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        this.#options.logger.error("Runner module connection closed", {
          module: this.#options.module,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (signal.aborted) break;
      const backoff = Math.min(maximumReconnectDelayMs, 500 * 2 ** Math.min(failures, 6));
      await delay(backoff, signal).catch(() => undefined);
    }
  }

  async #connectOnce(signal: AbortSignal): Promise<void> {
    const { firstFrame: challenge, socket: primary } = await this.#openSocket(
      "/internal/v1/runners",
      signal,
      "Host did not issue a Runner challenge",
    );
    try {
      const welcome = await this.#authenticate(primary, challenge, signal);
      const ticket = await this.#requestTicket(primary, signal);
      const { firstFrame: streamChallenge, socket: auxiliary } = await this.#openSocket(
        `/internal/v1/runners/auxiliary/${this.#options.module}`,
        signal,
        "Host did not challenge the stream",
      );
      try {
        await this.#openStream(auxiliary, streamChallenge, ticket, signal);
        await this.#pump(primary, auxiliary, welcome.heartbeatIntervalMs, signal);
      } finally {
        await this.#options.onStreamClosed?.();
        auxiliary.close(1000, "module stream closed");
      }
    } finally {
      primary.close(1000, "runner connection closed");
    }
  }

  /**
   * The Host speaks first on every socket, and its first frame can arrive in
   * the same read as the upgrade response: ws emits it before an `await` on
   * "open" resumes. So the first frame is awaited from the moment the socket
   * exists.
   */
  async #openSocket(
    path: string,
    signal: AbortSignal,
    firstFrameTimeoutMessage: string,
  ): Promise<{
    readonly firstFrame: Promise<{ readonly frame: Buffer }>;
    readonly socket: WebSocket;
  }> {
    const transport = await runnerWebSocketTransport(
      {
        ...(this.#options.controlCaPath ? { controlCaPath: this.#options.controlCaPath } : {}),
        hostOrigin: this.#options.hostOrigin,
        mode: this.#options.mode,
      },
      path,
    );
    const socket = new WebSocket(transport.url, {
      ...(transport.ca ? { ca: transport.ca } : {}),
      followRedirects: false,
      headers: this.#options.headers,
      perMessageDeflate: false,
      rejectUnauthorized: true,
    });
    const firstFrame = nextFrame(socket, signal, firstFrameTimeoutMessage);
    firstFrame.catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) =>
        reject(error instanceof Error ? error : new Error("Runner socket failed"));
      const abort = () => {
        socket.close();
        fail(new Error("Runner connection aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
      socket.once("error", (error) => {
        signal.removeEventListener("abort", abort);
        fail(error);
      });
    });
    return { firstFrame, socket };
  }

  async #authenticate(
    socket: WebSocket,
    challengeFrameReceived: Promise<{ readonly frame: Buffer }>,
    signal: AbortSignal,
  ) {
    const challengeFrame = await challengeFrameReceived;
    const challenge = HostToRunnerMessageSchema.parse(parseJson(challengeFrame.frame));
    if (challenge.type !== "host.challenge") {
      throw new Error("Host did not start the Runner authentication handshake");
    }
    const descriptor = this.#options.descriptor(this.#identity);
    const proof = runnerIdentityProof({
      challenge,
      credential: runnerEnrollmentCredential(this.#options.enrollmentToken),
      descriptor,
      enrolled: this.#enrolled,
      privateKey: this.#identity.privateKey,
      publicKeyPem: this.#identity.publicKeyPem,
    });
    await send(socket, JSON.stringify(proof));
    const welcomeFrame = await nextFrame(socket, signal, "Host did not acknowledge the proof");
    const welcome = HostToRunnerMessageSchema.parse(parseJson(welcomeFrame.frame));
    if (welcome.type === "host.error") {
      throw new Error(`Host rejected Runner authentication: ${welcome.error.message}`);
    }
    if (welcome.type !== "host.welcome") {
      throw new Error("Host sent an invalid Runner authentication response");
    }
    if (!welcome.allowedModules.includes(this.#options.module)) {
      throw new Error(`This Runner's enrollment does not allow the ${this.#options.module} module`);
    }
    this.#primaryFence.adopt(
      {
        bootId: welcome.bootId,
        connectionGeneration: welcome.connectionGeneration,
        connectionId: welcome.connectionId,
        connectionLeaseId: welcome.connectionLeaseId,
        runnerId: welcome.runnerId,
      },
      welcome.connectionLeaseExpiresAt,
    );
    this.#identity = await this.#options.identityStore.acceptHostConnection({
      connectionGeneration: welcome.connectionGeneration,
      environmentIds: welcome.environmentIds,
      reenrolled: proof.type === "runner.enroll",
      runnerId: welcome.runnerId,
    });
    this.#enrolled = true;
    await send(
      socket,
      JSON.stringify({
        ...this.#primaryFence.fence,
        modules: [this.#options.readiness()],
        type: "runner.modules.report",
      }),
    );
    this.#options.logger.info("Runner connected to Host", {
      module: this.#options.module,
      runnerId: this.#identity.runnerId,
    });
    return welcome;
  }

  async #requestTicket(socket: WebSocket, signal: AbortSignal): Promise<string> {
    const requestId = RunnerAuxiliaryRequestIdSchema.parse(`aux:${randomUUID()}`);
    await send(
      socket,
      JSON.stringify({
        ...this.#primaryFence.fence,
        module: this.#options.module,
        requestId,
        type: "runner.auxiliary.ticket-request",
      }),
    );
    for (;;) {
      const next = await nextFrame(socket, signal, "Host did not issue an auxiliary ticket");
      const message = HostToRunnerMessageSchema.parse(parseJson(next.frame));
      if (message.type === "host.error") {
        throw new Error(`Host refused the auxiliary ticket: ${message.error.message}`);
      }
      if (message.type === "host.challenge") {
        throw new Error("Host repeated the Runner authentication handshake");
      }
      if (!this.#primaryFence.accepts(modulePrimaryMessageFence(message))) {
        throw new Error("Host frame carried a stale connection fence");
      }
      if (message.type === "host.connection.lease-renewed") {
        this.#primaryFence.renew(message.connectionLeaseExpiresAt);
        continue;
      }
      if (message.type !== "host.auxiliary.ticket") {
        throw new Error("Host sent an unexpected message while issuing an auxiliary ticket");
      }
      if (message.requestId !== requestId || message.module !== this.#options.module) {
        throw new Error("Host answered a different auxiliary ticket request");
      }
      if (!this.#primaryFence.accepts(message)) {
        throw new Error("Host auxiliary ticket carried a stale connection fence");
      }
      return message.ticket;
    }
  }

  async #openStream(
    socket: WebSocket,
    challengeFrameReceived: Promise<{ readonly frame: Buffer }>,
    ticket: string,
    signal: AbortSignal,
  ): Promise<void> {
    const challengeFrame = await challengeFrameReceived;
    const proof = answerAuxiliaryChallenge(
      {
        bootId: this.#options.bootId,
        module: this.#options.module,
        privateKey: this.#identity.privateKey,
        runnerId: this.#identity.runnerId,
        ticket,
      },
      parseJson(challengeFrame.frame),
    );
    await send(socket, JSON.stringify(proof));
    const welcomeFrame = await nextFrame(socket, signal, "Host did not welcome the stream");
    const parsed = parseJson(welcomeFrame.frame);
    const rejection = parsed as { readonly type?: unknown; readonly error?: { message?: string } };
    if (rejection.type === "host.auxiliary.rejected") {
      throw new Error(
        `Host refused the ${this.#options.module} stream: ${rejection.error?.message ?? "unknown"}`,
      );
    }
    const welcome = RunnerAuxiliaryWelcomeSchema.parse(parsed);
    const fence = this.#auxiliaryFence.adopt(welcome);
    await this.#options.onStream({
      ...(welcome.browserWireVersion ? { browserWireVersion: welcome.browserWireVersion } : {}),
      ...(welcome.passkeys === 1 ? { passkeys: 1 } : {}),
      browserAttachPublicKeys: welcome.browserAttachPublicKeys,
      fence,
      send: (frame, binary) => send(socket, frame, binary),
    });
  }

  async #pump(
    primary: WebSocket,
    auxiliary: WebSocket,
    heartbeatIntervalMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const auxiliaryDispatcher = new FencedInboundDispatcher({
      accepts: (fence: RunnerAuxiliaryFrameFence) => this.#auxiliaryFence.accepts(fence),
      fence: (frame: InboundAuxiliaryFrame) => frame.fence,
      handle: async (frame: InboundAuxiliaryFrame, streamSignal) => {
        if (frame.renewal) {
          this.#auxiliaryFence.renew(frame.renewal.streamLeaseExpiresAt);
          return;
        }
        await this.#options.onStreamFrame(frame.frame, false, streamSignal);
      },
    });
    const primaryDispatcher = new FencedInboundDispatcher({
      accepts: (fence: RunnerConnectionFence) => this.#primaryFence.accepts(fence),
      fence: modulePrimaryMessageFence,
      handle: async (message: PostAuthenticationHostMessage) => {
        if (message.type !== "host.connection.lease-renewed") {
          throw new Error("Host sent an unexpected message to a module-only Runner");
        }
        this.#primaryFence.renew(message.connectionLeaseExpiresAt);
      },
    });
    // A module stream whose lease ran out is closed, not broken: say so once,
    // here, and let the run loop below reopen it like any other disconnect.
    this.#auxiliaryFence.onLeaseExpired(() => auxiliary.close(4000, "module stream lease expired"));
    const heartbeat = setInterval(() => {
      void sendHeartbeat(primary, () => ({
        ...this.#primaryFence.fence,
        activeRunIds: [],
        activeTriggerOccurrenceIds: [],
        activeWatchActivationIds: [],
        sentAt: this.#primaryFence.heartbeatTimestamp(),
        type: "runner.heartbeat",
      })).catch(() => primary.close(1011, "heartbeat failed"));
      void sendHeartbeat(auxiliary, () => ({
        ...this.#auxiliaryFence.fence,
        sentAt: this.#auxiliaryFence.heartbeatTimestamp(),
        type: "runner.auxiliary.heartbeat",
      })).catch(() => auxiliary.close(1011, "heartbeat failed"));
    }, heartbeatIntervalMs);
    heartbeat.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        const stop = (error?: Error) => (error ? reject(error) : resolve());
        const abort = () => stop(new Error("Runner connection aborted"));
        signal.addEventListener("abort", abort, { once: true });
        primary.once("close", () => stop(new Error("Primary Runner connection closed")));
        primary.once("error", (error) => stop(toError(error)));
        auxiliary.once("close", () => stop(new Error("Runner module stream closed")));
        auxiliary.once("error", (error) => stop(toError(error)));
        auxiliary.on("message", (raw, isBinary) => {
          try {
            const frame = parseInboundAuxiliaryFrame(rawBuffer(raw), isBinary);
            void auxiliaryDispatcher.dispatch(frame).catch((error: unknown) => {
              auxiliary.close(1011, toError(error).message.slice(0, 120));
            });
          } catch (error) {
            auxiliary.close(1008, toError(error).message.slice(0, 120));
          }
        });
        primary.on("message", (raw) => {
          const message = HostToRunnerMessageSchema.safeParse(parseJson(rawBuffer(raw)));
          if (!message.success) {
            stop(new Error("Host sent an invalid Runner protocol frame"));
            return;
          }
          if (message.data.type === "host.error") {
            stop(new Error(`Host protocol error: ${message.data.error.message}`));
            return;
          }
          if (message.data.type === "host.challenge") {
            stop(new Error("Host repeated the Runner authentication handshake"));
            return;
          }
          void primaryDispatcher.dispatch(message.data).catch((error: unknown) => {
            stop(toError(error));
          });
        });
      });
    } finally {
      clearInterval(heartbeat);
      this.#auxiliaryFence.release();
      await Promise.all([
        auxiliaryDispatcher.abortAndDrain(new Error("Runner module stream closed")),
        primaryDispatcher.abortAndDrain(new Error("Primary Runner connection closed")),
      ]);
    }
  }
}

function modulePrimaryMessageFence(message: PostAuthenticationHostMessage): RunnerConnectionFence {
  switch (message.type) {
    case "host.workspace.local.provision":
    case "host.workspace.local.inspect":
    case "host.workspace.local.destroy":
    case "host.workspace.local.files.list":
    case "host.workspace.local.files.read":
      return message.fence;
    default:
      return message;
  }
}

function rawBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function parseJson(frame: Buffer): unknown {
  try {
    return JSON.parse(frame.toString("utf8"));
  } catch (error) {
    throw new Error("Host frame is not valid JSON", { cause: error });
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Runner connection failed");
}

/**
 * Sends one heartbeat, building the frame inside the promise.
 *
 * Stamping the fence can fail on its own — an expired lease names a stream the
 * Host has forgotten — and a heartbeat runs on a timer, where a synchronous
 * throw has no caller to catch it and would take the whole process down. Every
 * failure therefore arrives as a rejection the timer's own `.catch` handles,
 * which closes the socket and lets the run loop reconnect.
 */
async function sendHeartbeat(socket: WebSocket, frame: () => object): Promise<void> {
  await send(socket, JSON.stringify(frame()));
}

function send(socket: WebSocket, frame: Buffer | string, binary = false): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("Runner socket is closed"));
      return;
    }
    socket.send(frame, { binary }, (error) => (error ? reject(error) : resolve()));
  });
}

async function nextFrame(
  socket: WebSocket,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<{ readonly frame: Buffer }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), handshakeTimeoutMs);
    timer.unref();
    const abort = () => finish(new Error("Runner connection aborted"));
    const onMessage = (raw: RawData) => finish(undefined, rawBuffer(raw));
    const onClose = () => finish(new Error("Runner socket closed during the handshake"));
    const onError = (error: unknown) => finish(toError(error));
    function finish(error?: Error, frame?: Buffer): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error || !frame) reject(error ?? new Error(timeoutMessage));
      else resolve({ frame });
    }
    signal.addEventListener("abort", abort, { once: true });
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}
