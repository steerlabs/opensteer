import { DisplayLinkRate, type DisplayLinkRateLimits } from "./displayLinkRate.js";

/** The relay returns source credit only when the Host admitted that exact AU. */
export interface MediaForwarderOptions<A extends { readonly sequence: number }> {
  maxFrames: number;
  maxBytes: number;
  writable(bytes: number): boolean;
  send(bytes: Uint8Array): void;
  admit(ack: A): void;
  failed(): void;
  rate?: DisplayLinkRateLimits;
  now?: () => number;
}
export class MediaForwarder<A extends { readonly sequence: number }> {
  readonly #pending = new Map<number, number>();
  readonly #options: MediaForwarderOptions<A>;
  readonly link: DisplayLinkRate | null;
  #bytes = 0;
  #sequence = -1;
  #closed = false;
  constructor(options: MediaForwarderOptions<A>) {
    this.#options = options;
    this.link = options.rate ? new DisplayLinkRate(options.rate) : null;
  }
  forward(sequence: number, bytes: Uint8Array): boolean {
    if (this.#closed) return false;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence <= this.#sequence ||
      this.#pending.size >= this.#options.maxFrames ||
      this.#bytes + bytes.byteLength > this.#options.maxBytes ||
      !this.#options.writable(bytes.byteLength)
    ) {
      this.#fail();
      return false;
    }
    this.#sequence = sequence;
    this.#pending.set(sequence, bytes.byteLength);
    this.#bytes += bytes.byteLength;
    this.link?.sent(sequence, bytes.byteLength, this.#now());
    try {
      this.#options.send(bytes);
      return true;
    } catch {
      this.#fail();
      return false;
    }
  }
  ack(ack: A): void {
    if (this.#closed) return;
    if (this.#pending.keys().next().value !== ack.sequence) {
      this.#fail();
      return;
    }
    const bytes = this.#pending.get(ack.sequence)!;
    this.#pending.delete(ack.sequence);
    this.#bytes -= bytes;
    this.link?.ack(ack.sequence, this.#now());
    try {
      this.#options.admit(ack);
    } catch {
      this.#fail();
    }
  }
  close(): void {
    this.#closed = true;
    this.#pending.clear();
    this.#bytes = 0;
    this.link?.forget();
  }
  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
  #fail(): void {
    if (this.#closed) return;
    this.close();
    this.#options.failed();
  }
}
