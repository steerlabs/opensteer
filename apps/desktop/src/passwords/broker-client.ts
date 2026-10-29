import { unlink } from "node:fs/promises";
import type { Socket } from "node:net";
import {
  PasswordsBrokerHelloResultSchema,
  PasswordsBrokerReplySchema,
  PasswordsBrokerStatusChangedEventSchema,
  passwordsBrokerMaxFrameBytes,
  passwordsBrokerProtocolVersion,
  passwordsBrokerRequests,
  passwordsBrokerResults,
  type PasswordsBrokerMethod,
  type PasswordsBrokerStatus,
} from "@opensteer/protocol/passwords-broker";
import { delay } from "@opensteer/shared/delay";
import {
  encodeLengthPrefixedJson,
  LengthPrefixedJsonReader,
} from "@opensteer/shared/lengthPrefixedJson";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { z } from "zod";
import {
  defaultSignedHelperRun,
  destroySignedHelperSocket,
  isSignedHelperSocketAbsent,
  openSignedHelperSocket,
  runSignedHelperPeerVerifier,
  signedHelperExecutablePath,
  signedHelperSignaturePolicy,
  verifySignedHelperSignature,
  withSignedHelperLifecycleLock,
  type SignedHelperDeadline,
  type SignedHelperIdentity,
  type SignedHelperProcess,
} from "../signed-helpers/signed-helper.js";
import { PasswordsBrokerFailure } from "./broker-session.js";
import { passwordsBrokerIdentity } from "./install.js";
import { desktopPasswordsTeamId } from "./release-identity.js";

/** Calls that are not waiting for the person are answered at once or not at all. */
const defaultRequestTimeoutMs = 15_000;
/** Lock, signature, launch, peer verification and `hello`, together. */
const defaultConnectTimeoutMs = 15_000;
const defaultLaunchTimeoutMs = 10_000;
const defaultPeerVerificationTimeoutMs = 5_000;
const socketPollIntervalMs = 100;

/** The calls that wait for the person, for as long as the person takes. */
const personMethods: ReadonlySet<PasswordsBrokerMethod> = new Set(["signin.approve"]);

type Requests = typeof passwordsBrokerRequests;
type Results = typeof passwordsBrokerResults;
export type PasswordsBrokerCallMethod = Exclude<PasswordsBrokerMethod, "hello">;
export type PasswordsBrokerParams<Method extends PasswordsBrokerMethod> = z.input<Requests[Method]>;
export type PasswordsBrokerResult<Method extends PasswordsBrokerMethod> = z.infer<Results[Method]>;

export interface PasswordsBrokerConnection {
  readonly brokerVersion: string;
  readonly development: boolean;
  /** Distinct for every connection this client makes; what a transaction is bound to. */
  readonly generation: number;
}

export interface PasswordsBrokerCallOptions {
  /**
   * Send only on this connection. When it is gone the call rejects with
   * `connection-lost` and nothing reconnects: the broker ended every
   * transaction that connection carried.
   */
  readonly connection?: number;
  /**
   * Gives up the call. For transaction calls, a frame
   * already sent is followed by `signin.cancel` on the same connection.
   */
  readonly signal?: AbortSignal;
}

export interface PasswordsBrokerPeerVerifier {
  (executable: string, socket: Socket): Promise<void>;
}

export interface PasswordsBrokerClientOptions {
  readonly appVersion: string;
  readonly protocolVersion?: 4 | 5;
  /** The installed broker, which is what LaunchServices starts. */
  readonly brokerAppPath: string;
  readonly connectTimeoutMs?: number;
  /** This desktop's build; a broker of the other build is refused. */
  readonly development: boolean;
  /**
   * Launch the installed broker as a new instance, once, instead of trusting
   * whatever holds the socket now. The installer asks for it after replacing
   * a bundle whose running copy it could neither verify nor stop.
   */
  readonly launchFreshInstance?: boolean;
  readonly launchTimeoutMs?: number;
  readonly lockPath: string;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  readonly now?: () => number;
  readonly peerVerificationTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly run?: SignedHelperProcess;
  readonly socketPath: string;
  /**
   * The broker sealed inside this app, whose `--verify-peer` checks the
   * socket's server. Never the installed copy: that lives where anything
   * running as the person can write.
   */
  readonly verifierAppPath: string;
  readonly verifyPeer?: PasswordsBrokerPeerVerifier;
}

