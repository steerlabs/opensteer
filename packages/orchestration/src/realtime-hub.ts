import {
  compareSequence,
  OpensteerError,
  zeroSequence,
  type AgentEvent,
  type AuthSessionId,
  type Sequence,
  type UserId,
  type WorkspaceId,
  type ThreadId,
  type ThreadReadState,
  type WorkspaceNotificationPreference,
} from "@opensteer/core";
import { OpensteerStore } from "@opensteer/database";
import { type HostToClientMessage } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { LiveFrame, LiveRunRegistry } from "./live-run-registry.js";

export interface RealtimeSink {
  readonly id: string;
  send(message: HostToClientMessage): Promise<void>;
  close(code: number, reason: string): void;
}

interface RealtimeHubOptions {
  /** How long a hole in published delivery may wait before it is read from the store. */
  readonly gapFillDelayMs?: number;
  /**
   * How long that read may take. A live subscriber holds every later event
   * behind the hole, and its socket stays open and answers probes meanwhile,
   * so a read that never returns would stop delivery with nothing to show it.
   */
  readonly gapFillTimeoutMs?: number;
  /** Open streams sent to a subscriber when it goes live. */
  readonly liveRuns?: Pick<LiveRunRegistry, "workspaceFrames">;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedEvents?: number;
  /** Live progress one subscriber may hold or have in flight before it drops some. */
  readonly maxLiveBytes?: number;
  readonly maxReplayEvents?: number;
  readonly maxReplayBytes?: number;
  readonly maxWireBytes?: number;
  readonly store: OpensteerStore;
}

type SubscriberState = "synchronizing" | "live" | "closed";

/**
 * A list notice: "this list changed, read it again", or "these conversations'
 * browser usage changed". Browser catalogs follow the viewer; usage and
 * Triggers follow the Workspace. Two of them arriving while a
 * subscriber is still synchronizing say what one says — usage notices merge
 * the conversations they name — so they collapse by type and are sent once
 * the event backlog has drained and the reread would see the rows the Host
 * holds.
 */
type WorkspaceNotice = Extract<
  HostToClientMessage,
  {
    readonly type:
      "host.browser-sessions-changed" | "host.browser-usage-changed" | "host.triggers-changed";
  }
>;

function isWorkspaceNotice(message: HostToClientMessage): message is WorkspaceNotice {
  return (
    message.type === "host.browser-sessions-changed" ||
    message.type === "host.browser-usage-changed" ||
    message.type === "host.triggers-changed"
  );
}

/** The most conversations one usage notice names; more go in further notices. */
const usageNoticeThreadLimit = 100;

function mergeWorkspaceNotices(
  held: WorkspaceNotice | undefined,
  next: WorkspaceNotice,
): WorkspaceNotice {
  if (held?.type !== "host.browser-usage-changed" || next.type !== "host.browser-usage-changed") {
    return next;
  }
  return { ...next, threadIds: [...new Set([...held.threadIds, ...next.threadIds])] };
}

/** One notice as it goes on the wire, split where it names too many conversations. */
function wireNotices(notice: WorkspaceNotice): readonly WorkspaceNotice[] {
  if (notice.type !== "host.browser-usage-changed") return [notice];
  const notices: WorkspaceNotice[] = [];
  for (let index = 0; index < notice.threadIds.length; index += usageNoticeThreadLimit) {
    notices.push({
      ...notice,
      threadIds: notice.threadIds.slice(index, index + usageNoticeThreadLimit),
    });
  }
  return notices;
}

/** A window of committed events read to fill a hole in published delivery. */
export interface RealtimeFillWindow {
  readonly events: readonly AgentEvent[];
  readonly hasMore: boolean;
  readonly scannedThrough: Sequence;
}

