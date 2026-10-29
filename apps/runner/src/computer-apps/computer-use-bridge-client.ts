import {
  ComputerUseBridgeFrameSchema,
  ComputerUseBridgeRequestSchema,
  computerUseBridgeMaxFrameBytes,
  computerUseBridgeOwnerInputHeader,
  macWindowVideoParams,
  computerUseMaxTimeoutMs,
  computerUseOutOfTimeSentence,
  computerUseRequestMayHaveEffect,
  type ComputerUseBridgeEvent,
  type ComputerUseBridgeFrame,
  type ComputerUseBridgeMethod,
  type ComputerUseBridgeRequest,
  type ComputerUseErrorCode,
} from "@opensteer/protocol";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { WebSocket, type RawData } from "ws";
import { delay } from "@opensteer/shared/delay";

/**
 * How long one connection attempt may take before the desktop counts as not
 * running. It is short because the target is loopback on this very computer:
 * the answer is a connect or a refusal, never a network.
 */
const connectTimeoutMs = 5_000;
const minimumRetryDelayMs = 250;
const maximumRetryDelayMs = 5_000;
/**
 * How much longer than a request's deadline this end waits for the desktop.
 *
 * Every hop inside this one answers by the deadline plus a shorter grace of its
 * own — the helper at the deadline, desktop main a few seconds after — so an
 * answer that has not come by now is not coming, and whatever the Host waits
 * must outlast this. Past it, the one request is given up; the socket stays.
 */
export const computerUseRunnerGraceMs = 4_000;

/**
 * What a caller is told when nothing answers on loopback.
 *
 * It names the Mac, which no other computer app sentence may do, because this
 * one is about the computer rather than an app on it: `docs/computer-use.md`
 * §3 fixes the wording, and the surfaces that print it — a computer's own page
 * and a model's answer — do not append a computer's name to it.
 */
export const computerUseDesktopMissingSentence =
  "The Opensteer desktop app is not running on this Mac.";
const bridgeLostSentence = "The Opensteer desktop app stopped answering.";
/**
 * A batch whose answer was lost may already have happened in the app, so the
 * one thing this sentence must not invite is a retry.
 */
const actLostSentence = "The Mac stopped answering; the actions may already have taken effect.";
const cancelledSentence = "The request was cancelled.";
const lateSentence = "The Mac did not answer in time.";
const lateActSentence =
  "The Mac did not answer in time; the actions may already have taken effect.";
const writeLostSentence = "The Mac stopped answering; the change may already have been made.";
const lateWriteSentence = "The Mac did not answer in time; the change may already have been made.";

/** The refusal shape every computer-use surface prints: a code and a sentence. */
export class ComputerUseBridgeError extends Error {
  // Assigned rather than declared as a constructor parameter property, which
  // this repository's `erasableSyntaxOnly` forbids.
  readonly code: ComputerUseErrorCode;

  constructor(code: ComputerUseErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ComputerUseBridgeError";
  }
}

/**
 * A request this end stopped waiting for. Nothing about the connection is
 * implied, so the caller ends the one session it belonged to, if any.
 */
export class ComputerUseBridgeDeadlineError extends ComputerUseBridgeError {
  /** `mayHaveEffect`: the request was written and may have changed something. */
  constructor(method: ComputerUseBridgeMethod, mayHaveEffect: boolean) {
    super(
      mayHaveEffect ? "outcome-unknown" : "failed",
      !mayHaveEffect
        ? lateSentence
        : method === "session.act"
          ? lateActSentence
          : lateWriteSentence,
    );
    this.name = "ComputerUseBridgeDeadlineError";
  }
}