interface Pending {
  readonly method: PasswordsBrokerMethod;
  reject(error: unknown): void;
  resolve(value: unknown): void;
  readonly socket: Socket;
}

interface LiveConnection extends PasswordsBrokerConnection {
  readonly socket: Socket;
}

/**
 * The desktop's connection to `Opensteer Passwords`.
 *
 * Both directions authenticate before a protocol frame is sent: the broker
 * checks this Electron process by its audit token, and this client lends the
 * connected socket as fd 3 to the `--verify-peer` mode of the broker sealed
 * inside this app. `hello` then pins the protocol version and the build.
 *
 * A dropped connection rejects everything in flight on it; the next call
 * connects again, launching the broker if it has to.
 */
export class PasswordsBrokerClient {
  readonly #options: PasswordsBrokerClientOptions;
  readonly #identity: SignedHelperIdentity;
  readonly #now: () => number;
  readonly #pending = new Map<number, Pending>();
  readonly #statusListeners = new Set<(status: PasswordsBrokerStatus) => void>();
  readonly #disconnectListeners = new Set<(generation: number) => void>();
  #attempt: Promise<LiveConnection> | null = null;
  #live: LiveConnection | null = null;
  #opening: Socket | null = null;
  #generation = 0;
  #nextId = 1;
  #closed = false;
  #launchFresh: boolean;

  constructor(options: PasswordsBrokerClientOptions) {
    this.#options = options;
    this.#identity = passwordsBrokerIdentity(options.development);
    this.#now = options.now ?? Date.now;
    this.#launchFresh = options.launchFreshInstance === true;
  }

  /** The authenticated connection open right now, if there is one. */
  get connection(): PasswordsBrokerConnection | null {
    const live = this.#live;
    if (!live || live.socket.destroyed) return null;
    return describe(live);
  }

  /** Calls sent and not yet answered. */
  get pendingCalls(): number {
    return this.#pending.size;
  }

