const minimumBitrate = 400_000;
const maximumBitrate = 4_000_000;

/** ACKs measure the viewer link, independently of the phone-to-Host link. */
export class DisplayViewerBitrate {
  cap: number | null = null;
  #sampleAt: number | null = null;
  #bytes = 0;
  #lastFlow: number | null = null;
  #congestedAt = -Infinity;
  #healthySince: number | null = null;
  #queuedSince: number | null = null;
  #reducedAt = -Infinity;

  stall(now: number): void {
    this.#congestedAt = now;
    this.#healthySince = null;
    if (now - this.#reducedAt < 2_000) return;
    const elapsed = now - (this.#sampleAt ?? now);
    const delivered = elapsed >= 500 ? (this.#bytes * 8_000) / elapsed : maximumBitrate;
    this.cap = Math.max(
      minimumBitrate,
      Math.floor(Math.min((this.cap ?? maximumBitrate) * 0.75, delivered * 0.8)),
    );
    this.#reducedAt = now;
  }

  ack(now: number, bytes: number, delay: number, minimumDelay: number): void {
    // A new burst cannot turn an idle interval into evidence of spare capacity.
    if (this.#lastFlow === null || now - this.#lastFlow > 500) {
      this.#sampleAt = now;
      this.#bytes = 0;
      this.#healthySince = now;
      this.#queuedSince = null;
    }
    this.#lastFlow = now;
    this.#bytes += bytes;
    if (delay - minimumDelay >= 150) {
      this.#healthySince = null;
      this.#queuedSince ??= now;
      if (now - this.#queuedSince >= 500) this.stall(now);
    } else {
      this.#queuedSince = null;
      this.#healthySince ??= now;
    }
    const elapsed = now - (this.#sampleAt ?? now);
    if (elapsed < 2_000) return;
    if (now - this.#congestedAt <= 2_000) {
      this.stall(now);
      this.#healthySince = null;
    } else if (this.cap !== null && now - (this.#healthySince ?? now) >= 8_000) {
      this.cap = this.cap * 1.2 >= maximumBitrate ? null : Math.round(this.cap * 1.2);
      this.#healthySince = now;
    }
    this.#sampleAt = now;
    this.#bytes = 0;
  }
}
