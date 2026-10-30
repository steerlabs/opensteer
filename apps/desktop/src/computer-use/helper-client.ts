import { LengthPrefixedFrameReader } from "@opensteer/shared/lengthPrefixedJson";
import {
  MacVideoDiagnosticEnvelopeSchema,
  decodeDisplayMediaFrame,
  DisplayAckSchema,
  macWindowVideoResults,
  macWindowVideoParams,
} from "@opensteer/protocol";
import { unlink } from "node:fs/promises";
import type { Socket } from "node:net";
import {
  ComputerUseHelperErrorSchema,
  ComputerUseHelperEventSchema,
  ComputerUseHelperResponseSchema,
  ComputerUseHelloResultSchema,
  computerUseHelperProtocolVersion,
  macOwnerViewVersion,
  computerUseHelperResults,
  computerUseRequestMayHaveEffect,
  computerUseMaxTimeoutMs,
  computerUseOutOfTimeSentence,
  type LoginReceiverKey,
  type ComputerUseErrorCode,
  type ComputerUseHelperEvent,
  type ComputerUseHelperMethod,
  type ComputerUsePermissions,
} from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { delay } from "@opensteer/shared/delay";
import type { z } from "zod";
import { computerUseFrameReader, encodeComputerUseFrame } from "./helper-frames.js";
import {
  computerUseHelperIdentity,
  type ComputerUseDeadline,
  type ComputerUseHelperProcess,
  verifyComputerUseHelperSignature,
  withComputerUseHelperLifecycleLock,
} from "./helper-install.js";
import { computerUseHelperExecutablePath } from "./helper-paths.js";
import { opensteerAppleTeamId } from "../signed-helpers/developer-id.js";
import {
  defaultSignedHelperRun,
  destroySignedHelperSocket,
  isSignedHelperSocketAbsent,
  openSignedHelperSocket,
  runSignedHelperPeerVerifier,
} from "../signed-helpers/signed-helper.js";

/**
 * The deadline a request carries when its caller named none. The helper
 * refuses such a request once it runs out, as it does any other, so this is
 * the helper's bound on the work rather than this side's patience.
 */
const defaultRequestTimeoutMs = 30_000;
/**
 * How much longer than a request's own deadline this side waits for the answer
 * the helper owes it. The helper answers at its deadline — refused as not done,
 * or stopped between actions — so only a helper that is wedged or whose answer
 * was lost outlives this, and even then the connection is kept: the caller
 * ends the one session the request belonged to.
 */
export const computerUseHelperAnswerGraceMs = 1_500;
const defaultLaunchTimeoutMs = 5_000;
const defaultPeerVerificationTimeoutMs = 5_000;
const socketPollIntervalMs = 100;
/** Backoff between connection attempts, so a helper that will not start is not hammered. */
const reconnectBackoffMs = [0, 250, 500, 1_000, 2_000] as const;

export const computerUseUpdateSentence = "Update Opensteer to use Computer use.";
/**
 * The helper is older than this app, which ships a newer one; forgetting the
 * client makes the next request install it.
 */
export const computerUseHelperUpdatingSentence =
  "Opensteer is updating Computer use on this Mac. Try again in a moment.";

/** Every refusal this client raises is one of the protocol's own codes. */
export class ComputerUseHelperFailure extends Error {
  readonly code: ComputerUseErrorCode;

  constructor(code: ComputerUseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "ComputerUseHelperFailure";
  }
}

function outOfTime(): ComputerUseHelperFailure {
  return new ComputerUseHelperFailure("failed", computerUseOutOfTimeSentence);
}

/** A helper that cannot speak this app's protocol, said for whichever side is older. */
function incompatibleHelper(helperProtocolVersion: number): ComputerUseHelperFailure {
  return new ComputerUseHelperFailure(
    "incompatible-version",
    helperProtocolVersion < computerUseHelperProtocolVersion
      ? computerUseHelperUpdatingSentence
      : computerUseUpdateSentence,
  );
}