  /** Every `status.changed` the broker sends on the open connection. */
  onStatusChanged(listener: (status: PasswordsBrokerStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** An authenticated connection ending, by its generation. */
  onDisconnect(listener: (generation: number) => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  /**
   * The open connection, or a new one. Concurrent callers share one attempt;
   * aborting `signal` gives up only this caller's wait.
   */
  async connect(signal?: AbortSignal): Promise<PasswordsBrokerConnection> {
    if (this.#closed) throw stopped();
    if (signal?.aborted) throw aborted();
    const live = this.#live;
    if (live && !live.socket.destroyed) return describe(live);
    let attempt = this.#attempt;
    if (!attempt) {
      const established = this.#establish();
      attempt = established;
      this.#attempt = established;
      const settled = (): void => {
        if (this.#attempt === established) this.#attempt = null;
      };
      void established.then(settled, settled);
    }
    return describe(signal ? await untilAborted(attempt, signal) : await attempt);
  }

  async call<Method extends PasswordsBrokerCallMethod>(
    method: Method,
    params: PasswordsBrokerParams<Method>,
    options: PasswordsBrokerCallOptions = {},
  ): Promise<PasswordsBrokerResult<Method>> {
    if (this.#closed) throw stopped();
    const { signal } = options;
    if (signal?.aborted) throw aborted();
    const requestSchema: z.ZodType = passwordsBrokerRequests[method];
    const parsedParams = requestSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new PasswordsBrokerFailure(
        "invalid",
        `Opensteer did not send ${method} to Opensteer Passwords: its parameters are not valid.`,
      );
    }
    let live: LiveConnection | null;
    if (options.connection === undefined) {
      await this.connect(signal);
      live = this.#live;
    } else {
      live = this.#live?.generation === options.connection ? this.#live : null;
    }
    if (!live || live.socket.destroyed) throw connectionLost();
    if (signal?.aborted) throw aborted();
    const answer = await this.#send(live.socket, method, parsedParams.data, {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: personMethods.has(method)
        ? null
        : (this.#options.requestTimeoutMs ??
          (method === "signin.probe" ? 5_000 : defaultRequestTimeoutMs)),
    });
    const resultSchema: z.ZodType = passwordsBrokerResults[method];
    const result = resultSchema.safeParse(answer);
    if (!result.success) {
      this.#options.log?.("desktop.passwords.broker-result-invalid", { method });
      throw new PasswordsBrokerFailure(
        "malformed",
        "Opensteer Passwords answered with something Opensteer could not read.",
      );
    }
    return result.data as PasswordsBrokerResult<Method>;
  }

  request(
    params: PasswordsBrokerParams<"signin.request">,
    options?: PasswordsBrokerCallOptions,
  ): Promise<PasswordsBrokerResult<"signin.request">> {
    return this.call("signin.request", params, options);
  }

  approve(
    params: PasswordsBrokerParams<"signin.approve">,
    options?: PasswordsBrokerCallOptions,
  ): Promise<PasswordsBrokerResult<"signin.approve">> {
    return this.call("signin.approve", params, options);
  }

  release(
    params: PasswordsBrokerParams<"signin.release">,
    options?: PasswordsBrokerCallOptions,
  ): Promise<PasswordsBrokerResult<"signin.release">> {
    return this.call("signin.release", params, options);
  }

  probe(
    params: PasswordsBrokerParams<"signin.probe">,
    options?: PasswordsBrokerCallOptions,
  ): Promise<PasswordsBrokerResult<"signin.probe">> {
    return this.call("signin.probe", params, options);
  }

  status(options?: PasswordsBrokerCallOptions): Promise<PasswordsBrokerStatus> {
    return this.call("status", {}, options);
  }

  async cancel(transactionId: string, options?: PasswordsBrokerCallOptions): Promise<void> {
    await this.call("signin.cancel", { transactionId }, options);
  }

  async openWindow(options?: PasswordsBrokerCallOptions): Promise<void> {
    await this.call("window.open", {}, options);
  }

  /** Drops the connection, which rejects everything in flight on it. */
  async disconnect(): Promise<void> {
    this.#generation += 1;
    this.#attempt = null;
    const live = this.#live;
    const sockets = new Set(
      [this.#opening, live?.socket].filter((socket): socket is Socket => socket != null),
    );
    this.#live = null;
    this.#opening = null;
    if (live) this.#announceDisconnect(live.generation);
    await Promise.all(Array.from(sockets, (socket) => destroySignedHelperSocket(socket)));
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#statusListeners.clear();
    this.#disconnectListeners.clear();
    await this.disconnect();
  }

  async #establish(retried = false): Promise<LiveConnection> {
    this.#generation += 1;
    const generation = this.#generation;
    const due: SignedHelperDeadline = {
      at: this.#now() + (this.#options.connectTimeoutMs ?? defaultConnectTimeoutMs),
    };
    const opened = await withSignedHelperLifecycleLock(
      { deadline: due, identity: this.#identity, lockPath: this.#options.lockPath, now: this.#now },
      async () => {
        await this.#verifyInstalled();
        this.#requireCurrent(generation);
        this.#requireTime(due);
        const fresh = this.#launchFresh;
        if (fresh) {
          // The socket belongs to a process this app could not verify, and the
          // new instance binds the path again, so the path goes first.
          await unlink(this.#options.socketPath).catch(() => undefined);
        } else {
          const existing = await this.#openSocket(generation).catch((error: unknown) => {
            if (!isSignedHelperSocketAbsent(error)) throw error;
            return null;
          });
          if (existing) return { launched: false, socket: existing };
        }
        await this.#launch(fresh);
        this.#requireCurrent(generation);
        const launched = await this.#pollForSocket(generation, due);
        this.#launchFresh = false;
        return { launched: true, socket: launched };
      },
    );
    const { launched, socket } = opened;
    this.#requireTime(due, socket);
    try {
      const executable = signedHelperExecutablePath(this.#identity, this.#options.verifierAppPath);
      const timeoutMs = Math.min(
        this.#options.peerVerificationTimeoutMs ?? defaultPeerVerificationTimeoutMs,
        due.at - this.#now(),
      );
      await (this.#options.verifyPeer
        ? withTimeout(this.#options.verifyPeer(executable, socket), timeoutMs, {
            timeoutError: () => new Error("Opensteer Passwords peer verification timed out."),
          })
        : runSignedHelperPeerVerifier(this.#identity, executable, socket, timeoutMs));
    } catch (error) {
      socket.destroy();
      this.#requireCurrent(generation);
      if (!launched && !retried) {
        // Whatever holds the socket is not the broker, so it may not keep the
        // real one from starting: the path is taken back and a verified
        // instance launched, once.
        this.#launchFresh = true;
        return await this.#establish(true);
      }
      throw new PasswordsBrokerFailure(
        "not-running",
        "This Mac's Opensteer Passwords socket is not owned by the Opensteer Passwords app.",
        { cause: error },
      );
    }
    this.#requireCurrent(generation, socket);
    if (this.#opening === socket) this.#opening = null;
    this.#attach(socket);
    // Lending a net.Socket to a child process as an inherited descriptor
    // pauses its readable side, and adding a data listener does not resume
    // it, so without this the answer to hello would wait unread.
    socket.resume();
    const hello = await this.#send(
      socket,
      "hello",
      {
        client: { version: this.#options.appVersion },
        protocolVersion: this.#options.protocolVersion ?? passwordsBrokerProtocolVersion,
      },
      { timeoutMs: Math.max(1, due.at - this.#now()) },
    ).catch((error: unknown) => {
      socket.destroy();
      throw error;
    });
    const announced =
      typeof hello === "object" && hello !== null
        ? (hello as { readonly protocolVersion?: unknown }).protocolVersion
        : undefined;
    if (
      typeof announced === "number" &&
      announced !== (this.#options.protocolVersion ?? passwordsBrokerProtocolVersion)
    ) {
      socket.destroy();
      throw new PasswordsBrokerFailure(
        "incompatible",
        "Opensteer Passwords on this Mac speaks another version. Update Opensteer.",
      );
    }
    const parsed = PasswordsBrokerHelloResultSchema.safeParse(hello);
    if (!parsed.success) {
      socket.destroy();
      throw new PasswordsBrokerFailure(
        "malformed",
        "Opensteer Passwords answered hello with something Opensteer could not read.",
      );
    }
    if (parsed.data.development !== this.#options.development) {
      socket.destroy();
      this.#options.log?.("desktop.passwords.broker-wrong-build", {
        broker: parsed.data.development ? "development" : "release",
      });
      throw new PasswordsBrokerFailure(
        "wrong-build",
        this.#options.development
          ? "A release Opensteer Passwords answered this development build, which uses its own broker."
          : "A development Opensteer Passwords answered this release build, which never uses one.",
      );
    }
    this.#requireCurrent(generation, socket);
    const live: LiveConnection = {
      brokerVersion: parsed.data.brokerVersion,
      development: parsed.data.development,
      generation,
      socket,
    };
    this.#live = live;
    return live;
  }

  #attach(socket: Socket): void {
    const reader = new LengthPrefixedJsonReader(passwordsBrokerMaxFrameBytes);
    socket.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch (error) {
        // A JSON parse error quotes the body it failed on, so only its kind is logged.
        this.#options.log?.("desktop.passwords.broker-frame-invalid", {
          reason: error instanceof SyntaxError ? "not-json" : "too-large",
        });
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (socket.destroyed) return;
        this.#receive(socket, frame);
      }
    });
    socket.once("close", () => this.#dropped(socket));
    socket.once("error", () => socket.destroy());
  }

  #receive(socket: Socket, frame: unknown): void {
    const reply = PasswordsBrokerReplySchema.safeParse(frame);
    if (!reply.success) {
      // Nothing here can be matched to a call, so the connection is no longer
      // one either side can reason about.
      this.#options.log?.("desktop.passwords.broker-frame-invalid", { reason: "not-a-reply" });
      socket.destroy();
      return;
    }
    const data = reply.data;
    if ("event" in data) {
      if (this.#live?.socket !== socket) return;
      const event = PasswordsBrokerStatusChangedEventSchema.safeParse(data);
      if (!event.success) {
        this.#options.log?.("desktop.passwords.broker-event-invalid", { event: data.event });
        return;
      }
      for (const listener of Array.from(this.#statusListeners)) listener(event.data.params);
      return;
    }
    const pending = this.#pending.get(data.id);
    if (!pending || pending.socket !== socket) return;
    this.#pending.delete(data.id);
    if ("error" in data) {
      pending.reject(
        new PasswordsBrokerFailure(
          data.error.code,
          data.error.message.trim() || "Opensteer Passwords refused the request.",
        ),
      );
      return;
    }
    pending.resolve(data.result);
  }

  async #send(
    socket: Socket,
    method: PasswordsBrokerMethod,
    params: unknown,
    options: { readonly signal?: AbortSignal; readonly timeoutMs: number | null },
  ): Promise<unknown> {
    const { signal, timeoutMs } = options;
    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      if (socket.destroyed) {
        rejectPromise(connectionLost());
        return;
      }
      const id = this.#nextId;
      this.#nextId += 1;
      let frame: Buffer;
      try {
        frame = encodeLengthPrefixedJson({ id, method, params }, passwordsBrokerMaxFrameBytes);
      } catch {
        rejectPromise(
          new PasswordsBrokerFailure(
            "invalid",
            `Opensteer did not send ${method} to Opensteer Passwords: it is too large.`,
          ),
        );
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (!this.#pending.delete(id)) return;
        settle();
        if (method.startsWith("signin.")) this.#cancelAbandoned(socket, params);
        rejectPromise(aborted());
      };
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          if (!this.#pending.delete(id)) return;
          settle();
          rejectPromise(
            new PasswordsBrokerFailure(
              "timeout",
              "Opensteer Passwords did not answer in time on this Mac.",
            ),
          );
        }, timeoutMs);
        timer.unref?.();
      }
      this.#pending.set(id, {
        method,
        reject: (error) => {
          settle();
          rejectPromise(error);
        },
        resolve: (value) => {
          settle();
          resolvePromise(value);
        },
        socket,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        socket.write(frame);
      } catch (error) {
        this.#pending.delete(id);
        settle();
        socket.destroy();
        rejectPromise(connectionLost(error));
      }
    });
  }

