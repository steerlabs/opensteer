/** A Mac window can still show sharp, sparse frames on an EDGE-class link. */
const minimumBitrate = 150_000;
/** Queueing below this is the path itself; above it, our own frames are waiting. */
const queuedMs = 120;
/** Below this the link has room, so a busy stream may probe upward. */
const clearMs = 40;
const drainGain = 0.85;
/** Long enough that a brief receiver pause cannot erase what the link delivered. */
const bandwidthWindowMs = 2_000;
const baseRttWindowMs = 10_000;
/** A frame this small crosses any usable link in a few milliseconds. */
const smallFrameBytes = 4 * 1_024;

export interface DisplayLinkRateLimits {
  readonly maximumBitrate: number;
  /** Where an unmeasured link starts, so a cellular viewer is not flooded first. */
  readonly initialBitrate: number;
}

/** Starts at the original fixed rate, so a first key is no larger than before. */
export const macLinkRate: DisplayLinkRateLimits = {
  maximumBitrate: 20_000_000,
  initialBitrate: 2_500_000,
};

/**
 * One viewer's link, measured from its acknowledgements: the bottleneck as BBR
 * measures it (bytes delivered between a frame's send and its ack), the base
 * round trip net of each frame's own transfer, and the queue our frames add.
 *
 * When a queue forms the cap drops below what the link delivers now, so it
 * follows a handover within a round trip or two. A paused receiver looks the
 * same at first, but its backlog then arrives as a burst that no network
 * produces, which restores the cap. It probes upward only while the link is
 * clear and the stream is busy; a still window proves nothing.
 */
export class DisplayLinkRate {
  cap: number | null;
  readonly limits: DisplayLinkRateLimits;
  #delivered = 0;
  #deliveredAt: number | null = null;
  #sent = new Map<
    number,
    {
      delivered: number;
      deliveredAt: number | null;
      at: number;
      bytes: number;
      /** Bytes per millisecond we were sending at the time. */
      sending: number;
    }
  >();
  #samples: { at: number; bytesPerMs: number }[] = [];
  #latest: number | null = null;
  #rtts: { at: number; ms: number }[] = [];
  #sends: { at: number; bytes: number }[] = [];
  #clearMs = 0;
  #lastAck: number | null = null;
  #lastAckedSentAt: number | null = null;
  #decidedAt = -Infinity;
  /** The cap before the latest cut, until acks show whether the link caused it. */
  #beforeCut: number | null | undefined;
  /** Frames sent before this were a paused receiver's backlog. */
  #backlogBefore = -Infinity;
  #queuedSince: number | null = null;

  constructor(limits: DisplayLinkRateLimits) {
    this.limits = limits;
    this.cap = limits.initialBitrate;
  }