/**
 * Waits for work shared between requests — installing the helper, connecting
 * to it — no longer than one request's deadline.
 *
 * Only the wait is given up. The work goes on for whoever else is waiting on
 * it and for the next request, and it writes nothing of this request's: the
 * request's own frame is written only after this returns, and only with time
 * left.
 */
export async function untilComputerUseDeadline<T>(
  work: Promise<T>,
  deadline: number,
  now: () => number,
): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) throw outOfTime();
  return await withTimeout(work, remaining, { timeoutError: outOfTime });
}

/**
 * A request whose answer did not arrive within its deadline and grace.
 *
 * It is its own type because it is the one failure that says nothing about the
 * connection: the helper may still be working on it, so whoever owns the
 * request's session ends that session, and every other session carries on.
 */
export class ComputerUseHelperDeadlineFailure extends ComputerUseHelperFailure {
  /** `params` decide, with the method, whether the request may have changed something. */
  constructor(method: ComputerUseHelperMethod, params: unknown = {}) {
    const mayHaveEffect = computerUseRequestMayHaveEffect(method, params);
    super(
      mayHaveEffect ? "outcome-unknown" : "failed",
      !mayHaveEffect
        ? "This Mac's Computer use helper did not answer in time."
        : method === "session.act"
          ? "This Mac's Computer use helper did not answer in time; the actions may already have taken effect."
          : "This Mac's Computer use helper did not answer in time; the change may already have been made.",
    );
    this.name = "ComputerUseHelperDeadlineFailure";
  }
}

export interface ComputerUseHelperClientOptions {
  /** This app's bundle identifier, which a development build checks against. */
  readonly appBundleId: string;
  /** This app's version, which the helper records as the client version. */
  readonly appVersion: string;
  readonly helperAppPath: string;
  readonly helperLockPath: string;
  /**
   * The newest protocol the installed helper's bundle declares, or null when
   * it declares none. A helper that refuses this app's hello does not say
   * which side is older, so this is what decides how the refusal reads.
   */
  readonly helperProtocolVersion?: number | null;
  /**
   * Launch the installed helper as a new instance, once, instead of trusting
   * whatever holds the socket now. The installer asks for it after replacing a
   * bundle whose running copy it could neither verify nor stop: that process
   * keeps the socket until it quits, and nothing it answers can be trusted.
   */
  readonly launchFreshInstance?: boolean;
  readonly launchTimeoutMs?: number;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  /** The clock every deadline this client is given is read against. */
  readonly now?: () => number;
  /** Each completed handshake, whose answer carries the grants as they stand. */
  readonly onHandshake?: (hello: {
    readonly loginText?: LoginReceiverKey;
    readonly ownerViewVersion?: number;
    readonly ownerInputVersion?: 2;
    readonly protocolVersion: number;
    readonly helperVersion: string;
    readonly permissions: ComputerUsePermissions;
  }) => void;
  /** The deadline of a request whose caller named none. */
  readonly requestTimeoutMs?: number;
  readonly peerVerificationTimeoutMs?: number;
  readonly run?: ComputerUseHelperProcess;
  readonly socketPath: string;
  /**
   * This app's Apple team identifier, or null for a development build. It is
   * what the installed helper's signature has to match before it is launched.
   */
  readonly teamId: string | null;
  /**
   * The helper bundle sealed inside this app, whose `--verify-peer` checks the
   * socket's server. It is never the installed copy: that lives in a folder
   * the user — and so any process running as the user — can write, and a
   * verifier anyone could replace verifies nothing.
   */
  readonly verifierAppPath: string;
  readonly verifyPeer?: ComputerUseHelperPeerVerifier;
}

export interface ComputerUseHelperPeerVerifier {
  (helperExecutablePath: string, socket: Socket): Promise<void>;
}

export interface ComputerUseMediaAttachment {
  ack(sequence: number): void;
  close(): void;
}