interface SubscriberOptions {
  readonly cursor: Sequence;
  readonly fill: (after: Sequence, through: Sequence) => Promise<RealtimeFillWindow>;
  readonly gapFillDelayMs: number;
  readonly gapFillTimeoutMs: number;
  readonly liveFrames: () => readonly LiveFrame[];
  readonly maxBufferedBytes: number;
  readonly maxBufferedEvents: number;
  readonly maxLiveBytes: number;
  readonly maxWireBytes: number;
  readonly onClose: () => void;
  readonly sink: RealtimeSink;
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

/**
 * One client's view of one Workspace's durable stream, plus the live progress
 * that rides on it.
 *
 * Durable events reach the sink strictly in sequence order. Publications come
 * from many transactions and can arrive out of order, so a live subscriber
 * holds an early arrival until the events before it are sent; a hole that
 * publication does not fill within `gapFillDelayMs` is read from the store,
 * which is authoritative because a sequence is published only after every
 * lower one has committed. A client drops anything at or below its cursor, so
 * sending one event early would lose the ones it overtook.
 *
 * Live progress is sent only once every durable event it follows has been
 * handed to the sink. It is never buffered across synchronization: a
 * subscriber that goes live sends the Workspace's open streams whole instead.
 */
class Subscriber {
  readonly sink: RealtimeSink;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly #options: SubscriberOptions;
  readonly #syncBuffer: AgentEvent[] = [];
  readonly #syncNotices = new Map<WorkspaceNotice["type"], WorkspaceNotice>();
  readonly #syncViewerMessages: HostToClientMessage[] = [];
  readonly #pending = new Map<string, { readonly bytes: number; readonly event: AgentEvent }>();
  readonly #pendingLive: {
    readonly bytes: number;
    readonly frame: LiveFrame;
    readonly replacement: boolean;
  }[] = [];
  #viewerBufferedBytes = 0;
  #syncBufferedBytes = 0;
  #pendingBytes = 0;
  #pendingLiveBytes = 0;
  #queuedEvents = 0;
  #queuedBytes = 0;
  #liveInFlightBytes = 0;
  #sendTail: Promise<void> = Promise.resolve();
  #state: SubscriberState = "synchronizing";
  /** The highest sequence handed to the sink, in order. */
  #queuedThrough: Sequence;
  #gapTimer: ReturnType<typeof setTimeout> | undefined;
  #filling = false;

  constructor(options: SubscriberOptions) {
    this.#options = options;
    this.#queuedThrough = options.cursor;
    this.sink = options.sink;
    this.userId = options.userId;
    this.workspaceId = options.workspaceId;
  }

