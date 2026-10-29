import { shellDataMessageMaxBytes, shellDataQueueMaxBytes } from "@opensteer/protocol";
import { rawDataBuffer, type WebSocketFrame } from "@opensteer/shared/webSocketFrame";

/**
 * The part of a WebSocket a byte pump touches.
 *
 * Narrow on purpose: the pump is the one place a stalled peer can cost another
 * session anything, so it is written against an interface a test can stall at
 * will rather than against a live socket.
 */
export interface ShellByteSocket {
  readonly readyState: number;
  close(code: number, reason: string): void;
  on(event: "message", listener: (data: WebSocketFrame, isBinary: boolean) => void): unknown;
  once(event: "close" | "error", listener: (...args: unknown[]) => void): unknown;
  pause(): void;
  removeAllListeners(event: "message"): unknown;
  resume(): void;
  send(data: Buffer, options: { readonly binary: true }, callback: (error?: Error) => void): void;
  terminate(): void;
}

export const shellSocketOpen = 1;

export interface ShellPumpHandle {
  /** Application bytes accepted from the source so far. */
  readonly bytes: number;
  /** Bytes handed to the destination that it has not yet written out. */
  readonly queuedBytes: number;
  /**
   * Names the destination and releases anything accepted before there was one.
   * A pump built without a destination is already reading and already counting
   * against the queue, which is what makes pre-activation bytes bounded.
   */
  start(destination: ShellByteSocket): void;
  stop(): void;
}

/**
 * Moves one direction of a session's bytes, and never more than a bounded
 * amount at a time.
 *
 * Backpressure is the `send` completion callback rather than a `drain` event,
 * because a raw `ws` socket has no `drain`: the queue is what the destination
 * has accepted but not yet written, the source is paused the moment that queue
 * is full, and it is resumed only when a write completes and leaves room. That
 * is what keeps a session whose far end has stopped reading from consuming
 * memory on behalf of every other session on the Host.
 */
export function pumpShellBytes(options: {
  /** Omitted while the other end does not exist yet; supply it to `start`. */
  readonly destination?: ShellByteSocket;
  /** Reports each accepted message, so a session can count its own traffic. */
  readonly onBytes: (bytes: number) => void;
  /** The first thing that made this direction unusable, terminal for the session. */
  readonly onFailure: (error: Error) => void;
  readonly maxMessageBytes?: number;
  readonly maxQueuedBytes?: number;
  readonly source: ShellByteSocket;
}): ShellPumpHandle {
  const maxMessageBytes = options.maxMessageBytes ?? shellDataMessageMaxBytes;
  const maxQueuedBytes = options.maxQueuedBytes ?? shellDataQueueMaxBytes;
  let destination = options.destination ?? null;
  let held: Buffer[] = [];
  let bytes = 0;
  let queuedBytes = 0;
  let paused = false;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    held = [];
    options.source.removeAllListeners("message");
    if (paused) {
      paused = false;
      options.source.resume();
    }
  };
  const fail = (message: string) => {
    if (stopped) return;
    stop();
    options.onFailure(new Error(message));
  };

  /**
   * Pause early enough that one more full-size message still fits under the
   * ceiling. A peer that honours the pause therefore never reaches it, and one
   * that ignores it is refused at exactly the ceiling rather than a message
   * beyond it.
   */
  const applyBackpressure = () => {
    if (!paused && queuedBytes + maxMessageBytes > maxQueuedBytes) {
      paused = true;
      options.source.pause();
      return;
    }
    if (paused && !stopped && queuedBytes + maxMessageBytes <= maxQueuedBytes) {
      paused = false;
      options.source.resume();
    }
  };

  const deliver = (frame: Buffer, open: ShellByteSocket) => {
    open.send(frame, { binary: true }, (error) => {
      queuedBytes -= frame.byteLength;
      if (error) return fail(error.message);
      applyBackpressure();
    });
  };

  options.source.on("message", (data, isBinary) => {
    if (stopped) return;
    if (!isBinary) return fail("A shell session carries binary messages only");
    const frame = rawDataBuffer(data);
    if (frame.byteLength > maxMessageBytes) return fail("A shell session message is too large");
    if (destination && destination.readyState !== shellSocketOpen) {
      return fail("The other end of the shell session is closed");
    }
    // The ceiling is checked against what accepting this frame would make the
    // queue, not against what it already is: a peer that keeps sending through
    // a pause must be refused rather than quietly allowed past the bound.
    if (queuedBytes + frame.byteLength > maxQueuedBytes) {
      return fail("A shell session queued more than its buffer allows");
    }
    bytes += frame.byteLength;
    queuedBytes += frame.byteLength;
    options.onBytes(frame.byteLength);
    applyBackpressure();
    if (destination) deliver(frame, destination);
    else held.push(frame);
  });

  return {
    get bytes() {
      return bytes;
    },
    get queuedBytes() {
      return queuedBytes;
    },
    start: (next) => {
      if (stopped || destination) return;
      destination = next;
      const pending = held;
      held = [];
      for (const frame of pending) {
        if (stopped) return;
        if (next.readyState !== shellSocketOpen) {
          return fail("The other end of the shell session is closed");
        }
        deliver(frame, next);
      }
    },
    stop,
  };
}