  /** The link's recent bottleneck in bytes per millisecond, if measured. */
  bandwidth(now: number): number | null {
    while (this.#samples[0] && now - this.#samples[0].at > bandwidthWindowMs) this.#samples.shift();
    return this.#samples.length ? Math.max(...this.#samples.map((s) => s.bytesPerMs)) : null;
  }

  /**
   * The path's round trip, from small frames alone: a first key over a slow link
   * takes seconds to arrive, and counting that as the path would hide every
   * queue behind it. Screen content sends small frames whenever it is still or
   * barely changing; through long motion the last measurement stands.
   */
  baseRtt(now: number): number {
    while (this.#rtts.length > 1 && now - this.#rtts[0]!.at > baseRttWindowMs) this.#rtts.shift();
    return this.#rtts.length ? Math.min(...this.#rtts.map((r) => r.ms)) : 400;
  }

  /**
   * Bytes in flight the link carries, as BBR bounds them: twice its round trip
   * of delivery plus a short allowance. The latest delivery bounds a stale
   * maximum, so a handover to a slow link stops filling it at once.
   */
  creditBytes(now: number, ceiling: number): number {
    const bandwidth = this.bandwidth(now);
    if (bandwidth === null) return Math.min(ceiling, 128 * 1_024);
    const rate = Math.min(bandwidth, 2 * (this.#latest ?? bandwidth));
    return Math.min(ceiling, Math.max(64 * 1_024, rate * (2 * this.baseRtt(now) + 100)));
  }

  sent(sequence: number, bytes: number, now: number): void {
    this.#sends.push({ at: now, bytes });
    while (this.#sends[0] && now - this.#sends[0].at > 1_000) this.#sends.shift();
    this.#sent.set(sequence, {
      delivered: this.#delivered,
      deliveredAt: this.#deliveredAt,
      at: now,
      bytes,
      sending: this.#sendRate(now) / 8_000,
    });
  }

  /** A viewer reset discards frames it will never acknowledge. */
  forget(): void {
    this.#sent.clear();
  }

  /** `sequence` and everything sent before it reached the viewer's decoder. */
  ack(sequence: number, now: number): void {
    const frame = this.#sent.get(sequence);
    if (!frame) return;
    const delivered = this.#delivered;
    for (const [sent, entry] of this.#sent) {
      if (sent > sequence) break;
      this.#delivered += entry.bytes;
      this.#sent.delete(sent);
    }
    const previous = this.#deliveredAt;
    this.#deliveredAt = now;
    // Delivered between this frame's send and its ack. A frame sent before any
    // ack would measure the first round trip, so it measures from the previous
    // ack instead: while the link is busy, ack spacing is its rate.
    const since = frame.deliveredAt ?? previous;
    const base = frame.deliveredAt === null ? delivered : frame.delivered;
    let sample: number | null = null;
    if (since !== null && now > since) {
      sample = (this.#delivered - base) / (now - since);
      this.#samples.push({ at: now, bytesPerMs: sample });
      this.#latest = sample;
    }
    if (frame.bytes <= smallFrameBytes) this.#rtts.push({ at: now, ms: now - frame.at });
    const gap = this.#lastAck === null ? 0 : now - this.#lastAck;
    const sentGap = this.#lastAckedSentAt === null ? 0 : frame.at - this.#lastAckedSentAt;
    this.#lastAck = now;
    this.#lastAckedSentAt = frame.at;
    // Near-instant acks for frames sent well apart: a receiver catching up after
    // a pause, which no network produces. Its cut was not the link's.
    if (this.#beforeCut !== undefined && gap < Math.min(5, sentGap / 4)) {
      this.cap = this.#beforeCut;
      this.#beforeCut = undefined;
      this.#backlogBefore = now;
      return;
    }
    const baseRtt = this.baseRtt(now);
    const queue = now - frame.at - baseRtt;
    if (queue > queuedMs && frame.at >= this.#backlogBefore) {
      this.#clearMs = 0;
      this.#queuedSince ??= now;
      // The link is at fault when it delivered clearly less than we were
      // sending, or when the queue outlasts a few round trips: a still window
      // sends little, and a key's own transfer or a receiver's jitter queues only
      // briefly. A silence after a handover and a paused receiver look alike
      // here; taking both at their word costs a paused receiver a dip its burst
      // undoes, while ignoring a handover would cost seconds of stale video.
      const persistent = now - this.#queuedSince >= Math.max(500, 3 * baseRtt);
      if (sample !== null && (persistent || sample < frame.sending * 0.9)) this.#cut(now, sample);
    } else if (queue < clearMs) {
      this.#queuedSince = null;
      this.#beforeCut = undefined;
      this.#clear(now, gap);
    }
  }

  /** The oldest unacknowledged frame, sent at `oldestSentAt`, is still waiting. */
  stalled(now: number, oldestSentAt: number): void {
    if (now - oldestSentAt - this.baseRtt(now) <= queuedMs) return;
    this.#clearMs = 0;
    this.#cut(now, null);
  }

  /** Bits per second sent over the last few round trips. */
  #sendRate(now: number): number {
    const span = Math.min(1_000, Math.max(250, 4 * this.baseRtt(now)));
    const bytes = this.#sends.reduce((sum, s) => (now - s.at <= span ? sum + s.bytes : sum), 0);
    return (bytes * 8_000) / span;
  }

  /** Drops the cap below `delivering` bytes/ms, or the recent maximum without one. */
  #cut(now: number, delivering: number | null): void {
    // One cut per round trip: the previous one needs that long to show.
    if (now - this.#decidedAt < Math.max(200, this.baseRtt(now))) return;
    const rate = delivering ?? this.bandwidth(now);
    if (rate === null) return;
    const target = Math.max(minimumBitrate, Math.floor(rate * 8_000 * drainGain));
    if (this.cap !== null && target >= this.cap) return;
    this.#beforeCut ??= this.cap;
    this.cap = target;
    this.#decidedAt = now;
  }

  #clear(now: number, gap: number): void {
    if (this.cap === null) return;
    // Only busy, unqueued flow proves room; silence and a still window do not.
    if (gap > 500 || this.#sendRate(now) < this.cap * 0.75) return;
    this.#clearMs += gap;
    const baseRtt = this.baseRtt(now);
    const fast = baseRtt < 20;
    if (this.#clearMs < (fast ? 250 : Math.max(500, 4 * baseRtt))) return;
    // A clean low-latency link doubles, as slow start does; others step carefully.
    const next = this.cap * (fast ? 2 : 1.25);
    this.cap = next >= this.limits.maximumBitrate ? null : Math.round(next);
    this.#clearMs = 0;
    this.#decidedAt = now;
    this.#beforeCut = undefined;
  }
}