export interface ComputerUseHelperRequestOptions {
  /**
   * When the request must be answered by, in the client's clock: fixed once,
   * where the request arrived, and carried through installing, the lifecycle
   * lock, launching, peer verification and the handshake. The time left at
   * the moment the frame is written travels in it, so the helper refuses
   * queued work that ran out and stops running work between actions; with
   * none left the frame is never written.
   */
  readonly deadline?: number;
  readonly signal?: AbortSignal;
}

type HelperResults = typeof computerUseHelperResults;
export type ComputerUseHelperResult<Method extends ComputerUseHelperMethod> = z.infer<
  HelperResults[Method]
>;

interface PendingRequest {
  /** Whether this request may change something on the Mac, which a lost answer must not hide. */
  readonly mayHaveEffect: boolean;
  readonly method: ComputerUseHelperMethod;
  reject(error: unknown): void;
  resolve(value: unknown): void;
  readonly socket: Socket;
  settle(): void;
}

interface HelperConnection {
  readonly generation: number;
  readonly helperVersion: string;
  readonly ownerInputVersion?: 2 | undefined;
  readonly permissions: ComputerUsePermissions;
  readonly socket: Socket;
}

/**
 * The desktop's one connection to `Opensteer Computer Use`.
 *
 * Both directions authenticate before a protocol frame is sent. The server
 * verifies this Electron process from the socket audit token. This client
 * verifies the installed bundle's signature before launching it, then lends
 * its already-connected socket as fd 3 to the `--verify-peer` mode of the copy
 * sealed inside this app, so native Security APIs verify the process on the
 * other endpoint with code nobody else on this Mac can have changed.
 *
 * One connection serves every slot and session. A late answer ends only the
 * request it belonged to; the connection itself goes only when its transport
 * fails, its peer breaks the protocol, or it has sat idle with nothing open.
 */
export class ComputerUseHelperClient {
  readonly #options: ComputerUseHelperClientOptions;
  readonly #listeners = new Set<(event: ComputerUseHelperEvent) => void>();
  readonly #disconnectListeners = new Set<() => void>();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #media = new Set<ComputerUseMediaAttachment>();
  readonly #now: () => number;
  #connection: Promise<HelperConnection> | null = null;
  /**
   * The deadline the connection being established works to: the latest of
   * the requests waiting on it, so a request that joins late is not refused
   * for an earlier one's lack of time.
   */
  #establishing: { at: number } | null = null;
  #generation = 0;
  #openingSocket: Socket | null = null;
  #socket: Socket | null = null;
  #attempt = 0;
  #closed = false;
  #launchFresh: boolean;
  #nextId = 0;

  constructor(options: ComputerUseHelperClientOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#launchFresh = options.launchFreshInstance === true;
  }

  /** Whether an authenticated connection is open right now. */
  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  /** Requests sent and not yet answered, which an idle disconnect must wait for. */
  get pendingRequests(): number {
    return this.#pending.size;
  }

