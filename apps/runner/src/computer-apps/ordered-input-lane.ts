import type { DisplayInputEvent } from "@opensteer/protocol";

/** One queued batch of a stream's input, from one viewer source. */
export interface OrderedInputBatch<T> {
  /** The viewer source it came from: a reset for that source answers its queued batches. */
  readonly source: string;
  /** Its size in UTF-8 bytes, as `inputBytes` counts it. */
  readonly bytes: number;
  readonly value: T;
  /** Every event in it lets go of something held (`releaseOnly`): it has the reserved room. */
  readonly release?: boolean;
}

export interface OrderedInputLaneOptions<T> {
  readonly maxBatches: number;
  readonly maxBytes: number;
  /** The room reserved for releases beyond the ordinary bound, itself a bound. */
  readonly maxReleaseBatches: number;
  readonly maxReleaseBytes: number;
  /** A batch that waited longer than this is never sent (a release still is). */
  readonly maxAgeMs: number;
  readonly now?: () => number;
  /** Sends one batch and answers it, refused included; settles when it is answered. */
  readonly send: (value: T) => Promise<void>;
  readonly interruptOnReset?: boolean;
  readonly reset: (source: string) => Promise<void>;
  /** Answers a batch that never reached the helper. */
  readonly notSent: (value: T, expired?: true) => void;
}

/** Whether every event in a batch lets go of something held: a release has reserved room. */
export function releaseOnly(events: readonly DisplayInputEvent[]): boolean {
  return (
    events.length > 0 &&
    events.every((event) =>
      event.kind === "pointer" || event.kind === "mouse"
        ? event.phase === "up" || event.phase === "cancel"
        : event.kind === "key" && event.action === "up",
    )
  );
}

/** A batch's size as it is sent: UTF-8 bytes of its events. */
export function inputBytes(events: readonly DisplayInputEvent[]): number {
  return Buffer.byteLength(JSON.stringify(events), "utf8");
}

type Queued<T> =
  | { readonly kind: "input"; readonly batch: OrderedInputBatch<T>; readonly arrived: number }
  | { readonly kind: "reset"; readonly source: string; readonly started?: Promise<void> };

/**
 * Relays one stream's input to the Mac's helper one batch at a time, in arrival order. The
 * helper admits four batches a stream and refuses the rest, and batches relayed together can
 * reach it out of order; it handles them one by one anyway, so one in flight costs only the
 * local round trip. Every batch keeps its own answer: `send` answers it as the helper did, and
 * a batch that never left is answered by `notSent`.
 *
 * Bounds: an ordinary batch is refused when the lane is full, without being sent, as the
 * helper's own full lane refuses it. A batch of releases only has a reserved room beyond that,
 * itself bounded; a stream whose releases overflow even that is not taking input honestly any
 * more: the lane takes no more input for it, answers what is queued not-sent, and sends one
 * reset so the Mac lets go of everything held. A batch that waited longer than the client's
 * own give-up is never sent, unless it is a release: letting go is always safe.
 */
export class OrderedInputLane<T> {
  readonly #options: OrderedInputLaneOptions<T>;
  readonly #now: () => number;
  readonly #queue: Queued<T>[] = [];
  #batches = 0;
  #bytes = 0;
  #running = false;
  #ended = false;

  constructor(options: OrderedInputLaneOptions<T>) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Whether anything is with the helper or waiting for it. */
  get busy(): boolean {
    return this.#running || this.#queue.length > 0;
  }

  /** Queues a batch behind those before it; false when it is refused without being sent. */
  input(batch: OrderedInputBatch<T>): boolean {
    if (this.#ended) return false;
    const { maxBatches, maxBytes, maxReleaseBatches, maxReleaseBytes } = this.#options;
    const fits = (batches: number, bytes: number) =>
      this.#batches < batches && this.#bytes + batch.bytes <= bytes;
    if (!fits(maxBatches, maxBytes)) {
      if (!batch.release) return false;
      if (!fits(maxBatches + maxReleaseBatches, maxBytes + maxReleaseBytes)) {
        this.#overflow(batch.source);
        return false;
      }
    }
    this.#queue.push({ kind: "input", batch, arrived: this.#now() });
    this.#batches++;
    this.#bytes += batch.bytes;
    void this.#pump();
    return true;
  }

  /** The source lets go: what it still has queued never leaves, and the reset can interrupt the batch in flight. */
  reset(source: string): void {
    if (this.#ended) return;
    if (!this.#queue.some((entry) => entry.kind === "reset" && entry.source === source))
      this.#queueReset(source);
    this.#answerQueued((batch) => batch.source === source);
    void this.#pump();
  }

  /** The stream ended: nothing queued leaves; the batch in flight keeps its own answer. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#answerQueued(() => true);
    this.#queue.length = 0;
  }

  /** Releases overflowed their reserved room: no more input; one reset lets go of all of it. */
  #overflow(source: string): void {
    // Ended first: an answer that queues more input is refused.
    this.#ended = true;
    this.#answerQueued(() => true);
    this.#queue.length = 0;
    this.#queueReset(source);
    void this.#pump();
  }

  #queueReset(source: string): void {
    const started = this.#options.interruptOnReset
      ? Promise.resolve()
          .then(() => this.#options.reset(source))
          .catch(() => undefined)
      : undefined;
    this.#queue.push({ kind: "reset", source, ...(started && { started }) });
  }

  #answerQueued(matches: (batch: OrderedInputBatch<T>) => boolean): void {
    const answered: OrderedInputBatch<T>[] = [];
    for (let index = 0; index < this.#queue.length;) {
      const entry = this.#queue[index]!;
      if (entry.kind === "input" && matches(entry.batch)) {
        this.#queue.splice(index, 1);
        this.#take(entry.batch);
        answered.push(entry.batch);
      } else index++;
    }
    // Answers may queue more input: they run once the queue is settled.
    for (const batch of answered) this.#options.notSent(batch.value);
  }

  #take(batch: OrderedInputBatch<T>): void {
    this.#batches--;
    this.#bytes -= batch.bytes;
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
        if (next.kind === "reset") {
          await (next.started ?? this.#options.reset(next.source)).catch(() => undefined);
          continue;
        }
        this.#take(next.batch);
        if (!next.batch.release && this.#now() - next.arrived > this.#options.maxAgeMs)
          this.#options.notSent(next.batch.value, true);
        else await this.#options.send(next.batch.value).catch(() => undefined);
      }
    } finally {
      this.#running = false;
    }
  }
}
