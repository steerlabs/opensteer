const minimumBitrate = 400_000;
const maximumBitrate = 4_000_000;

/** ACKs measure the viewer link, independently of the phone-to-Host link. */
export class DisplayViewerBitrate {
  cap: number | null = null;
  #sampleAt: number | null = null;
  #bytes = 0;
  #delivered = maximumBitrate;
  #lastFlow: number | null = null;
  #healthySince: number | null = null;
  #queuedSince: number | null = null;
  #reducedAt = -Infinity;

  stall(now: number, observedQueueMs = 0): void {
    this.#healthySince = null;
    // A join burst or one delayed decode is not sustained congestion.
    // The delivery has already spent its excess age waiting in the queue.
    this.#queuedSince = Math.min(this.#queuedSince ?? now, now - observedQueueMs);
    if (now - this.#queuedSince < 500) return;
    if (now - this.#reducedAt < 2_000) return;
    const elapsed = now - (this.#sampleAt ?? now);
    // A sample boundary must not discard the preceding measured flow rate.
    const delivered = elapsed >= 500 ? (this.#bytes * 8_000) / elapsed : this.#delivered;
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
      this.#delivered = maximumBitrate;
      this.#healthySince = now;
      this.#queuedSince = null;
    }
    this.#lastFlow = now;
    this.#bytes += bytes;
    if (delay - minimumDelay >= 150) {
      this.stall(now, delay - minimumDelay);
    } else {
      this.#queuedSince = null;
      this.#healthySince ??= now;
    }
    const elapsed = now - (this.#sampleAt ?? now);
    if (elapsed < 2_000) return;
    this.#delivered = (this.#bytes * 8_000) / elapsed;
    if (this.cap !== null && now - (this.#healthySince ?? now) >= 8_000) {
      this.cap = this.cap * 1.2 >= maximumBitrate ? null : Math.round(this.cap * 1.2);
      this.#healthySince = now;
    }
    this.#sampleAt = now;
    this.#bytes = 0;
  }
}
