import type { DisplayViewerFrameHeader } from "@opensteer/protocol";
export interface MediaFrame<H extends DisplayViewerFrameHeader = DisplayViewerFrameHeader> {
  readonly connection: number;
  readonly header: H;
  readonly payload: Uint8Array;
  readonly replayed: boolean;
  done(): void;
}
export interface MediaOrder {
  sequence: number;
  generation: number;
  replayRestarts: boolean;
  replayThrough: number | null;
}
export function acceptMediaOrder(state: MediaOrder, header: DisplayViewerFrameHeader): boolean {
  if (
    (header.sequence <= state.sequence && !state.replayRestarts) ||
    header.generation < state.generation
  )
    throw new Error("Media frames arrived out of order.");
  state.replayRestarts = false;
  state.sequence = header.sequence;
  state.generation = header.generation;
  const replayed = state.replayThrough !== null && header.sequence < state.replayThrough;
  if (!replayed) state.replayThrough = null;
  return replayed;
}
/** Each subscriber releases its own bounded work; ACKs leave in receive order. */
export class MediaReceiver<H extends DisplayViewerFrameHeader> {
  readonly #pending: { sequence: number; bytes: number; holders: number }[] = [];
  readonly #ack: (sequence: number) => void;
  #bytes = 0;
  #closed = false;
  constructor(ack: (sequence: number) => void) {
    this.#ack = ack;
  }
  receive(
    connection: number,
    header: H,
    payload: Uint8Array,
    replayed: boolean,
    listeners: readonly ((frame: MediaFrame<H>) => void)[],
  ): void {
    if (this.#closed) return;
    if (this.#pending.length >= 600 || this.#bytes + payload.byteLength > 8 * 1024 * 1024)
      throw new Error("Media decoder admission exceeded its bound.");
    const credit = {
      sequence: header.sequence,
      bytes: payload.byteLength,
      holders: listeners.length,
    };
    this.#pending.push(credit);
    this.#bytes += payload.byteLength;
    for (const listener of listeners) {
      let released = false;
      listener({
        connection,
        header,
        payload,
        replayed,
        done: () => {
          if (released) return;
          released = true;
          credit.holders--;
          this.#drain();
        },
      });
    }
    this.#drain();
  }
  close(): void {
    this.#closed = true;
    this.#pending.length = 0;
    this.#bytes = 0;
  }
  #drain(): void {
    if (this.#closed) return;
    while (this.#pending[0]?.holders === 0) {
      const c = this.#pending.shift()!;
      this.#bytes -= c.bytes;
      this.#ack(c.sequence);
    }
  }
}