  /** Every event the helper sends for a session, in arrival order. */
  onEvent(listener: (event: ComputerUseHelperEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The connection dropping, which ends every session the helper held. The
   * helper quits itself once after Screen Recording is first granted, so this
   * fires in ordinary use and the next request simply reconnects.
   */
  onDisconnect(listener: () => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  async request<Method extends ComputerUseHelperMethod>(
    method: Method,
    params: unknown,
    options: ComputerUseHelperRequestOptions = {},
  ): Promise<ComputerUseHelperResult<Method>> {
    if (this.#closed) {
      throw new ComputerUseHelperFailure("failed", "Computer use is shutting down on this Mac.");
    }
    if (options.signal?.aborted) {
      throw new ComputerUseHelperFailure("failed", "The computer use request was cancelled.");
    }
    const deadline = options.deadline ?? this.#defaultDeadline();
    const connection = await this.#connect(deadline);
    if (method === "display.resolve") {
      const resolved = macWindowVideoParams["display.resolve"].parse(params);
      params = {
        source: resolved.source,
        ...(connection.ownerInputVersion === 2 && resolved.ownerInputVersion === 2
          ? { ownerInputVersion: 2 }
          : {}),
      };
    }
    if (
      (method === "display.input" || method === "display.input-reset") &&
      connection.ownerInputVersion !== 2
    )
      throw new ComputerUseHelperFailure(
        "unsupported",
        "This Mac's helper does not support shared owner input.",
      );
    return (await this.#send(
      connection,
      method,
      params,
      { at: deadline },
      options.signal,
    )) as ComputerUseHelperResult<Method>;
  }

  /** A separately verified socket carries binary envelopes and end-to-end credits. */
  async attachDisplay(
    token: string,
    onFrame: (frame: Buffer) => void,
    onLost: () => void,
    options: ComputerUseHelperRequestOptions = {},
  ): Promise<ComputerUseMediaAttachment> {
    const deadline = options.deadline ?? this.#defaultDeadline();
    const control = await this.#connect(deadline);
    const socket = await openSignedHelperSocket(this.#options.socketPath, () => undefined);
    try {
      const executable = computerUseHelperExecutablePath(this.#options.verifierAppPath);
      await untilComputerUseDeadline(
        this.#options.verifyPeer
          ? this.#options.verifyPeer(executable, socket)
          : runSignedHelperPeerVerifier(
              computerUseHelperIdentity,
              executable,
              socket,
              Math.min(defaultPeerVerificationTimeoutMs, deadline - this.#now()),
            ),
        deadline,
        this.#now,
      );
      this.#requireGeneration(control.generation, socket);
      if (control.socket !== this.#socket) throw new Error("Video control connection ended");
      const reader = new LengthPrefixedFrameReader(4 * 1_024 * 1_024);
      let phase = 0;
      const attachment: ComputerUseMediaAttachment = {
        ack: (sequence) => {
          if (!socket.destroyed)
            socket.write(
              encodeComputerUseFrame(DisplayAckSchema.parse({ type: "display.ack", sequence })),
            );
        },
        close: () => {
          this.#media.delete(attachment);
          socket.destroy();
        },
      };
      this.#media.add(attachment);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            attachment.close();
            reject(new Error("Video attachment timed out"));
          },
          Math.max(1, deadline - this.#now()),
        );
        const lost = () => {
          clearTimeout(timer);
          this.#media.delete(attachment);
          if (phase < 2) reject(new Error("Video attachment ended"));
          else onLost();
        };
        socket.once("close", lost);
        socket.once("error", () => socket.destroy());
        socket.on("data", (chunk: Buffer) => {
          try {
            for (const frame of reader.push(chunk)) {
              if (phase === 2) {
                decodeDisplayMediaFrame(frame);
                onFrame(frame);
                continue;
              }
              const value: unknown = JSON.parse(frame.toString("utf8"));
              const failure = ComputerUseHelperErrorSchema.safeParse(value);
              if (failure.success) throw new Error(failure.data.error.message);
              const response = ComputerUseHelperResponseSchema.parse(value);
              if (phase === 0) {
                const hello = ComputerUseHelloResultSchema.parse(response.result);
                if (
                  response.id !== 0 ||
                  hello.protocolVersion !== computerUseHelperProtocolVersion ||
                  hello.minProtocolVersion !== computerUseHelperProtocolVersion
                )
                  throw new Error("Video helper protocol mismatch");
                phase = 1;
                socket.write(
                  encodeComputerUseFrame({ id: 1, method: "display.attach", params: { token } }),
                );
              } else {
                if (response.id !== 1) throw new Error("Unexpected video attachment answer");
                macWindowVideoResults["display.attach"].parse(response.result);
                phase = 2;
                clearTimeout(timer);
                resolve();
              }
            }
          } catch (error) {
            attachment.close();
            reject(error);
          }
        });
        socket.resume();
        socket.write(
          encodeComputerUseFrame({
            id: 0,
            method: "hello",
            params: {
              protocolVersion: computerUseHelperProtocolVersion,
              ownerViewVersion: macOwnerViewVersion,
              clientVersion: this.#options.appVersion,
            },
          }),
        );
      });
      return attachment;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  /** The permissions the last handshake reported, without asking again. */
  async handshake(deadline: number = this.#defaultDeadline()): Promise<{
    readonly helperVersion: string;
    readonly permissions: ComputerUsePermissions;
  }> {
    const connection = await this.#connect(deadline);
    return { helperVersion: connection.helperVersion, permissions: connection.permissions };
  }

  #defaultDeadline(): number {
    return this.#now() + (this.#options.requestTimeoutMs ?? defaultRequestTimeoutMs);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#listeners.clear();
    this.#disconnectListeners.clear();
    await this.disconnect();
  }

  /**
   * Drops the authenticated helper connection, which ends every session it
   * holds. That is for a transport that failed or a protocol it broke, and for
   * an idle connection with no session at all — never for one late answer.
   */
  async disconnect(): Promise<void> {
    for (const media of this.#media) media.close();
    const endedAuthenticatedLifetime = this.#socket !== null;
    this.#generation += 1;
    this.#connection = null;
    this.#establishing = null;
    const sockets = new Set(
      [this.#openingSocket, this.#socket].filter((socket) => socket !== null),
    );
    this.#openingSocket = null;
    this.#socket = null;
    if (endedAuthenticatedLifetime) {
      for (const listener of Array.from(this.#disconnectListeners)) listener();
    }
    await Promise.all(Array.from(sockets, (socket) => destroySignedHelperSocket(socket)));
  }

  async #connect(deadline: number): Promise<HelperConnection> {
    if (deadline - this.#now() <= 0) throw outOfTime();
    let attempt = this.#connection;
    if (attempt) {
      if (this.#establishing) {
        this.#establishing.at = Math.max(this.#establishing.at, deadline);
      }
    } else {
      const due = { at: deadline };
      const established = this.#establish(due);
      attempt = established;
      this.#connection = established;
      this.#establishing = due;
      void established.then(
        () => {
          this.#attempt = 0;
          if (this.#establishing === due) this.#establishing = null;
        },
        () => {
          // A caller exhausting its own budget says nothing about the helper's health.
          if (this.#connection === established && due.at > this.#now()) this.#attempt += 1;
          if (this.#connection === established) this.#connection = null;
          if (this.#establishing === due) this.#establishing = null;
        },
      );
    }
    return await untilComputerUseDeadline(attempt, deadline, this.#now);
  }

  /** Throws when the connection's deadline has passed, so no later step starts. */
  #requireTime(due: ComputerUseDeadline, socket?: Socket): void {
    if (due.at - this.#now() > 0) return;
    socket?.destroy();
    throw outOfTime();
  }

  async #establish(due: ComputerUseDeadline): Promise<HelperConnection> {
    const generation = this.#generation;
    const backoff = reconnectBackoffMs[Math.min(this.#attempt, reconnectBackoffMs.length - 1)] ?? 0;
    if (backoff > 0) await delay(Math.max(0, Math.min(backoff, due.at - this.#now())));
    this.#requireTime(due);
    const socket = await withComputerUseHelperLifecycleLock(
      { deadline: due, lockPath: this.#options.helperLockPath, now: this.#now },
      async () => {
        await this.#verifyHelperSignature();
        this.#requireGeneration(generation);
        this.#requireTime(due);
        const fresh = this.#launchFresh;
        if (fresh) {
          // The socket belongs to a process this app could not verify. The
          // new instance binds the path again on start, and polling before it
          // has would find the old listener, so the path goes first.
          await unlink(this.#options.socketPath).catch(() => undefined);
        } else {
          const existing = await this.#openSocket(generation).catch((error: unknown) => {
            if (!isSignedHelperSocketAbsent(error)) throw error;
            return null;
          });
          if (existing) return existing;
        }
        await this.#launchHelper(fresh);
        this.#requireGeneration(generation);
        const launched = await this.#pollForSocket(generation, due);
        this.#launchFresh = false;
        return launched;
      },
    );
    this.#requireTime(due, socket);
    try {
      const executable = computerUseHelperExecutablePath(this.#options.verifierAppPath);
      const timeoutMs = Math.min(
        this.#options.peerVerificationTimeoutMs ?? defaultPeerVerificationTimeoutMs,
        due.at - this.#now(),
      );
      await (this.#options.verifyPeer
        ? withTimeout(this.#options.verifyPeer(executable, socket), timeoutMs, {
            timeoutError: () => new Error("Computer use peer verification timed out."),
          })
        : runSignedHelperPeerVerifier(computerUseHelperIdentity, executable, socket, timeoutMs));
    } catch (error) {
      socket.destroy();
      // A verifier cut short by the deadline proved nothing either way.
      this.#requireTime(due);
      throw new ComputerUseHelperFailure(
        "failed",
        "This Mac's Computer use socket is not owned by the Opensteer helper.",
        { cause: error },
      );
    }
    this.#requireGeneration(generation, socket);
    if (this.#openingSocket === socket) this.#openingSocket = null;
    this.#socket = socket;
    this.#attachSocket(socket, generation);
    // Lending a net.Socket to child_process as an inherited descriptor pauses
    // its readable side. Adding the data listener above does not resume it, so
    // without this the helper receives hello and its answer waits unread in
    // the kernel socket buffer until the request times out.
    socket.resume();
    const hello = await this.#send(
      {
        generation,
        helperVersion: "",
        permissions: { accessibility: "denied", screenRecording: "denied" },
        socket,
      },
      "hello",
      {
        clientVersion: this.#options.appVersion,
        protocolVersion: computerUseHelperProtocolVersion,
        ownerViewVersion: macOwnerViewVersion,
        ownerInputVersion: 2,
        loginText: 1,
      },
      due,
    ).catch((error: unknown) => {
      socket.destroy();
      // Every released helper's refusal says to update Opensteer, which is
      // wrong whenever the helper is the older side.
      if (error instanceof ComputerUseHelperFailure && error.code === "incompatible-version") {
        throw incompatibleHelper(this.#options.helperProtocolVersion ?? 0);
      }
      throw error;
    });
    const result = ComputerUseHelloResultSchema.parse(hello);
    this.#requireGeneration(generation, socket);
    if (
      computerUseHelperProtocolVersion < result.minProtocolVersion ||
      computerUseHelperProtocolVersion > result.protocolVersion
    ) {
      socket.destroy();
      throw incompatibleHelper(result.protocolVersion);
    }
    this.#options.onHandshake?.({
      ...(result.loginText ? { loginText: result.loginText } : {}),
      ...(result.ownerViewVersion === undefined
        ? {}
        : { ownerViewVersion: result.ownerViewVersion }),
      ...(result.ownerInputVersion === undefined
        ? {}
        : { ownerInputVersion: result.ownerInputVersion }),
      protocolVersion: result.protocolVersion,
      helperVersion: result.helperVersion,
      permissions: result.permissions,
    });
    return {
      helperVersion: result.helperVersion,
      ownerInputVersion: result.ownerInputVersion,
      generation,
      permissions: result.permissions,
      socket,
    };
  }

  #attachSocket(socket: Socket, generation: number): void {
    const reader = computerUseFrameReader();
    socket.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch (error) {
        this.#options.log?.("desktop.computer-use.helper-frame-invalid", {
          message: error instanceof Error ? error.message : "unreadable frame",
        });
        socket.destroy();
        return;
      }
      for (const frame of frames) this.#receive(socket, generation, frame);
    });
    const drop = (): void => {
      const current = this.#generation === generation && this.#socket === socket;
      if (current && this.#connection) {
        void this.#connection.then(
          (current) => {
            if (current.socket === socket) this.#connection = null;
          },
          () => undefined,
        );
      }
      if (current) {
        this.#socket = null;
        for (const media of this.#media) media.close();
      }
      const pending = [...this.#pending.entries()].filter(
        ([, request]) => request.socket === socket,
      );
      for (const [id, request] of pending) {
        this.#pending.delete(id);
        // A change whose answer was lost may already have happened, so it is
        // reported as unknown rather than as a clean failure.
        request.settle();
        request.reject(
          new ComputerUseHelperFailure(
            request.mayHaveEffect ? "outcome-unknown" : "failed",
            "Computer use lost its connection to this Mac's helper.",
          ),
        );
      }
      if (current) for (const listener of Array.from(this.#disconnectListeners)) listener();
    };
    socket.once("close", drop);
    socket.once("error", () => socket.destroy());
  }

  #receive(socket: Socket, generation: number, frame: unknown): void {
    if (generation !== this.#generation || socket !== this.#socket) return;
    const diagnostic = MacVideoDiagnosticEnvelopeSchema.safeParse(frame);
    if (diagnostic.success) {
      const { event: transition, ...details } = diagnostic.data.params;
      try {
        this.#options.log?.(
          "desktop.computer-use.video",
          Object.fromEntries(
            Object.entries({ transition, ...details }).map(([key, value]) => [key, String(value)]),
          ),
        );
      } catch {
        /* Diagnostics cannot interrupt helper IPC. */
      }
      return;
    }
    const event = ComputerUseHelperEventSchema.safeParse(frame);
    if (event.success) {
      for (const listener of Array.from(this.#listeners)) listener(event.data);
      return;
    }
    const failure = ComputerUseHelperErrorSchema.safeParse(frame);
    if (failure.success) {
      const pending = this.#pending.get(failure.data.id);
      if (!pending) return;
      this.#pending.delete(failure.data.id);
      pending.settle();
      pending.reject(
        new ComputerUseHelperFailure(failure.data.error.code, failure.data.error.message),
      );
      return;
    }
    const response = ComputerUseHelperResponseSchema.safeParse(frame);
    if (!response.success) return;
    const pending = this.#pending.get(response.data.id);
    if (!pending) return;
    this.#pending.delete(response.data.id);
    pending.settle();
    pending.resolve(response.data.result);
  }

  async #send(
    connection: HelperConnection,
    method: ComputerUseHelperMethod,
    params: unknown,
    due: ComputerUseDeadline,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw new ComputerUseHelperFailure("failed", "The computer use request was cancelled.");
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const mayHaveEffect = computerUseRequestMayHaveEffect(method, params);
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      if (
        connection.generation !== this.#generation ||
        connection.socket !== this.#socket ||
        connection.socket.destroyed
      ) {
        rejectPromise(
          new ComputerUseHelperFailure("failed", "Computer use connection was replaced."),
        );
        return;
      }
      // Read in the same turn as the write below, so the frame carries the
      // time the request has left as it leaves, and none left means no frame.
      const timeoutMs = Math.min(computerUseMaxTimeoutMs, Math.floor(due.at - this.#now()));
      if (timeoutMs <= 0) {
        rejectPromise(outOfTime());
        return;
      }
      let settled = false;
      let written = false;
      // Past its deadline the helper owes an answer, so a wait longer than the
      // grace means it is wedged on this one request. The request is given up
      // and the connection kept: every other session on it is healthy.
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        settle();
        rejectPromise(new ComputerUseHelperDeadlineFailure(method, params));
      }, timeoutMs + computerUseHelperAnswerGraceMs);
      timer.unref?.();
      const abort = (): void => {
        this.#pending.delete(id);
        settle();
        rejectPromise(
          new ComputerUseHelperFailure(
            mayHaveEffect && written ? "outcome-unknown" : "failed",
            mayHaveEffect && written
              ? "The computer use request was cancelled after it was sent; its outcome is unknown."
              : "The computer use request was cancelled.",
          ),
        );
      };
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        mayHaveEffect,
        method,
        reject: rejectPromise,
        resolve: (value) => {
          if (method === "hello") {
            resolvePromise(value);
            return;
          }
          const parsed = computerUseHelperResults[method].safeParse(value);
          if (!parsed.success) {
            rejectPromise(
              new ComputerUseHelperFailure(
                mayHaveEffect ? "outcome-unknown" : "failed",
                "This Mac's Computer use helper answered with something Opensteer could not read.",
              ),
            );
            return;
          }
          resolvePromise(parsed.data);
        },
        socket: connection.socket,
        settle,
      });
      try {
        connection.socket.write(encodeComputerUseFrame({ id, method, params, timeoutMs }));
        written = true;
      } catch (error) {
        // A socket that cannot take a frame is a transport that failed, which
        // is what ends the whole connection.
        this.#pending.delete(id);
        settle();
        void this.disconnect();
        rejectPromise(
          new ComputerUseHelperFailure(
            method === "session.act" ? "outcome-unknown" : "failed",
            "Computer use could not reach this Mac's helper.",
            {
              cause: error,
            },
          ),
        );
      }
    });
  }

  /**
   * Starts the helper through LaunchServices, never as a child of this app:
   * `-g` leaves the person's foreground alone while allowing the helper's
   * pill and cursor windows to appear. Going through `open` makes the helper
   * its own responsible process, so macOS attributes the two grants to it
   * rather than to Opensteer.
   */
  async #launchHelper(fresh: boolean): Promise<void> {
    const run = this.#options.run ?? defaultSignedHelperRun;
    try {
      await run("/usr/bin/open", [
        ...(fresh ? ["-n"] : []),
        "-g",
        "-a",
        this.#options.helperAppPath,
      ]);
    } catch (error) {
      throw new ComputerUseHelperFailure(
        "failed",
        "Opensteer could not start Computer use on this Mac.",
        { cause: error },
      );
    }
  }

  async #verifyHelperSignature(): Promise<void> {
    const run = this.#options.run ?? defaultSignedHelperRun;
    try {
      await verifyComputerUseHelperSignature(run, this.#options.helperAppPath, {
        allowAdHoc: this.#options.teamId === null,
        expectedTeamId: this.#options.teamId ?? opensteerAppleTeamId,
      });
    } catch (error) {
      throw new ComputerUseHelperFailure(
        "failed",
        "This Mac's Computer use helper is not signed by Opensteer and was not started.",
        { cause: error },
      );
    }
  }

  async #pollForSocket(generation: number, due: ComputerUseDeadline): Promise<Socket> {
    const launchDeadline = this.#now() + (this.#options.launchTimeoutMs ?? defaultLaunchTimeoutMs);
    for (;;) {
      this.#requireGeneration(generation);
      const socket = await this.#openSocket(generation).catch((error: unknown) => {
        if (!isSignedHelperSocketAbsent(error)) throw error;
        return null;
      });
      if (socket) return socket;
      this.#requireTime(due);
      if (this.#now() >= launchDeadline) {
        throw new ComputerUseHelperFailure(
          "failed",
          "Computer use did not start on this Mac. Open Opensteer again, or restart this Mac.",
        );
      }
      await delay(
        Math.min(socketPollIntervalMs, launchDeadline - this.#now(), due.at - this.#now()),
      );
    }
  }

  async #openSocket(generation: number): Promise<Socket> {
    const socket = await openSignedHelperSocket(this.#options.socketPath, (opening) => {
      if (this.#generation !== generation) {
        opening.destroy();
        return;
      }
      this.#openingSocket = opening;
    });
    if (this.#generation !== generation) {
      socket.destroy();
      throw new ComputerUseHelperFailure("failed", "Computer use connection was replaced.");
    }
    return socket;
  }

  #requireGeneration(generation: number, socket?: Socket): void {
    if (this.#generation === generation && !this.#closed) return;
    socket?.destroy();
    throw new ComputerUseHelperFailure("failed", "Computer use connection was replaced.");
  }
}
