import {
  appendLiveStreamTail,
  liveAppendTextMaxLength,
  liveProgressMaxItems,
  liveStreamKeyId,
  surrogateSafeCut,
  type LiveItem,
  type LiveStreamKey,
} from "@opensteer/core";

/** Bytes one live frame may carry, well inside the Runner's frame limit. */
const liveFrameMaxBytes = 512 * 1_024;

interface LiveStream {
  readonly key: LiveStreamKey;
  /** Units received but not yet sent. */
  pending: string;
  /** Total units this stream has received, sent or not. */
  length: number;
  /**
   * Unsent text was dropped while the connection was behind, so the next frame
   * replaces the stream whole instead of continuing an offset readers lack.
   */
  resync: boolean;
  /** The newest units of the stream, the same tail a reader keeps. */
  tail: string;
}

export interface LiveProgressBufferOptions {
  /** How long the first unsent text may wait for more before it is sent. */
  readonly flushIntervalMs: number;
  /**
   * Progress handed to sends that have not finished. Past it the buffer stops
   * queueing text behind a slow connection; it keeps only each stream's tail
   * and replaces the stream whole once the connection catches up.
   */
  readonly maxInFlightBytes: number;
  /** Unsent text past which the buffer sends at once rather than waiting. */
  readonly maxPendingBytes: number;
  /**
   * Total progress one Run may send. Past it the Run keeps running and keeps
   * its durable events; readers simply see completions without streaming.
   */
  readonly maxSentBytes: number;
  readonly send: (items: readonly LiveItem[]) => Promise<void>;
}

/**
 * One Run's streaming text between its harness and the Host.
 *
 * Deltas arrive a few characters at a time. Sending each would cost a frame,
 * and on the Host a fan-out, per token, so they are coalesced on a short clock
 * and sent as appends that name the offset they continue. Every send is
 * serialized on one tail so frames leave in the order text arrived, and the
 * Runtime flushes before each durable event of the Run so a completion never
 * overtakes the text it completes.
 */
