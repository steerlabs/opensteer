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
  #queue: { since: number; observedAt: number } | null = null;
  #reducedAt = -Infinity;

  stall(now: number, observedQueueMs: number, sentAt: number): void {
    if (observedQueueMs < 150) return;
    this.#healthySince = null;
    // Count time already queued, but require a delivery sent after the first
    // excess observation. One receiver pause and its late ACK burst cannot confirm it.
    this.#queue ??= { since: now - observedQueueMs, observedAt: now };
    this.#queue.since = Math.min(this.#queue.since, now - observedQueueMs);
    if (sentAt <= this.#queue.observedAt || now - this.#queue.since < 500) return;
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
    // Queued ACK gaps must retain measured flow; a new idle burst cannot prove capacity.
    if (this.#lastFlow === null || (now - this.#lastFlow > 500 && this.#queue === null)) {
      this.#sampleAt = now;
      this.#bytes = 0;
      this.#delivered = maximumBitrate;
      this.#healthySince = now;
    }
    this.#lastFlow = now;
    this.#bytes += bytes;
    if (delay - minimumDelay >= 150) {
      this.stall(now, delay - minimumDelay, now - delay);
    } else {
      this.#queue = null;
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
