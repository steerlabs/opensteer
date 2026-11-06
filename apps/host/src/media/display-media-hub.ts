import {
  displayViewerCreditBytes,
  displayViewerCreditFrames,
  displayViewerWindowFrames,
  type DisplayViewerState,
} from "@opensteer/protocol";
import type { DisplayLinkRate } from "@opensteer/shared/displayLinkRate";
import type { WebSocket } from "ws";
export const displayGopCacheBytes = 4 * 1_024 * 1_024;
export const displayGopRefreshBytes = 256 * 1_024;
export const displayGopCacheFrames = 600;
export const displayReplayBudgetMs = 500;
export const macUnmeasuredReplayBytes = 512 * 1_024;
export const displayDeliveryEstimateLifetimeMs = 5_000;

export interface CachedMediaFrame {
  readonly sequence: number;
  readonly bytes: Uint8Array;
}
export interface DisplayMediaViewer {
  readonly displayWindow: boolean;
  readonly link: DisplayLinkRate | null;
  readonly socket: WebSocket | null;
  readonly outstanding: Map<number, { readonly bytes: number; readonly sentAt: number }>;
  readonly discarded: number[];
  readonly ackDelays: { readonly at: number; readonly delay: number }[];
  bytes: number;
  keyframePending: boolean;
  waiting: boolean;
  replayIndex: number | null;
  replayThrough: number | null;
  slowSince: number | null;
  recoverySample: { readonly bytes: number; readonly sentAt: number } | null;
  deliveryEstimate: { readonly bytesPerMs: number; readonly measuredAt: number } | null;
}
export interface DisplayMediaStream<V extends DisplayMediaViewer> {
  readonly target: object | undefined;
  readonly viewers: Set<V>;
  state: DisplayViewerState;
  cache: CachedMediaFrame[];
  cacheBytes: number;
}
/** Media only: the caller admits viewers and fences source incarnations. */
export class DisplayMediaHub<V extends DisplayMediaViewer, S extends DisplayMediaStream<V>> {
  readonly options: {
    now(): number;
    live(stream: S, viewer: V): boolean;
    refresh(stream: S, congestion?: boolean): void;
    state(stream: S, viewer: V, state: DisplayViewerState): void;
    binary(socket: WebSocket, bytes: Uint8Array): void;
    sent?(viewer: V, frame: CachedMediaFrame): void;
  };
  constructor(options: DisplayMediaHub<V, S>["options"]) {
    this.options = options;
  }
  stall(viewer: V): { at: number; oldestAt: number; queued: number } {
    const at = this.options.now();
    const oldest = viewer.outstanding.values().next().value;
    const oldestAt = oldest?.sentAt ?? at;
    viewer.link?.stalled(at, oldestAt);
    return {
      at,
      oldestAt,
      queued: oldest ? Math.max(0, at - oldestAt - (viewer.ackDelays[0]?.delay ?? 400)) : 0,
    };
  }
  resetCredit(viewer: V): void {
    if (
      viewer.discarded.length + viewer.outstanding.size >
      displayGopCacheFrames + displayViewerWindowFrames
    )
      throw new Error("Media decoder resets did not drain.");
    viewer.discarded.push(...viewer.outstanding.keys());
    viewer.outstanding.clear();
    viewer.link?.forget();
    viewer.bytes = 0;
    viewer.recoverySample = null;
    viewer.replayIndex = null;
    viewer.replayThrough = null;
    viewer.waiting = true;
  }
  ack(stream: S, viewer: V, sequence: number): { bytes: number; delay: number } | null {
    if (viewer.discarded.length) {
      if (viewer.discarded[0] === sequence) {
        viewer.discarded.shift();
        viewer.slowSince = null;
        if (viewer.replayIndex !== null) this.drainCache(stream, viewer);
      }
      return null;
    }
    const entry = viewer.outstanding.get(sequence);
    if (!entry) return null;
    const at = this.options.now();
    const delay = at - entry.sentAt;
    while (viewer.ackDelays.at(-1) && viewer.ackDelays.at(-1)!.delay >= delay)
      viewer.ackDelays.pop();
    viewer.ackDelays.push({ at, delay });
    if (viewer.ackDelays.length > displayGopCacheFrames) viewer.ackDelays.shift();
    viewer.link?.ack(sequence, at);
    let bytes = 0;
    for (const [seq, frame] of viewer.outstanding)
      if (seq <= sequence) {
        viewer.outstanding.delete(seq);
        viewer.bytes -= frame.bytes;
        bytes += frame.bytes;
      }
    viewer.slowSince = null;
    if (viewer.waiting && !viewer.outstanding.size) {
      const sample = viewer.recoverySample;
      viewer.recoverySample = null;
      if (sample && at > sample.sentAt)
        viewer.deliveryEstimate = {
          bytesPerMs: sample.bytes / (at - sample.sentAt),
          measuredAt: at,
        };
      if (!this.replay(stream, viewer) && stream.state.state === "live")
        this.options.refresh(stream, true);
    }
    if (viewer.replayIndex !== null) this.drainCache(stream, viewer);
    return { bytes, delay };
  }
  cacheFrame(stream: S, frame: CachedMediaFrame, key: boolean): void {
    if (key) this.clearCache(stream);
    if (!key && !stream.cache.length) return;
    if (
      stream.cacheBytes + frame.bytes.byteLength > displayGopCacheBytes ||
      stream.cache.length >= displayGopCacheFrames
    ) {
      const replaying = [...stream.viewers].filter((v) => v.replayIndex !== null);
      this.clearCache(stream);
      for (const v of replaying) this.skip(stream, v);
      return;
    }
    stream.cache.push(frame);
    stream.cacheBytes += frame.bytes.byteLength;
  }
  offer(
    stream: S,
    viewer: V,
    frame: CachedMediaFrame,
    key: boolean,
    onOffer?: () => void,
  ): "sent" | "waiting" | "stalled" | "replay" {
    if (!this.options.live(stream, viewer)) return "waiting";
    if (viewer.replayIndex !== null) {
      this.drainCache(stream, viewer);
      return "replay";
    }
    if (viewer.waiting && !key) return "waiting";
    if (!this.hasCredit(viewer, frame.bytes.byteLength, false, key)) {
      this.skip(stream, viewer);
      return "stalled";
    }
    if (viewer.waiting) {
      viewer.keyframePending = false;
      viewer.recoverySample = null;
    }
    viewer.waiting = false;
    viewer.slowSince = null;
    onOffer?.();
    this.sendFrame(viewer, frame);
    return "sent";
  }
  clearCache(stream: S): void {
    stream.cache = [];
    stream.cacheBytes = 0;
    for (const viewer of stream.viewers) {
      if (viewer.replayIndex === null) continue;
      viewer.replayIndex = null;
      viewer.replayThrough = null;
      viewer.waiting = true;
    }
  }
  cachedDeltaBytes(stream: S): number {
    return stream.cacheBytes - (stream.cache[0]?.bytes.byteLength ?? 0);
  }
  hasCredit(viewer: V, bytes: number, replay = false, key = false): boolean {
    // A measured link carries what fits a round trip and a short queue; a fixed
    // megabyte is seconds of stale video on a slow one. A key replaces the
    // chain, is rare, and would otherwise only trigger another key.
    const credit = viewer.link
      ? viewer.link.creditBytes(this.options.now(), displayViewerCreditBytes)
      : displayViewerCreditBytes;
    return (
      (replay ||
        (viewer.displayWindow
          ? viewer.outstanding.size < displayViewerWindowFrames && this.withinCreditAge(viewer)
          : viewer.outstanding.size < displayViewerCreditFrames)) &&
      (viewer.outstanding.size === 0 ||
        (key && viewer.link !== null) ||
        viewer.bytes + bytes <= credit)
    );
  }
  withinCreditAge(viewer: V): boolean {
    const now = this.options.now();
    while (viewer.ackDelays[0] && now - viewer.ackDelays[0].at >= 10_000) viewer.ackDelays.shift();
    const oldest = viewer.outstanding.values().next().value;
    // A measured link knows its round trip net of a slow first key's transfer.
    const base = viewer.link ? viewer.link.baseRtt(now) : (viewer.ackDelays[0]?.delay ?? 400);
    return (
      !oldest ||
      now - oldest.sentAt <=
        base + 250 + (viewer.link ? (viewer.bytes * 8000) / (viewer.link.cap ?? 1_000_000) : 0)
    );
  }
  sendFrame(viewer: V, frame: CachedMediaFrame): void {
    viewer.outstanding.set(frame.sequence, {
      bytes: frame.bytes.byteLength,
      sentAt: this.options.now(),
    });
    viewer.link?.sent(frame.sequence, frame.bytes.byteLength, this.options.now());
    viewer.bytes += frame.bytes.byteLength;
    this.options.sent?.(viewer, frame);
    if (viewer.socket) this.options.binary(viewer.socket, frame.bytes);
  }
  skip(stream: S, viewer: V): void {
    // Measure an actual credit stall, not idle time between capture updates.
    // The sample includes network and decoder delay, both of which affect how
    // long this viewer would spend catching up on a cached dependency chain.
    const oldest = viewer.outstanding.values().next().value;
    if (!viewer.recoverySample && oldest)
      viewer.recoverySample = { bytes: viewer.bytes, sentAt: oldest.sentAt };
    viewer.replayIndex = null;
    viewer.replayThrough = null;
    viewer.waiting = true;
    viewer.slowSince ??= this.options.now();
    if (stream.cache.length === 0 && stream.state.state === "live") this.options.refresh(stream);
  }
  replay(stream: S, viewer: V): boolean {
    if (!this.options.live(stream, viewer)) return false;
    const last = stream.cache.at(-1);
    if (!last) return false;
    const estimate = viewer.deliveryEstimate;
    const fresh =
      estimate && this.options.now() - estimate.measuredAt < displayDeliveryEstimateLifetimeMs;
    const budget = fresh
      ? estimate.bytesPerMs * displayReplayBudgetMs
      : stream.target
        ? macUnmeasuredReplayBytes
        : Infinity;
    if (stream.cache.length > 1 && stream.cacheBytes > budget) {
      viewer.slowSince ??= this.options.now();
      return false;
    }
    viewer.recoverySample = null;
    viewer.replayIndex = 0;
    viewer.replayThrough = last.sequence;
    viewer.keyframePending = false;
    viewer.waiting = false;
    this.options.state(stream, viewer, { ...stream.state, replayThrough: last.sequence });
    this.drainCache(stream, viewer);
    return true;
  }
  drainCache(stream: S, viewer: V): void {
    if (viewer.replayIndex === null || !this.options.live(stream, viewer)) return;
    // Indexing visits each cached frame once per replay, independent of ack count.
    while (viewer.replayIndex < stream.cache.length) {
      const frame = stream.cache[viewer.replayIndex]!;
      if (
        !this.hasCredit(viewer, frame.bytes.byteLength, frame.sequence <= viewer.replayThrough!)
      ) {
        viewer.slowSince ??= this.options.now();
        return;
      }
      this.sendFrame(viewer, frame);
      viewer.replayIndex += 1;
      viewer.slowSince = null;
    }
    // Keep the catch-up lane until its deliveries drain. Newly arriving live
    // frames still pay both credits, but wait here rather than causing a skip
    // merely because the preceding replay used more than four frame slots.
    if (viewer.outstanding.size === 0) {
      viewer.replayIndex = null;
      viewer.replayThrough = null;
    }
  }
}