export class LiveProgressBuffer {
  readonly #options: LiveProgressBufferOptions;
  readonly #streams = new Map<string, LiveStream>();
  #pendingBytes = 0;
  #inFlightBytes = 0;
  #sentBytes = 0;
  #exhausted = false;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: LiveProgressBufferOptions) {
    this.#options = options;
  }

  append(key: LiveStreamKey, text: string): void {
    if (this.#closed || text.length === 0) return;
    const id = liveStreamKeyId(key);
    const stream = this.#streams.get(id) ?? {
      key,
      length: 0,
      pending: "",
      resync: false,
      tail: "",
    };
    this.#streams.set(id, stream);
    stream.length += text.length;
    stream.tail = appendLiveStreamTail(stream.tail, text);
    if (this.#exhausted) return;
    if (!stream.resync) {
      stream.pending += text;
      this.#pendingBytes += Buffer.byteLength(text, "utf8");
    }
    if (this.#pendingBytes >= this.#options.maxPendingBytes) {
      void this.flush().catch(() => undefined);
      return;
    }
    this.#schedule();
  }

  /**
   * Forgets a stream its durable event has completed. The next text for the
   * same key, such as the Run's next answer, starts a new stream at offset 0.
   * Callers flush first, so any unsent text of the old stream has already left.
   */
  complete(key: LiveStreamKey): void {
    const stream = this.#streams.get(liveStreamKeyId(key));
    if (!stream) return;
    this.#pendingBytes -= Buffer.byteLength(stream.pending, "utf8");
    this.#streams.delete(liveStreamKeyId(key));
  }

  /**
   * Sends whatever is unsent, after everything sent before it. A caller that
   * awaits it, such as a durable event about to be sent, waits for all of it.
   */
  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#inFlightBytes >= this.#options.maxInFlightBytes) {
      // The connection is behind. Queueing more text would only grow memory;
      // each stream with unsent text is replaced whole once it catches up.
      for (const stream of this.#streams.values()) {
        if (!stream.pending) continue;
        stream.pending = "";
        stream.resync = true;
      }
      this.#pendingBytes = 0;
      // Once the backlog has gone, send what replaces the dropped text.
      return this.#tail.then(() => this.flush());
    }
    const items = this.#takePending();
    if (items.length === 0) return this.#tail;
    const bytes = items.reduce((total, item) => total + itemBytes(item), 0);
    this.#inFlightBytes += bytes;
    const send = this.#tail
      .then(() => this.#sendBatches(items))
      .finally(() => {
        this.#inFlightBytes -= bytes;
        if (this.#hasUnsent()) this.#schedule();
      });
    this.#tail = send.catch(() => undefined);
    return send;
  }

  /**
   * Every open stream as one `replace` item: what a new connection's reader
   * needs to draw each stream whole, whatever the old connection delivered.
   */
  replacement(): readonly LiveItem[] {
    return [...this.#streams.values()].map((stream) => replaceItem(stream));
  }

  /**
   * States every open stream whole on the next send, as a new connection's
   * readers need: nothing the old connection carried can be assumed received.
   */
  resynchronize(): void {
    if (this.#closed || this.#exhausted) return;
    for (const stream of this.#streams.values()) {
      stream.pending = "";
      stream.resync = true;
    }
    this.#pendingBytes = 0;
    void this.flush().catch(() => undefined);
  }

  /** Stops accepting text and forgets what was not sent. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#streams.clear();
    this.#pendingBytes = 0;
  }

  #schedule(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush().catch(() => undefined);
    }, this.#options.flushIntervalMs);
    this.#timer.unref?.();
  }

  #hasUnsent(): boolean {
    if (this.#closed || this.#exhausted) return false;
    for (const stream of this.#streams.values()) {
      if (stream.resync || stream.pending) return true;
    }
    return false;
  }

  #takePending(): LiveItem[] {
    const items: LiveItem[] = [];
    for (const stream of this.#streams.values()) {
      if (stream.resync) {
        stream.resync = false;
        stream.pending = "";
        items.push(replaceItem(stream));
        continue;
      }
      if (!stream.pending) continue;
      let at = stream.length - stream.pending.length;
      let rest = stream.pending;
      stream.pending = "";
      while (rest.length > 0) {
        const cut =
          rest.length <= liveAppendTextMaxLength
            ? rest.length
            : surrogateSafeCut(rest, liveAppendTextMaxLength);
        const text = rest.slice(0, cut);
        rest = rest.slice(text.length);
        items.push(appendItem(stream.key, at, text));
        at += text.length;
      }
    }
    this.#pendingBytes = 0;
    return items;
  }

  async #sendBatches(items: readonly LiveItem[]): Promise<void> {
    let batch: LiveItem[] = [];
    let batchBytes = 0;
    const sendBatch = async () => {
      if (batch.length === 0) return;
      const sending = batch;
      batch = [];
      batchBytes = 0;
      await this.#options.send(sending);
    };
    for (const item of items) {
      if (this.#exhausted || this.#closed) return;
      const bytes = itemBytes(item);
      if (this.#sentBytes + bytes > this.#options.maxSentBytes) {
        // Streaming stops for the rest of this Run; completions still arrive.
        this.#exhausted = true;
        for (const stream of this.#streams.values()) stream.pending = "";
        this.#pendingBytes = 0;
        await sendBatch();
        return;
      }
      if (
        batch.length > 0 &&
        (batch.length >= liveProgressMaxItems || batchBytes + bytes > liveFrameMaxBytes)
      ) {
        await sendBatch();
      }
      batch.push(item);
      batchBytes += bytes;
      this.#sentBytes += bytes;
    }
    await sendBatch();
  }
}

function appendItem(key: LiveStreamKey, at: number, text: string): LiveItem {
  switch (key.stream) {
    case "assistant":
      return { at, op: "append", stream: "assistant", text };
    case "reasoning":
      return { at, blockId: key.blockId, op: "append", stream: "reasoning", text };
    case "tool":
      return { at, callId: key.callId, op: "append", stream: "tool", text };
  }
}

function replaceItem(stream: LiveStream): LiveItem {
  const { key } = stream;
  switch (key.stream) {
    case "assistant":
      return { length: stream.length, op: "replace", stream: "assistant", text: stream.tail };
    case "reasoning":
      return {
        blockId: key.blockId,
        length: stream.length,
        op: "replace",
        stream: "reasoning",
        text: stream.tail,
      };
    case "tool":
      return {
        callId: key.callId,
        length: stream.length,
        op: "replace",
        stream: "tool",
        text: stream.tail,
      };
  }
}

function itemBytes(item: LiveItem): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}
