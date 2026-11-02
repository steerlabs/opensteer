const minimumBitrate = 400_000;
/** Queueing below this is the path itself; above it, our own frames are waiting. */
const queuedMs = 120;
/** Below this the link has room, so a busy stream may probe upward. */
const clearMs = 40;
const drainGain = 0.85;
/** Long enough that a brief receiver pause cannot erase what the link delivered. */
const bandwidthWindowMs = 2_000;

export interface DisplayLinkRateLimits {
  readonly maximumBitrate: number;
  /** Where an unmeasured link starts, so a cellular viewer is not flooded first. */
  readonly initialBitrate: number;
}

/**
 * One viewer's link, measured from its acknowledgements: the bottleneck rate as
 * BBR measures it (bytes delivered between a frame's send and its ack), the base
 * round trip, and the queue our own frames add on top of it. The cap follows the
 * bottleneck as soon as a queue forms and halves each round trip a queue
 * persists, as after a handover; it probes upward only while the link is clear
 * and the stream actually uses its budget, since a still window proves nothing.
 */
export class DisplayLinkRate {
  cap: number | null;
  readonly limits: DisplayLinkRateLimits;
  #delivered = 0;
  #deliveredAt: number | null = null;
  #sent = new Map<number, { delivered: number; deliveredAt: number; at: number; bytes: number }>();
  #samples: { at: number; bytesPerMs: number }[] = [];
  #sends: { at: number; bytes: number }[] = [];
  #clearMs = 0;
  #lastAck: number | null = null;
  #changedAt = -Infinity;
  #congestedAt = -Infinity;
  /** Only delivered frames prove a queue; a stall may be a paused receiver. */
  #queuedAckAt = -Infinity;
  #clearAt = -Infinity;

  constructor(limits: DisplayLinkRateLimits) {
    this.limits = limits;
    this.cap = limits.initialBitrate;
  }

  /** The link's measured bottleneck in bytes per millisecond, if any. */
  bandwidth(now: number): number | null {
    while (this.#samples[0] && now - this.#samples[0].at > bandwidthWindowMs) this.#samples.shift();
    return this.#samples.length ? Math.max(...this.#samples.map((s) => s.bytesPerMs)) : null;
  }

  /** Bytes in flight that the link can carry within a round trip and a short queue. */
  creditBytes(now: number, baseRttMs: number, ceiling: number): number {
    const rate = Math.min(
      this.bandwidth(now) ?? Infinity,
      this.cap === null ? Infinity : this.cap / 8_000,
    );
    if (!Number.isFinite(rate)) return Math.min(ceiling, 256 * 1_024);
    return Math.min(ceiling, Math.max(64 * 1_024, rate * (baseRttMs + 150)));
  }

  sent(sequence: number, bytes: number, now: number): void {
    this.#sent.set(sequence, {
      delivered: this.#delivered,
      deliveredAt: this.#deliveredAt ?? now,
      at: now,
      bytes,
    });
    this.#sends.push({ at: now, bytes });
    while (this.#sends[0] && now - this.#sends[0].at > 1_000) this.#sends.shift();
  }

  /** A viewer reset discards frames it will never acknowledge. */
  forget(): void {
    this.#sent.clear();
  }

  /** `sequence` and everything sent before it reached the viewer's decoder. */
  ack(sequence: number, now: number, baseRttMs: number): void {
    const frame = this.#sent.get(sequence);
    if (!frame) return;
    for (const [sent, entry] of this.#sent) {
      if (sent > sequence) break;
      this.#delivered += entry.bytes;
      this.#sent.delete(sent);
    }
    this.#deliveredAt = now;
    const elapsed = now - frame.deliveredAt;
    if (elapsed > 0)
      this.#samples.push({ at: now, bytesPerMs: (this.#delivered - frame.delivered) / elapsed });
    const queue = now - frame.at - baseRttMs;
    const gap = this.#lastAck === null ? Infinity : now - this.#lastAck;
    this.#lastAck = now;
    if (queue > queuedMs) this.#congested(now, baseRttMs, true);
    else if (queue < clearMs) {
      this.#clearAt = now;
      this.#clear(now, gap, baseRttMs);
    }
  }

  /** Frames have waited `queueMs` beyond the base round trip with no ack yet. */
  stalled(now: number, queueMs: number, baseRttMs: number): void {
    if (queueMs > queuedMs) this.#congested(now, baseRttMs, false);
  }

  /** Bits per second sent over the last few round trips. */
  #sendRate(now: number, baseRttMs: number): number {
    const span = Math.min(1_000, Math.max(250, 4 * baseRttMs));
    const bytes = this.#sends.reduce((sum, s) => (now - s.at <= span ? sum + s.bytes : sum), 0);
    return (bytes * 8_000) / span;
  }

  #congested(now: number, baseRttMs: number, delivered: boolean): void {
    this.#clearMs = 0;
    // A delivered decision gets one per round trip, since the previous needs
    // that long to show. A stall only ever applies the bandwidth target.
    if (delivered) {
      if (now - this.#congestedAt < Math.max(200, baseRttMs)) return;
      this.#congestedAt = now;
    }
    // Queued deliveries again, with no clear one since: the queue persists. A
    // paused receiver yields stalls and one late burst, then clear frames.
    const persistent = delivered && this.#queuedAckAt > this.#clearAt;
    if (delivered) this.#queuedAckAt = now;
    const bandwidth = this.bandwidth(now);
    let target = bandwidth === null ? Infinity : Math.floor(bandwidth * 8_000 * drainGain);
    if (persistent && this.cap !== null) target = Math.min(target, Math.floor(this.cap / 2));
    if (!Number.isFinite(target)) return;
    target = Math.max(minimumBitrate, target);
    // A burst after a pause reports a high bandwidth, so this never cuts below
    // what the link actually delivered.
    if (this.cap !== null && target >= this.cap) return;
    this.cap = target;
    this.#changedAt = now;
  }

  #clear(now: number, gap: number, baseRttMs: number): void {
    if (this.cap === null) return;
    // Only busy, unqueued flow proves room; silence and a still window do not.
    if (gap > 500 || this.#sendRate(now, baseRttMs) < this.cap * 0.75) return;
    this.#clearMs += gap;
    const fast = baseRttMs < 20;
    if (this.#clearMs < (fast ? 250 : Math.max(500, 4 * baseRttMs))) return;
    const next = this.cap * (fast ? 1.5 : 1.25);
    this.cap = next >= this.limits.maximumBitrate ? null : Math.round(next);
    this.#clearMs = 0;
    this.#changedAt = now;
  }
}