  offer(event: AgentEvent): void {
    if (this.#state === "closed" || compareSequence(event.sequence, this.#queuedThrough) <= 0) {
      return;
    }
    if (this.#state === "synchronizing") {
      const bytes = eventBytes(event);
      if (
        this.#syncBuffer.length >= this.#options.maxBufferedEvents ||
        this.#syncBufferedBytes + bytes > this.#options.maxBufferedBytes
      ) {
        this.resync("buffer-overflow");
        return;
      }
      this.#syncBuffer.push(event);
      this.#syncBufferedBytes += bytes;
      return;
    }
    if (!this.#hold(event)) return;
    this.#drain();
  }

  offerLive(frame: LiveFrame): void {
    // A synchronizing subscriber is sent every open stream whole when it goes
    // live, which supersedes any progress it would have buffered meanwhile.
    if (this.#state !== "live") return;
    this.#offerLiveFrame(frame, false);
  }

  /**
   * `replacement` frames carry streams whole to a subscriber that just went
   * live. Nothing will repeat them, so they are never dropped for the live
   * budget; the send chain paces them one after another instead.
   */
  #offerLiveFrame(frame: LiveFrame, replacement: boolean): void {
    const bytes = liveFrameBytes(frame);
    if (compareSequence(frame.afterSequence, this.#queuedThrough) <= 0) {
      this.#sendLive(frame, bytes, replacement);
      return;
    }
    if (!replacement && this.#pendingLiveBytes + bytes > this.#options.maxLiveBytes) {
      // Dropping progress costs this reader streaming text, never correctness:
      // the next append names an offset the reader lacks, and it rereads.
      return;
    }
    this.#pendingLive.push({ bytes, frame, replacement });
    this.#pendingLiveBytes += bytes;
  }

  async synchronize(
    messages: readonly HostToClientMessage[],
    cursor: Sequence,
    viewerSnapshot: () => Promise<void>,
  ): Promise<void> {
    for (const message of messages) await this.sink.send(message);
    this.#queuedThrough = cursor;
    await viewerSnapshot();
    while (this.#state === "synchronizing") {
      for (const event of this.#syncBuffer.splice(0)) {
        if (compareSequence(event.sequence, this.#queuedThrough) > 0 && !this.#hold(event)) return;
      }
      this.#syncBufferedBytes = 0;
      const batch = this.#takeContiguous();
      if (batch.length > 0) {
        for (const events of boundedEventBatches(batch, this.#options.maxWireBytes)) {
          await this.sink.send({ events, type: "host.events" });
        }
        continue;
      }
      const pending = this.#syncNotices.values().next();
      if (!pending.done) {
        this.#syncNotices.delete(pending.value.type);
        for (const notice of wireNotices(pending.value)) await this.sink.send(notice);
        continue;
      }
      const viewerMessage = this.#syncViewerMessages.shift();
      if (viewerMessage) {
        this.#viewerBufferedBytes -= Buffer.byteLength(JSON.stringify(viewerMessage));
        await this.sink.send(viewerMessage);
        continue;
      }
      this.#sendTail = this.sink.send({
        type: "host.synchronized",
        workspaceId: this.workspaceId,
        sequence: this.#queuedThrough,
      });
      // Going live and reading the open streams happen in one synchronous
      // step, so no progress can fall between the replacement and the appends.
      this.#state = "live";
      for (const frame of this.#options.liveFrames()) this.#offerLiveFrame(frame, true);
      this.#drain();
      await this.#sendTail;
      return;
    }
  }

  resync(reason: "cursor-ahead" | "cursor-expired" | "slow-consumer" | "buffer-overflow"): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#clearGapTimer();
    void this.sink
      .send({
        reason,
        type: "host.resync-required",
        workspaceId: this.workspaceId,
      })
      .finally(() => this.sink.close(4009, "resync required"));
    this.#options.onClose();
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#clearGapTimer();
    this.#options.onClose();
  }

  #failDelivery(): void {
    if (this.#state === "closed") return;
    this.close();
    this.sink.close(1011, "Workspace delivery failed");
  }

  enqueueMessage(message: HostToClientMessage): void {
    if (this.#state === "synchronizing") {
      if (isWorkspaceNotice(message))
        this.#syncNotices.set(
          message.type,
          mergeWorkspaceNotices(this.#syncNotices.get(message.type), message),
        );
      else if (
        message.type === "host.read-states" ||
        message.type === "host.read-markers" ||
        message.type === "host.notification-preferences"
      ) {
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (
          this.#viewerBufferedBytes + bytes > this.#options.maxBufferedBytes ||
          this.#syncViewerMessages.length >= this.#options.maxBufferedEvents
        ) {
          this.resync("buffer-overflow");
          return;
        }
        this.#viewerBufferedBytes += bytes;
        this.#syncViewerMessages.push(message);
      }
      return;
    }
    if (this.#state !== "live") return;
    this.#sendTail = this.#sendTail
      .then(() => (this.#state === "live" ? this.sink.send(message) : undefined))
      .catch(() => this.#failDelivery());
  }

  /** Holds one event for ordered delivery; false when the bound was exceeded. */
  #hold(event: AgentEvent): boolean {
    if (this.#pending.has(event.sequence)) return true;
    const bytes = eventBytes(event);
    if (
      this.#pending.size >= this.#options.maxBufferedEvents ||
      this.#pendingBytes + bytes > this.#options.maxBufferedBytes
    ) {
      this.resync(this.#state === "synchronizing" ? "buffer-overflow" : "slow-consumer");
      return false;
    }
    this.#pending.set(event.sequence, { bytes, event });
    this.#pendingBytes += bytes;
    return true;
  }

  /**
   * Drops held events the store read already sent. A publication that lands
   * while its hole is being read is held and also returned by the read; left
   * behind, it would look like the lowest pending event forever.
   */
  #discardDelivered(): void {
    for (const [sequence, held] of this.#pending) {
      if (compareSequence(sequence as Sequence, this.#queuedThrough) > 0) continue;
      this.#pending.delete(sequence);
      this.#pendingBytes -= held.bytes;
    }
  }

  /** Removes and returns the held events that continue the delivered stream. */
  #takeContiguous(): AgentEvent[] {
    const batch: AgentEvent[] = [];
    for (;;) {
      const next = nextSequence(this.#queuedThrough);
      const held = this.#pending.get(next);
      if (!held) return batch;
      this.#pending.delete(next);
      this.#pendingBytes -= held.bytes;
      batch.push(held.event);
      this.#queuedThrough = next;
    }
  }

  #drain(): void {
    if (this.#state !== "live") return;
    const batch = this.#takeContiguous();
    if (batch.length > 0) this.#sendEvents(batch);
    this.#releaseLive();
    this.#scheduleGapFill();
  }

  #sendEvents(events: readonly AgentEvent[]): void {
    const bytes = events.reduce((total, event) => total + eventBytes(event), 0);
    if (
      this.#queuedEvents + events.length > this.#options.maxBufferedEvents ||
      this.#queuedBytes + bytes > this.#options.maxBufferedBytes
    ) {
      this.resync("slow-consumer");
      return;
    }
    this.#queuedEvents += events.length;
    this.#queuedBytes += bytes;
    this.#sendTail = this.#sendTail
      .then(async () => {
        if (this.#state === "closed") return;
        for (const batch of boundedEventBatches(events, this.#options.maxWireBytes)) {
          await this.sink.send({ events: batch, type: "host.events" });
        }
      })
      .catch(() => this.#failDelivery())
      .finally(() => {
        this.#queuedEvents -= events.length;
        this.#queuedBytes -= bytes;
      });
  }

  /** Sends held progress whose durable predecessors have now been sent. */
  #releaseLive(): void {
    if (this.#pendingLive.length === 0) return;
    const held = this.#pendingLive.splice(0);
    this.#pendingLiveBytes = 0;
    for (const entry of held) {
      if (compareSequence(entry.frame.afterSequence, this.#queuedThrough) <= 0) {
        this.#sendLive(entry.frame, entry.bytes, entry.replacement);
      } else {
        this.#pendingLive.push(entry);
        this.#pendingLiveBytes += entry.bytes;
      }
    }
  }

  #sendLive(frame: LiveFrame, bytes: number, replacement = false): void {
    if (!replacement && this.#liveInFlightBytes + bytes > this.#options.maxLiveBytes) return;
    this.#liveInFlightBytes += bytes;
    this.#sendTail = this.#sendTail
      .then(() =>
        this.#state === "live"
          ? this.sink.send({
              afterSequence: frame.afterSequence,
              progress: frame.progress,
              type: "host.live",
              workspaceId: this.workspaceId,
            })
          : undefined,
      )
      .catch(() => this.#failDelivery())
      .finally(() => {
        this.#liveInFlightBytes -= bytes;
      });
  }

  #scheduleGapFill(): void {
    if (this.#pending.size === 0) {
      this.#clearGapTimer();
      return;
    }
    if (this.#gapTimer || this.#filling) return;
    this.#gapTimer = setTimeout(() => {
      this.#gapTimer = undefined;
      void this.#fillGap();
    }, this.#options.gapFillDelayMs);
    this.#gapTimer.unref?.();
  }

  #clearGapTimer(): void {
    if (this.#gapTimer) clearTimeout(this.#gapTimer);
    this.#gapTimer = undefined;
  }

  async #fillGap(): Promise<void> {
    if (this.#state !== "live" || this.#pending.size === 0) return;
    this.#filling = true;
    try {
      let lowest: Sequence | undefined;
      for (const sequence of this.#pending.keys()) {
        if (!lowest || compareSequence(sequence as Sequence, lowest) < 0) {
          lowest = sequence as Sequence;
        }
      }
      if (!lowest) return;
      const through = previousSequence(lowest);
      while (this.#state === "live" && compareSequence(this.#queuedThrough, through) < 0) {
        const from = this.#queuedThrough;
        const window = await withTimeout(
          this.#options.fill(from, through),
          this.#options.gapFillTimeoutMs,
          { timeoutError: () => new Error("The Workspace event read timed out.") },
        );
        const fresh = window.events.filter(
          (event) =>
            compareSequence(event.sequence, this.#queuedThrough) > 0 &&
            compareSequence(event.sequence, through) <= 0,
        );
        if (fresh.length > 0) {
          this.#sendEvents(fresh);
          this.#queuedThrough = fresh.at(-1)?.sequence ?? this.#queuedThrough;
        }
        if (!window.hasMore) {
          if (compareSequence(through, this.#queuedThrough) > 0) this.#queuedThrough = through;
          break;
        }
        if (compareSequence(window.scannedThrough, this.#queuedThrough) > 0) {
          this.#queuedThrough = window.scannedThrough;
        }
        if (compareSequence(this.#queuedThrough, from) <= 0) {
          this.resync("cursor-expired");
          return;
        }
      }
      this.#discardDelivered();
    } catch {
      this.resync("cursor-expired");
      return;
    } finally {
      this.#filling = false;
    }
    this.#drain();
  }
}

function nextSequence(sequence: Sequence): Sequence {
  return String(BigInt(sequence) + 1n) as Sequence;
}

function previousSequence(sequence: Sequence): Sequence {
  return String(BigInt(sequence) - 1n) as Sequence;
}

function liveFrameBytes(frame: LiveFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

export class RealtimeHub {
  readonly #store: OpensteerStore;
  readonly #gapFillDelayMs: number;
  readonly #gapFillTimeoutMs: number;
  readonly #liveRuns: Pick<LiveRunRegistry, "workspaceFrames"> | undefined;
  readonly #maxLiveBytes: number;
  readonly #maxBufferedBytes: number;
  readonly #maxBufferedEvents: number;
  readonly #maxReplayEvents: number;
  readonly #maxReplayBytes: number;
  readonly #maxWireBytes: number;
  readonly #subscribers = new Map<WorkspaceId, Set<Subscriber>>();
  readonly #readStateRefreshes = new Map<
    string,
    { workspaceId: WorkspaceId; userId: UserId; threadIds: Set<ThreadId> }
  >();
  /**
   * Every authenticated client socket, whatever Workspace it is watching.
   *
   * Some notifications are about a machine rather than a Workspace, and the
   * people entitled to them are usually not members of the Workspace whose Run
   * caused them. Those cannot ride the Workspace broadcast without either
   * leaking to that Workspace's members or never reaching their audience, so
   * the connection itself is addressable.
   */
  readonly #connections = new Map<UserId, Set<RealtimeSink>>();
  readonly #sessionConnections = new Map<
    AuthSessionId,
    { readonly sinks: Set<RealtimeSink>; readonly userId: UserId }
  >();

  constructor(options: RealtimeHubOptions) {
    this.#store = options.store;
    this.#gapFillDelayMs = options.gapFillDelayMs ?? 100;
    this.#gapFillTimeoutMs = options.gapFillTimeoutMs ?? 15_000;
    this.#liveRuns = options.liveRuns;
    this.#maxLiveBytes = options.maxLiveBytes ?? 4 * 1_024 * 1_024;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1_024 * 1_024;
    this.#maxBufferedEvents = options.maxBufferedEvents ?? 5_000;
    this.#maxReplayEvents = options.maxReplayEvents ?? 5_000;
    this.#maxReplayBytes = options.maxReplayBytes ?? 8 * 1_024 * 1_024;
    this.#maxWireBytes = options.maxWireBytes ?? 960 * 1_024;
  }

  async subscribe(input: {
    readonly afterSequence: Sequence;
    readonly sink: RealtimeSink;
    readonly userId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<() => void> {
    let subscriber!: Subscriber;
    const remove = () => {
      const set = this.#subscribers.get(input.workspaceId);
      set?.delete(subscriber);
      if (set?.size === 0) this.#subscribers.delete(input.workspaceId);
    };
    subscriber = new Subscriber({
      cursor: input.afterSequence,
      fill: (after, through) =>
        this.#store.eventsAfterWindow(input.workspaceId, after, {
          maxBytes: this.#maxWireBytes,
          maxItems: 250,
          throughSequence: through,
        }),
      gapFillDelayMs: this.#gapFillDelayMs,
      gapFillTimeoutMs: this.#gapFillTimeoutMs,
      liveFrames: () => this.#liveRuns?.workspaceFrames(input.workspaceId) ?? [],
      maxBufferedBytes: this.#maxBufferedBytes,
      maxBufferedEvents: this.#maxBufferedEvents,
      maxLiveBytes: this.#maxLiveBytes,
      maxWireBytes: this.#maxWireBytes,
      onClose: remove,
      sink: input.sink,
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    const set = this.#subscribers.get(input.workspaceId) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.#subscribers.set(input.workspaceId, set);

    try {
      const membership = await this.#store.workspaceMembershipForUser(
        input.workspaceId,
        input.userId,
      );
      if (!membership || membership.state !== "active") {
        throw new OpensteerError({
          code: "forbidden",
          message: "Workspace realtime subscription is not authorized",
        });
      }
      const messages: HostToClientMessage[] = [];
      let cursor: Sequence;
      if (compareSequence(input.afterSequence, zeroSequence) === 0) {
        const snapshot = await this.#store.workspaceSnapshot(input.workspaceId, {
          listedOnly: true,
          viewerId: input.userId,
        });
        messages.push({ snapshot, type: "host.snapshot" });
        cursor = snapshot.sequence;
      } else {
        const head = await this.#store.workspaceHead(input.workspaceId);
        if (compareSequence(input.afterSequence, head) > 0) {
          subscriber.resync("cursor-ahead");
          return remove;
        }
        cursor = input.afterSequence;
        let replayBytes = 0;
        let replayEvents = 0;
        while (compareSequence(cursor, head) < 0) {
          const window = await this.#store.eventsAfterWindow(input.workspaceId, cursor, {
            maxBytes: this.#maxWireBytes,
            maxItems: Math.min(250, this.#maxReplayEvents - replayEvents + 1),
            throughSequence: head,
          });
          // A window that accounts for nothing more is the end of what this
          // Host retains; legacy streaming rows still count as accounted for.
          if (compareSequence(window.scannedThrough, cursor) <= 0) {
            subscriber.resync("cursor-expired");
            return remove;
          }
          replayBytes += window.byteCount;
          replayEvents += window.events.length;
          if (replayEvents > this.#maxReplayEvents || replayBytes > this.#maxReplayBytes) {
            subscriber.resync("cursor-expired");
            return remove;
          }
          if (window.events.length > 0) {
            for (const events of boundedEventBatches(window.events, this.#maxWireBytes)) {
              messages.push({ events, type: "host.events" });
            }
          }
          cursor = window.scannedThrough;
          if (!window.hasMore && compareSequence(cursor, head) < 0) {
            subscriber.resync("cursor-expired");
            return remove;
          }
        }
      }
      await subscriber.synchronize(messages, cursor, async () => {
        // Shared event replay cannot replay another device's private read mark.
        // Markers are monotonic and cheap to stream, including retained older pages.
        let afterThreadId: ThreadId | undefined;
        do {
          const page = await this.#store.notificationState.readMarkerPage({
            workspaceId: input.workspaceId,
            userId: input.userId,
            ...(afterThreadId ? { afterThreadId } : {}),
          });
          if (page.markers.length)
            await input.sink.send({
              type: "host.read-markers",
              workspaceId: input.workspaceId,
              markers: [...page.markers],
            });
          afterThreadId = page.nextAfterThreadId ?? undefined;
        } while (afterThreadId);
        const replayThreads = new Set<ThreadId>();
        for (const message of messages)
          if (message.type === "host.events") {
            for (const event of message.events)
              if (changesReadState(event.type)) replayThreads.add(event.threadId);
          }
        if (replayThreads.size) {
          const states = await this.#store.notificationState.listReadStates({
            userId: input.userId,
            threadIds: [...replayThreads],
          });
          for (let index = 0; index < states.length; index += 100)
            await input.sink.send({
              type: "host.read-states",
              workspaceId: input.workspaceId,
              states: states.slice(index, index + 100),
            });
        }
        let afterWorkspaceId: WorkspaceId | undefined;
        do {
          const page = await this.#store.notificationState.workspacePreferencePage({
            userId: input.userId,
            ...(afterWorkspaceId ? { afterWorkspaceId } : {}),
          });
          if (page.preferences.length)
            await input.sink.send({
              type: "host.notification-preferences",
              preferences: [...page.preferences],
            });
          afterWorkspaceId = page.nextAfterWorkspaceId ?? undefined;
        } while (afterWorkspaceId);
      });
      return () => subscriber.close();
    } catch (error) {
      subscriber.close();
      throw error;
    }
  }

  /**
   * Notes an authenticated client socket for the life of that socket. It is
   * independent of any Workspace subscription, because the messages addressed
   * this way are not about a Workspace.
   */
  registerConnection(userId: UserId, sessionId: AuthSessionId, sink: RealtimeSink): () => void {
    const sinks = this.#connections.get(userId) ?? new Set<RealtimeSink>();
    sinks.add(sink);
    this.#connections.set(userId, sinks);
    const sessionConnection = this.#sessionConnections.get(sessionId) ?? {
      sinks: new Set<RealtimeSink>(),
      userId,
    };
    if (sessionConnection.userId !== userId) {
      throw new Error("A realtime session cannot belong to multiple users");
    }
    sessionConnection.sinks.add(sink);
    this.#sessionConnections.set(sessionId, sessionConnection);
    return () => {
      const current = this.#connections.get(userId);
      current?.delete(sink);
      if (current?.size === 0) this.#connections.delete(userId);
      const currentSession = this.#sessionConnections.get(sessionId);
      currentSession?.sinks.delete(sink);
      if (currentSession?.sinks.size === 0) this.#sessionConnections.delete(sessionId);
    };
  }

  closeSession(sessionId: AuthSessionId): void {
    const sinks = this.#sessionConnections.get(sessionId);
    if (!sinks) return;
    this.#sessionConnections.delete(sessionId);
    const userSinks = this.#connections.get(sinks.userId);
    for (const sink of sinks.sinks) {
      userSinks?.delete(sink);
      for (const subscribers of this.#subscribers.values()) {
        for (const subscriber of subscribers) {
          if (subscriber.sink === sink) subscriber.close();
        }
      }
      sink.close(4003, "Session ended");
    }
    if (userSinks?.size === 0) this.#connections.delete(sinks.userId);
  }

  /** Who is listening right now, so authorization is asked only about them. */
  connectedUserIds(): readonly UserId[] {
    return [...this.#connections.keys()];
  }

  /**
   * Sends one message to every socket of the named people. A failed send is
   * that socket's problem alone: these messages carry no sequence and nothing
   * replays them, so one slow reader must not hold up the rest.
   */
  sendToUsers(userIds: Iterable<UserId>, message: HostToClientMessage): void {
    for (const userId of userIds) {
      for (const sink of this.#connections.get(userId) ?? []) {
        void sink.send(message).catch(() => undefined);
      }
    }
  }

  /**
   * Sends one message to every authenticated client socket.
   *
   * For notifications that name nothing and disclose nothing — "this list
   * changed, read it again" — where the reread is the thing authorization is
   * asked about. Anything that carries a fact about one machine goes to
   * `sendToUsers` with the people entitled to it.
   */
  broadcast(message: HostToClientMessage): void {
    for (const sinks of this.#connections.values()) {
      for (const sink of sinks) void sink.send(message).catch(() => undefined);
    }
  }

  publish(event: AgentEvent): void {
    for (const subscriber of this.#subscribers.get(event.workspaceId) ?? []) {
      subscriber.offer(event);
      if (changesReadState(event.type))
        this.#refreshReadStates(event.workspaceId, subscriber.userId, event.threadId);
    }
    // Whom a Request waits on can be someone following none of this
    // Workspace's Threads — the person whose task handed the work out — so
    // every client rereads its own list instead of hoping it was subscribed.
    if (changesWaitingRequests(event.type)) this.broadcast({ type: "host.requests-changed" });
    // A task list spans every Workspace its reader belongs to, so it is reread
    // whole on every client; the reread is where membership is asked.
    if (changesTasks(event)) this.broadcast({ type: "host.tasks-changed" });
  }

  /** Forwards one Run's live progress to the Workspace's subscribers. */
  publishLive(frame: LiveFrame): void {
    for (const subscriber of this.#subscribers.get(frame.progress.workspaceId) ?? []) {
      subscriber.offerLive(frame);
    }
  }

  publishReadState(userId: UserId, workspaceId: WorkspaceId, state: ThreadReadState): void {
    for (const subscriber of this.#subscribers.get(workspaceId) ?? []) {
      if (subscriber.userId === userId)
        subscriber.enqueueMessage({ type: "host.read-states", workspaceId, states: [state] });
    }
  }

  /** This reader's task placement or Workspace membership changed. */
  publishViewerTasksChanged(userId: UserId): void {
    this.#sendViewerMessage(userId, { type: "host.tasks-changed" });
  }

  publishNotificationPreference(userId: UserId, preference: WorkspaceNotificationPreference): void {
    this.#sendViewerMessage(userId, {
      type: "host.notification-preferences",
      preferences: [preference],
    });
  }

  #sendViewerMessage(userId: UserId, message: HostToClientMessage): void {
    for (const sink of this.#connections.get(userId) ?? []) {
      let queued = false;
      for (const subscribers of this.#subscribers.values())
        for (const subscriber of subscribers) {
          if (subscriber.sink === sink) {
            subscriber.enqueueMessage(message);
            queued = true;
          }
        }
      if (!queued)
        void sink.send(message).catch(() => sink.close(1011, "Viewer state delivery failed"));
    }
  }

  #refreshReadStates(workspaceId: WorkspaceId, userId: UserId, threadId: ThreadId): void {
    const key = `${workspaceId}:${userId}`;
    const existing = this.#readStateRefreshes.get(key);
    if (existing) {
      existing.threadIds.add(threadId);
      return;
    }
    const refresh = { workspaceId, userId, threadIds: new Set([threadId]) };
    this.#readStateRefreshes.set(key, refresh);
    // One read for a burst of published changes and a viewer, shared by all
    // their devices. Token deltas never enter this queue.
    queueMicrotask(() => {
      void this.#flushReadStates(key, refresh);
    });
  }

  async #flushReadStates(
    key: string,
    refresh: { workspaceId: WorkspaceId; userId: UserId; threadIds: Set<ThreadId> },
  ): Promise<void> {
    try {
      while (refresh.threadIds.size) {
        const ids = [...refresh.threadIds].slice(0, 100);
        for (const id of ids) refresh.threadIds.delete(id);
        const states = await this.#store.notificationState.listReadStates({
          userId: refresh.userId,
          threadIds: ids,
        });
        for (const subscriber of this.#subscribers.get(refresh.workspaceId) ?? []) {
          if (subscriber.userId === refresh.userId)
            subscriber.enqueueMessage({
              type: "host.read-states",
              workspaceId: refresh.workspaceId,
              states: [...states],
            });
        }
      }
    } catch {
      // A failed projection must reconnect and re-establish its authoritative
      // snapshot; keeping a synchronized stream would silently lose the update.
      for (const subscriber of this.#subscribers.get(refresh.workspaceId) ?? [])
        if (subscriber.userId === refresh.userId) subscriber.resync("cursor-expired");
    } finally {
      this.#readStateRefreshes.delete(key);
    }
  }

  publishTriggersChanged(workspaceId: WorkspaceId): void {
    this.#publishWorkspaceNotice({ type: "host.triggers-changed", workspaceId });
  }

  publishBrowserSessionsChanged(workspaceId: WorkspaceId, viewerUserIds: readonly UserId[]): void {
    for (const userId of viewerUserIds) {
      this.#sendViewerMessage(userId, { type: "host.browser-sessions-changed", workspaceId });
    }
  }

  /**
   * These conversations' visible browser usage changed. Their Workspace's
   * subscribers reread usage only for the conversations they show.
   */
  publishBrowserUsageChanged(workspaceId: WorkspaceId, threadIds: readonly ThreadId[]): void {
    if (threadIds.length === 0) return;
    for (const notice of wireNotices({
      threadIds: [...new Set(threadIds)],
      type: "host.browser-usage-changed",
      workspaceId,
    })) {
      this.#publishWorkspaceNotice(notice);
    }
  }

  #publishWorkspaceNotice(notice: WorkspaceNotice): void {
    for (const subscriber of this.#subscribers.get(notice.workspaceId) ?? []) {
      subscriber.enqueueMessage(notice);
    }
  }

  closeUserWorkspace(userId: UserId, workspaceId: WorkspaceId): void {
    for (const subscriber of this.#subscribers.get(workspaceId) ?? []) {
      if (subscriber.userId === userId) {
        subscriber.sink.close(4003, "Workspace access revoked");
        subscriber.close();
      }
    }
  }
}

function eventBytes(event: AgentEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function boundedEventBatches(events: readonly AgentEvent[], maxWireBytes: number): AgentEvent[][] {
  const batches: AgentEvent[][] = [];
  let batch: AgentEvent[] = [];
  let batchBytes = hostEventsEnvelopeBytes;
  for (const event of events) {
    const bytes = eventBytes(event) + (batch.length === 0 ? 0 : 1);
    if (hostEventsEnvelopeBytes + bytes > maxWireBytes) {
      throw new Error("A durable event exceeds the realtime wire byte ceiling");
    }
    if (batch.length >= 2_000 || batchBytes + bytes > maxWireBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = hostEventsEnvelopeBytes;
    }
    batch.push(event);
    batchBytes += eventBytes(event) + (batch.length === 1 ? 0 : 1);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

const hostEventsEnvelopeBytes = Buffer.byteLength(
  JSON.stringify({ events: [], type: "host.events" }),
  "utf8",
);

// Publishers call the hub after their store transaction resolves (including
// CommandService cancellation), so a refresh sees committed visibility and head.
function changesWaitingRequests(type: AgentEvent["type"]): boolean {
  return (
    type === "request.opened" ||
    type === "request.updated" ||
    type === "request.resolved" ||
    type === "request.cancelled"
  );
}

/**
 * What a task list shows of a listed Thread: whether it is listed at all, its
 * title and status (archiving is a status), its Runs' statuses and the latest
 * one's failure, and its published messages, which are its last reply and
 * what is unread. Streamed progress and a Run's own steps change none of it.
 */
function changesTasks(event: AgentEvent): boolean {
  switch (event.type) {
    case "thread.created":
      return event.data.thread.listed;
    case "thread.listed":
    case "thread.state-changed":
    case "run.queued":
    case "run.started":
    case "run.status":
    case "run.completed":
    case "run.failed":
    case "run.interrupted":
      return true;
    default:
      return changesReadState(event.type);
  }
}

function changesReadState(type: AgentEvent["type"]): boolean {
  return (
    type === "message.created" ||
    type === "message.placed" ||
    type === "thread-input.updated" ||
    type === "thread.state-changed"
  );
}
