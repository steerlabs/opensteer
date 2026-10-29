import type { OpensteerError } from "@opensteer/core";
import { BoundedEventStream, type PublishOptions } from "./event-stream.js";
import { isHarnessLiveEvent, type HarnessEvent } from "./types.js";

/** The part of a driver's own turn record the terminal-once rule owns. */
export interface PublishedTurn {
  terminal: boolean;
}

/**
 * The bounded stream one harness session publishes its Runs' events on, and
 * the two rules every driver owes that stream.
 *
 * A Run reaches exactly one terminal event. Providers report an end more than
 * once — a completion racing an interrupt, a failure arriving after a turn was
 * already abandoned — and a second terminal event would make the Host record
 * two outcomes for one Run, so the first claim wins and the rest are dropped.
 *
 * A session that can no longer be trusted latches the reason. The first
 * failure is the one that explains what happened; a later one is usually its
 * consequence, so it never overwrites the cause.
 */
export class TurnPublisher {
  readonly events: AsyncIterable<HarnessEvent>;
  readonly #stream: BoundedEventStream<HarnessEvent>;
  #streamClosed = false;
  #unusable: OpensteerError | undefined;

  constructor(options: { readonly maxBytes: number; readonly maxItems: number }) {
    this.#stream = new BoundedEventStream<HarnessEvent>({
      maxBytes: options.maxBytes,
      maxItems: options.maxItems,
    });
    this.events = this.#stream;
  }

  get streamClosed(): boolean {
    return this.#streamClosed;
  }

  /** The first failure that made this session unusable, if one has. */
  get unusable(): OpensteerError | undefined {
    return this.#unusable;
  }

  latchUnusable(error: OpensteerError): void {
    this.#unusable ??= error;
  }

  /**
   * Publishes one event. A stream that overflows or is already closed throws
   * through to the caller, which is the only way a driver learns that events
   * it must deliver are being lost.
   */
  publish(event: HarnessEvent, delivery: PublishOptions["delivery"] = "must-deliver"): void {
    try {
      // Streaming text is progress whatever a driver asked for: the completing
      // durable event carries it whole, so it must never displace that event.
      this.#stream.publish(event, {
        delivery: isHarnessLiveEvent(event) ? "disposable" : delivery,
      });
    } catch (error) {
      // A bounded stream closes itself on a must-deliver overflow, so the
      // session is past publishing whatever raised this.
      this.#streamClosed = true;
      throw error;
    }
  }

  closeStream(error?: unknown): void {
    if (this.#streamClosed) return;
    this.#streamClosed = true;
    this.#stream.close(error);
  }

  /** True only for the caller that ends this turn; every later one gets false. */
  claimTerminal(turn: PublishedTurn): boolean {
    if (turn.terminal) return false;
    turn.terminal = true;
    return true;
  }
}

/**
 * The three events a Run may end on, and the one it starts on, in the exact
 * shapes the Host records. They are built here rather than at each terminal
 * site so two drivers cannot drift on what "this Run finished" looks like;
 * publishing them stays with the driver, which is the only thing that knows
 * what to do when the stream refuses one.
 */
export function runStartedEvent(): HarnessEvent {
  return { data: { status: "running" }, type: "run.started" };
}

export function runEndedEvent(status: "completed" | "interrupted"): HarnessEvent {
  return status === "completed"
    ? { data: { status: "completed" }, type: "run.completed" }
    : { data: { status: "interrupted" }, type: "run.interrupted" };
}

export function runFailedEvent(failure: {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}): HarnessEvent {
  return {
    data: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      status: "failed",
    },
    type: "run.failed",
  };
}
