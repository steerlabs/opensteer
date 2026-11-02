const minimumBitrate = 400_000;

/** How far a platform's encoder may go and how quickly a cap recovers. */
export interface DisplayViewerBitrateLimits {
  readonly maximumBitrate: number;
  /** Active, unqueued flow that proves room for one step up. */
  readonly recoverAfterMs: number;
  readonly recoverFactor: number;
}

export const phoneViewerBitrate: DisplayViewerBitrateLimits = {
  maximumBitrate: 4_000_000,
  recoverAfterMs: 8_000,
  recoverFactor: 1.2,
};
/** A Mac window's low-latency encoder tracks its target closely, so it can probe faster. */
export const macViewerBitrate: DisplayViewerBitrateLimits = {
  maximumBitrate: 20_000_000,
  recoverAfterMs: 3_000,
  recoverFactor: 1.5,
};

/** ACKs measure the viewer link, independently of the producer-to-Host link. */
export class DisplayViewerBitrate {
  cap: number | null = null;
  readonly limits: DisplayViewerBitrateLimits;
  #sampleAt: number | null = null;
  #bytes = 0;
  #delivered: number;
  #lastFlow: number | null = null;
  /** Unqueued flow since the last change. Idle gaps neither add nor reset it. */
  #healthyMs = 0;
  #queue: { since: number; observedAt: number } | null = null;
  #reducedAt = -Infinity;

  constructor(limits: DisplayViewerBitrateLimits = phoneViewerBitrate) {
    this.limits = limits;
    this.#delivered = limits.maximumBitrate;
  }

  stall(now: number, observedQueueMs: number, sentAt: number): void {
    if (observedQueueMs < 150) return;
    this.#healthyMs = 0;
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
      Math.floor(Math.min((this.cap ?? this.limits.maximumBitrate) * 0.75, delivered * 0.8)),
    );
    this.#reducedAt = now;
  }

  ack(now: number, bytes: number, delay: number, minimumDelay: number): void {
    const gap = this.#lastFlow === null ? Infinity : now - this.#lastFlow;
    // Queued ACK gaps must retain measured flow; a new idle burst cannot prove capacity.
    if (this.#lastFlow === null || (gap > 500 && this.#queue === null)) {
      this.#sampleAt = now;
      this.#bytes = 0;
      this.#delivered = this.limits.maximumBitrate;
    }
    this.#lastFlow = now;
    this.#bytes += bytes;
    if (delay - minimumDelay >= 150) {
      this.stall(now, delay - minimumDelay, now - delay);
    } else {
      this.#queue = null;
      // Intermittent scrolling accumulates proof across bursts; silence adds none.
      if (gap <= 500) this.#healthyMs += gap;
    }
    if (this.cap !== null && this.#healthyMs >= this.limits.recoverAfterMs) {
      const next = this.cap * this.limits.recoverFactor;
      this.cap = next >= this.limits.maximumBitrate ? null : Math.round(next);
      this.#healthyMs = 0;
    }
    const elapsed = now - (this.#sampleAt ?? now);
    if (elapsed < 2_000) return;
    this.#delivered = (this.#bytes * 8_000) / elapsed;
    this.#sampleAt = now;
    this.#bytes = 0;
  }
}