export interface ComputerUseBridgeRequestOptions {
  /**
   * When the request must be answered by, in this client's clock. Reaching
   * the desktop spends from it, and the time left at the moment the frame is
   * written travels in it, so desktop main and the helper hold the request to
   * this same instant; with none left the frame is never written. This end
   * waits for it plus `computerUseRunnerGraceMs`.
   */
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

export interface ComputerUseBridgeClientOptions {
  /** Readiness for the current Desktop connection, cleared on loss and reconnect. */
  readonly ownerInputVersion?: () => 1 | undefined;
  /** How long past a deadline to wait; `computerUseRunnerGraceMs` unless a test shortens it. */
  readonly graceMs?: number;
  /** The clock deadlines are read against. */
  readonly now?: () => number;
  /** Unsolicited frames from the Mac: a session stopped, an approval answered. */
  readonly onEvent?: (event: ComputerUseBridgeEvent) => void;
  /**
   * A connection to the desktop was just established — the first, or one
   * after a drop. A desktop this end was not connected to may have missed
   * the Host's approval list, so it is asked for again.
   */
  readonly onConnected?: () => void;
  /**
   * Called when an established connection drops. The desktop closes every
   * session it opened for this Runner when that happens, so whoever holds
   * session state on this side has to forget it at the same moment.
   */
  readonly onLost?: () => void;
  readonly token: string;
  readonly url: URL;
}

interface PendingRequest {
  /** True once the caller has been answered and only the id is still held. */
  abandoned: boolean;
  /** Whether, once written, this request may change something on the Mac. */
  readonly mayHaveEffect: boolean;
  readonly method: ComputerUseBridgeMethod;
  readonly settle: (outcome: { error: ComputerUseBridgeError } | { value: unknown }) => void;
  /** Whether the frame was handed to the socket, which decides a lost answer. */
  written: boolean;
}

/**
 * The Runner's end of the computer-use bridge: one loopback WebSocket to the
 * Opensteer desktop app, which owns the helper that holds the macOS grants.
 *
 * It is lazy on purpose. Most Runners never see a computer-use frame, and a
 * socket opened at startup would keep a helper alive for nothing; the first
 * call connects, and a drop is repaired on the next one after a backoff rather
 * than by a timer that outlives the work. What a drop must never do is leave a
 * caller guessing: a request that may change something — an `act`, a data
 * write — whose frame was already written is `outcome-unknown`, because it may
 * have landed and a retry would do it twice; everything else is `failed`, and
 * nothing happened on the Mac.
 *
 * A request that outlives its deadline is given up on its own. The socket is
 * every Run's on this Runner, so one late answer never drops it: only a peer
 * that breaks the protocol, a transport that fails, or the stream detaching
 * does.
 */
export class ComputerUseBridgeClient {
  readonly #now: () => number;
  readonly #options: ComputerUseBridgeClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #url: URL;
  #closed = false;
  #connecting: Promise<WebSocket> | undefined;
  #nextId = 1;
  #generation = 0;
  #openingSocket: WebSocket | undefined;
  #retryDelayMs = minimumRetryDelayMs;
  #retryAt = 0;
  #socket: WebSocket | undefined;

  constructor(options: ComputerUseBridgeClientOptions) {
    this.#now = options.now ?? Date.now;
    this.#options = options;
    // The desktop mints whichever of the two spellings its own server speaks;
    // one socket scheme is what this end opens either way.
    const url = new URL(options.url);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol !== "ws:") {
      throw new Error("The computer use bridge target must be a loopback ws:// or http:// URL");
    }
    this.#url = url;
  }