  /**
   * Withdraws the transaction on its owning connection when its caller gives up.
   * The v2 invalid error for an abandoned call is dropped with the late reply.
   */
  #cancelAbandoned(socket: Socket, params: unknown): void {
    const transaction = (params as { readonly transactionId?: unknown }).transactionId;
    if (typeof transaction !== "string" || socket.destroyed) return;
    void this.#send(
      socket,
      "signin.cancel",
      { transactionId: transaction },
      { timeoutMs: this.#options.requestTimeoutMs ?? defaultRequestTimeoutMs },
    ).catch((error: unknown) => {
      this.#options.log?.("desktop.passwords.broker-cancel-failed", {
        code: error instanceof PasswordsBrokerFailure ? error.code : "unknown",
      });
    });
  }

  #dropped(socket: Socket): void {
    for (const [id, pending] of Array.from(this.#pending)) {
      if (pending.socket !== socket) continue;
      this.#pending.delete(id);
      pending.reject(connectionLost());
    }
    if (this.#opening === socket) this.#opening = null;
    const live = this.#live;
    if (live?.socket !== socket) return;
    // Every connection already has its own generation, and one being
    // established right now must not be fenced by the old socket's close.
    this.#live = null;
    this.#announceDisconnect(live.generation);
  }

  #announceDisconnect(generation: number): void {
    for (const listener of Array.from(this.#disconnectListeners)) listener(generation);
  }

  /**
   * Starts the broker through LaunchServices, never as a child of this app,
   * so it is its own responsible process. `-g` leaves the person's foreground
   * alone; the broker brings its own window forward when asked to.
   */
  async #launch(fresh: boolean): Promise<void> {
    const run = this.#options.run ?? defaultSignedHelperRun;
    try {
      await run("/usr/bin/open", [
        ...(fresh ? ["-n"] : []),
        "-g",
        "-a",
        this.#options.brokerAppPath,
      ]);
    } catch (error) {
      throw new PasswordsBrokerFailure(
        "not-running",
        "Opensteer could not start Opensteer Passwords on this Mac.",
        { cause: error },
      );
    }
  }

  async #verifyInstalled(): Promise<void> {
    const run = this.#options.run ?? defaultSignedHelperRun;
    try {
      await verifySignedHelperSignature(
        run,
        this.#options.brokerAppPath,
        this.#identity,
        signedHelperSignaturePolicy(desktopPasswordsTeamId(this.#options.development)),
      );
    } catch (error) {
      throw new PasswordsBrokerFailure(
        "not-running",
        "This Mac's Opensteer Passwords is not signed by Opensteer and was not started.",
        { cause: error },
      );
    }
  }

  async #pollForSocket(generation: number, due: SignedHelperDeadline): Promise<Socket> {
    const launchDeadline = this.#now() + (this.#options.launchTimeoutMs ?? defaultLaunchTimeoutMs);
    for (;;) {
      this.#requireCurrent(generation);
      const socket = await this.#openSocket(generation).catch((error: unknown) => {
        if (!isSignedHelperSocketAbsent(error)) throw error;
        return null;
      });
      if (socket) return socket;
      this.#requireTime(due);
      if (this.#now() >= launchDeadline) {
        throw new PasswordsBrokerFailure(
          "not-running",
          "Opensteer Passwords did not start on this Mac. Open Opensteer again, or restart this Mac.",
        );
      }
      await delay(
        Math.max(
          0,
          Math.min(socketPollIntervalMs, launchDeadline - this.#now(), due.at - this.#now()),
        ),
      );
    }
  }

  async #openSocket(generation: number): Promise<Socket> {
    const socket = await openSignedHelperSocket(this.#options.socketPath, (opening) => {
      if (this.#generation !== generation) {
        opening.destroy();
        return;
      }
      this.#opening = opening;
    });
    this.#requireCurrent(generation, socket);
    return socket;
  }

  #requireTime(due: SignedHelperDeadline, socket?: Socket): void {
    if (due.at - this.#now() > 0) return;
    socket?.destroy();
    throw new PasswordsBrokerFailure(
      "not-running",
      "Opensteer Passwords did not start in time on this Mac.",
    );
  }

  #requireCurrent(generation: number, socket?: Socket): void {
    if (this.#generation === generation && !this.#closed) return;
    socket?.destroy();
    throw this.#closed ? stopped() : connectionLost();
  }
}

function describe(live: LiveConnection): PasswordsBrokerConnection {
  return {
    brokerVersion: live.brokerVersion,
    development: live.development,
    generation: live.generation,
  };
}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw aborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        onAbort = () => rejectPromise(aborted());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function aborted(): PasswordsBrokerFailure {
  return new PasswordsBrokerFailure("aborted", "The Opensteer Passwords request was cancelled.");
}

function stopped(): PasswordsBrokerFailure {
  return new PasswordsBrokerFailure("stopped", "Opensteer Passwords is shutting down on this Mac.");
}

function connectionLost(cause?: unknown): PasswordsBrokerFailure {
  return new PasswordsBrokerFailure(
    "connection-lost",
    "Opensteer lost its connection to Opensteer Passwords on this Mac.",
    cause === undefined ? undefined : { cause },
  );
}