  async request(
    method: ComputerUseBridgeMethod,
    params: unknown,
    options: ComputerUseBridgeRequestOptions,
  ): Promise<unknown> {
    if (this.#closed) throw new ComputerUseBridgeError("failed", bridgeLostSentence);
    if (options.signal?.aborted) throw new ComputerUseBridgeError("failed", cancelledSentence);
    // A deadline further off than the protocol allows is held to what it allows.
    const deadline = Math.min(options.deadline, this.#now() + computerUseMaxTimeoutMs);
    if (Math.floor(deadline - this.#now()) <= 0) {
      throw new ComputerUseBridgeError("failed", computerUseOutOfTimeSentence);
    }
    // Checked with the largest `timeoutMs` a frame can carry, so the one
    // written later, with whatever is left then, is never larger than this.
    const frame = ComputerUseBridgeRequestSchema.parse({
      id: this.#nextId++,
      kind: "request",
      method,
      params,
      timeoutMs: computerUseMaxTimeoutMs,
    });
    if (Buffer.byteLength(JSON.stringify(frame), "utf8") > computerUseBridgeMaxFrameBytes) {
      throw new ComputerUseBridgeError("failed", "The request was too large to send.");
    }
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const pending: PendingRequest = {
        abandoned: false,
        mayHaveEffect: computerUseRequestMayHaveEffect(method, params),
        method,
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          if ("error" in outcome) reject(outcome.error);
          else resolve(outcome.value);
        },
        written: false,
      };
      const onAbort = (): void => {
        // Once written, the native work owns this promise until its reply or
        // connection loss. The module may answer cancellation immediately, but
        // cannot free its capacity slot while the helper is still executing.
        if (pending.written) return;
        pending.abandoned = true;
        pending.settle({ error: new ComputerUseBridgeError("failed", cancelledSentence) });
      };
      // Only this request is given up, either way. A late answer, if one
      // comes, finds no pending id and is dropped.
      const giveUp = (error: ComputerUseBridgeError): void => {
        if (this.#pending.get(frame.id) === pending) this.#pending.delete(frame.id);
        pending.abandoned = true;
        pending.settle({ error });
      };
      // At the deadline a request still waiting for the desktop is refused as
      // not done, and can no longer be written; one already written is owed
      // its answer for the grace every hop inside this one answers within.
      let timer = setTimeout(
        () => {
          if (!pending.written) {
            giveUp(new ComputerUseBridgeError("failed", computerUseOutOfTimeSentence));
            return;
          }
          timer = setTimeout(
            () =>
              giveUp(
                new ComputerUseBridgeDeadlineError(
                  method,
                  pending.mayHaveEffect && pending.written,
                ),
              ),
            this.#options.graceMs ?? computerUseRunnerGraceMs,
          );
          timer.unref();
        },
        Math.max(0, deadline - this.#now()),
      );
      timer.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#send(pending, frame, deadline);
    });
  }

  /** Whether a socket to the desktop is open right now. */
  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Drops the connection without ending the client.
   *
   * It is how this end gives up on a session the desktop still holds: the
   * desktop closes every session a Runner's socket opened when that socket
   * goes, so dropping it is the one way to say "forget these" that does not
   * depend on the desktop answering.
   */
  disconnect(): void {
    this.#generation += 1;
    this.#connecting = undefined;
    const socket = this.#socket;
    const opening = this.#openingSocket;
    this.#socket = undefined;
    this.#openingSocket = undefined;
    this.#dropSocket(socket);
    this.#dropSocket(opening);
    this.#failPending();
    if (!this.#closed) this.#options.onLost?.();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.disconnect();
  }

  #send(pending: PendingRequest, frame: ComputerUseBridgeRequest, deadline: number): void {
    const id = frame.id;
    this.#pending.set(id, pending);
    void this.#connect().then(
      (socket) => {
        if (this.#pending.get(id) !== pending) return;
        if (pending.abandoned) {
          // The caller is already answered; the id is held for the late
          // response, and writing the request would only cost the Mac work.
          this.#pending.delete(id);
          return;
        }
        // Read in the same turn as the write, so the frame carries what is
        // left as it leaves: connecting spent the rest.
        const timeoutMs = Math.min(computerUseMaxTimeoutMs, Math.floor(deadline - this.#now()));
        if (timeoutMs <= 0) {
          this.#pending.delete(id);
          pending.abandoned = true;
          pending.settle({
            error: new ComputerUseBridgeError("failed", computerUseOutOfTimeSentence),
          });
          return;
        }
        // Reconnecting may have replaced the Desktop since readiness was read.
        // Project at the write so a previous strict bridge gets its exact shape.
        let params: unknown = frame.params;
        if (frame.method === "display.resolve" && this.#options.ownerInputVersion?.() !== 1) {
          const resolved = macWindowVideoParams["display.resolve"].safeParse(params);
          if (!resolved.success) {
            this.#reject(
              id,
              new ComputerUseBridgeError("failed", "That view could not be opened."),
            );
            return;
          }
          params = { source: resolved.data.source };
        }
        pending.written = true;
        socket.send(JSON.stringify({ ...frame, params, timeoutMs }), (error) => {
          if (error) this.#reject(id, this.#lostError(pending));
        });
      },
      (error: unknown) => {
        this.#pending.delete(id);
        pending.settle({
          error:
            error instanceof ComputerUseBridgeError
              ? error
              : new ComputerUseBridgeError("failed", computerUseDesktopMissingSentence),
        });
      },
    );
  }

  async #connect(): Promise<WebSocket> {
    if (this.#closed) throw new ComputerUseBridgeError("failed", bridgeLostSentence);
    const socket = this.#socket;
    if (socket?.readyState === WebSocket.OPEN) return socket;
    if (!this.#connecting) {
      const opening = this.#open(this.#generation);
      this.#connecting = opening;
      const finished = (): void => {
        if (this.#connecting === opening) this.#connecting = undefined;
      };
      void opening.then(finished, finished);
    }
    return await this.#connecting;
  }

  async #open(generation: number): Promise<WebSocket> {
    const wait = this.#retryAt - Date.now();
    if (wait > 0) await delay(wait);
    if (this.#closed || generation !== this.#generation) {
      throw new ComputerUseBridgeError("failed", bridgeLostSentence);
    }
    const socket = new WebSocket(this.#url, {
      followRedirects: false,
      headers: {
        authorization: `Bearer ${this.#options.token}`,
        [computerUseBridgeOwnerInputHeader]: "1",
      },
      maxPayload: computerUseBridgeMaxFrameBytes,
      perMessageDeflate: false,
    });
    this.#openingSocket = socket;
    try {
      await waitForOpen(socket);
    } catch (error) {
      socket.terminate();
      if (this.#openingSocket === socket) this.#openingSocket = undefined;
      if (generation === this.#generation) this.#backOff();
      throw error instanceof ComputerUseBridgeError
        ? error
        : new ComputerUseBridgeError("failed", computerUseDesktopMissingSentence);
    }
    if (this.#openingSocket === socket) this.#openingSocket = undefined;
    if (this.#closed || generation !== this.#generation) {
      socket.terminate();
      throw new ComputerUseBridgeError("failed", bridgeLostSentence);
    }
    this.#retryDelayMs = minimumRetryDelayMs;
    this.#retryAt = 0;
    this.#socket = socket;
    socket.on("message", (raw: RawData) => this.#receive(socket, raw));
    socket.once("close", () => this.#lost(socket));
    socket.once("error", () => this.#lost(socket));
    this.#options.onConnected?.();
    return socket;
  }

  #receive(socket: WebSocket, raw: RawData): void {
    if (this.#socket !== socket) return;
    const frame = readBridgeFrame(raw);
    if (!frame) {
      // A peer speaking something else is not a peer this end can reason
      // about, and answering half its frames would be worse than none.
      this.#lost(socket);
      return;
    }
    if (frame.kind === "event") {
      this.#options.onEvent?.(frame);
      return;
    }
    if (frame.kind !== "response") return;
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    this.#pending.delete(frame.id);
    if (pending.abandoned) return;
    if ("error" in frame) {
      pending.settle({ error: new ComputerUseBridgeError(frame.error.code, frame.error.message) });
      return;
    }
    pending.settle({ value: frame.result });
  }

  #lost(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#dropSocket(socket);
    this.#backOff();
    this.#failPending();
    if (!this.#closed) this.#options.onLost?.();
  }

  #failPending(): void {
    for (const [id, pending] of Array.from(this.#pending)) {
      this.#pending.delete(id);
      if (!pending.abandoned) pending.settle({ error: this.#lostError(pending) });
    }
  }

  #reject(id: number, error: ComputerUseBridgeError): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (!pending.abandoned) pending.settle({ error });
  }

  #lostError(pending: PendingRequest): ComputerUseBridgeError {
    if (!pending.mayHaveEffect || !pending.written) {
      return new ComputerUseBridgeError("failed", bridgeLostSentence);
    }
    return new ComputerUseBridgeError(
      "outcome-unknown",
      pending.method === "session.act" ? actLostSentence : writeLostSentence,
    );
  }

  #backOff(): void {
    this.#retryAt = Date.now() + this.#retryDelayMs;
    this.#retryDelayMs = Math.min(maximumRetryDelayMs, this.#retryDelayMs * 2);
  }

  #dropSocket(socket: WebSocket | undefined): void {
    if (!socket) return;
    if (this.#socket === socket) this.#socket = undefined;
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

function readBridgeFrame(raw: RawData): ComputerUseBridgeFrame | undefined {
  try {
    return ComputerUseBridgeFrameSchema.parse(JSON.parse(rawDataBuffer(raw).toString("utf8")));
  } catch {
    return undefined;
  }
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new ComputerUseBridgeError("failed", computerUseDesktopMissingSentence)),
      connectTimeoutMs,
    );
    timer.unref();
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = (): void => finish();
    const onError = (): void =>
      finish(new ComputerUseBridgeError("failed", computerUseDesktopMissingSentence));
    const onClose = (): void =>
      finish(new ComputerUseBridgeError("failed", computerUseDesktopMissingSentence));
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}
