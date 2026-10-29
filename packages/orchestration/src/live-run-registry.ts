import {
  appendLiveStreamTail,
  compareSequence,
  liveProgressMaxItems,
  liveStreamKeyId,
  liveStreamKeyOf,
  zeroSequence,
  type AgentEvent,
  type LiveItem,
  type LiveRunProgress,
  type LiveStreamKey,
  type RunId,
  type Sequence,
  type ThreadId,
  type WorkspaceId,
} from "@opensteer/core";

/** A Run's progress as clients receive it: after every durable event it follows. */
export interface LiveFrame {
  readonly afterSequence: Sequence;
  readonly progress: LiveRunProgress;
}

interface LiveStreamState {
  readonly key: LiveStreamKey;
  length: number;
  tail: string;
}

interface LiveRunState {
  afterSequence: Sequence;
  readonly runId: RunId;
  readonly streams: Map<string, LiveStreamState>;
  readonly threadId: ThreadId;
  touchedAt: number;
  readonly workspaceId: WorkspaceId;
}

export interface LiveRunRegistryOptions {
  /** Streams one Run may hold open; past it the oldest stream is forgotten. */
  readonly maxStreamsPerRun?: number;
  /** Runs held at once; past it the least recently touched Run is forgotten. */
  readonly maxRuns?: number;
  readonly now?: () => number;
}

const terminalRunEventTypes: ReadonlySet<AgentEvent["type"]> = new Set([
  "run.completed",
  "run.failed",
  "run.interrupted",
]);

/**
 * What each active Run is streaming, held in memory and never stored.
 *
 * The registry learns a Run from its committed durable events and forgets it
 * at the Run's terminal event, so progress can only follow a Run the Host has
 * already admitted to its log. Each Run remembers the newest sequence of the
 * transactions that committed its durable events: a frame is forwarded with
 * that sequence, and a subscriber sends it only after everything up to it, so
 * a client never applies text the completing event has already replaced.
 *
 * Every stream keeps the same tail and total length as the Runner and the
 * client, so an append that names any other offset is a gap: it is dropped
 * here, and a client that sees one reads `thread.live.get` for the whole stream.
 */
export class LiveRunRegistry {
  readonly #runs = new Map<RunId, LiveRunState>();
  readonly #maxStreamsPerRun: number;
  readonly #maxRuns: number;
  readonly #now: () => number;

  constructor(options: LiveRunRegistryOptions = {}) {
    this.#maxStreamsPerRun = options.maxStreamsPerRun ?? 64;
    this.#maxRuns = options.maxRuns ?? 2_048;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records durable events one transaction committed, in commit order. Every
   * Run they name follows the transaction's final sequence, including events
   * the commit added for other reasons, such as an input's delivery receipt.
   */
  observeCommitted(events: readonly AgentEvent[]): void {
    if (events.length === 0) return;
    let transactionSequence = zeroSequence;
    for (const event of events) {
      if (compareSequence(event.sequence, transactionSequence) > 0) {
        transactionSequence = event.sequence;
      }
    }
    for (const event of events) {
      if (!event.runId) continue;
      if (terminalRunEventTypes.has(event.type)) {
        this.#runs.delete(event.runId);
        continue;
      }
      // The superseded attempt's streams never complete; the next attempt
      // opens its own from the start.
      if (event.type === "run.restarted") this.#runs.delete(event.runId);
      const state = this.#ensureRun(event.runId, event.threadId, event.workspaceId);
      if (!state) continue;
      if (compareSequence(transactionSequence, state.afterSequence) > 0) {
        state.afterSequence = transactionSequence;
      }
      this.#completeStream(state, event);
    }
  }

  /**
   * Starts following a Run that resumed on a new connection, at the sequence
   * its Workspace had reached. After a Host restart this is how the Host
   * learns of a Run that commits nothing more before its next progress: the
   * Runner states its streams again right after it reattaches.
   */
  track(input: {
    readonly afterSequence: Sequence;
    readonly runId: RunId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  }): void {
    const state = this.#ensureRun(input.runId, input.threadId, input.workspaceId);
    if (state && compareSequence(input.afterSequence, state.afterSequence) > 0) {
      state.afterSequence = input.afterSequence;
    }
  }

  /**
   * Applies one Runner frame and returns what to forward: the items that fit
   * the streams the Host holds, or nothing for a Run it does not know.
   */
  apply(progress: LiveRunProgress): LiveFrame | undefined {
    const state = this.#runs.get(progress.runId);
    if (
      !state ||
      state.threadId !== progress.threadId ||
      state.workspaceId !== progress.workspaceId
    ) {
      return undefined;
    }
    state.touchedAt = this.#now();
    const accepted: LiveItem[] = [];
    for (const item of progress.items) {
      const forwarded = this.#applyItem(state, item);
      if (forwarded) accepted.push(forwarded);
    }
    if (accepted.length === 0) return undefined;
    return {
      afterSequence: state.afterSequence,
      progress: { ...progress, items: accepted },
    };
  }

  /** Every open stream of every active Run in the Workspace, as `replace` items. */
  workspaceFrames(workspaceId: WorkspaceId): readonly LiveFrame[] {
    return [...this.#runs.values()]
      .filter((state) => state.workspaceId === workspaceId)
      .flatMap(replacementFrames);
  }

  /** Every open stream of the Thread's active Runs, as `replace` items. */
  threadFrames(threadId: ThreadId): readonly LiveFrame[] {
    return [...this.#runs.values()]
      .filter((state) => state.threadId === threadId)
      .flatMap(replacementFrames);
  }

  #ensureRun(runId: RunId, threadId: ThreadId, workspaceId: WorkspaceId): LiveRunState | undefined {
    const existing = this.#runs.get(runId);
    if (existing) {
      existing.touchedAt = this.#now();
      return existing.threadId === threadId && existing.workspaceId === workspaceId
        ? existing
        : undefined;
    }
    if (this.#runs.size >= this.#maxRuns) this.#evictLeastRecent();
    const state: LiveRunState = {
      afterSequence: zeroSequence,
      runId,
      streams: new Map(),
      threadId,
      touchedAt: this.#now(),
      workspaceId,
    };
    this.#runs.set(runId, state);
    return state;
  }

  #evictLeastRecent(): void {
    let oldest: LiveRunState | undefined;
    for (const state of this.#runs.values()) {
      if (!oldest || state.touchedAt < oldest.touchedAt) oldest = state;
    }
    if (oldest) this.#runs.delete(oldest.runId);
  }

  #completeStream(state: LiveRunState, event: AgentEvent): void {
    switch (event.type) {
      case "assistant.message":
        state.streams.delete(liveStreamKeyId({ stream: "assistant" }));
        return;
      case "reasoning.completed":
        state.streams.delete(liveStreamKeyId({ blockId: event.data.blockId, stream: "reasoning" }));
        return;
      case "tool.completed":
        state.streams.delete(liveStreamKeyId({ callId: event.data.callId, stream: "tool" }));
        return;
      default:
        return;
    }
  }

  #applyItem(state: LiveRunState, item: LiveItem): LiveItem | undefined {
    const key = liveStreamKeyOf(item);
    const id = liveStreamKeyId(key);
    if (item.op === "replace") {
      const stream = this.#stream(state, id, key);
      stream.length = item.length;
      stream.tail = item.text;
      return item;
    }
    const stream = state.streams.get(id) ?? (item.at === 0 ? this.#stream(state, id, key) : null);
    if (!stream) return undefined;
    const end = item.at + item.text.length;
    if (end <= stream.length) return undefined;
    if (item.at > stream.length) return undefined;
    const text = item.text.slice(stream.length - item.at);
    const at = stream.length;
    stream.length = end;
    stream.tail = appendLiveStreamTail(stream.tail, text);
    return { ...item, at, text };
  }

  #stream(state: LiveRunState, id: string, key: LiveStreamKey): LiveStreamState {
    const existing = state.streams.get(id);
    if (existing) return existing;
    if (state.streams.size >= this.#maxStreamsPerRun) {
      const oldest = state.streams.keys().next();
      if (!oldest.done) state.streams.delete(oldest.value);
    }
    const stream: LiveStreamState = { key, length: 0, tail: "" };
    state.streams.set(id, stream);
    return stream;
  }
}

/**
 * Serialized characters one replacement frame may carry. A client refuses a
 * frame over one million characters, and one stream's tail can approach half
 * of that after escaping, so a Run's open streams are split across frames.
 */
const replacementFrameMaxCharacters = 448 * 1_024;

function replacementFrames(state: LiveRunState): readonly LiveFrame[] {
  const frames: LiveFrame[] = [];
  let items: LiveItem[] = [];
  let characters = 0;
  const flush = () => {
    if (items.length === 0) return;
    frames.push({
      afterSequence: state.afterSequence,
      progress: {
        items,
        runId: state.runId,
        threadId: state.threadId,
        workspaceId: state.workspaceId,
      },
    });
    items = [];
    characters = 0;
  };
  for (const stream of state.streams.values()) {
    const item = replacementItem(stream);
    const itemCharacters = JSON.stringify(item).length;
    if (
      items.length > 0 &&
      (items.length >= liveProgressMaxItems ||
        characters + itemCharacters > replacementFrameMaxCharacters)
    ) {
      flush();
    }
    items.push(item);
    characters += itemCharacters;
  }
  flush();
  return frames;
}

function replacementItem(stream: LiveStreamState): LiveItem {
  const { key } = stream;
  switch (key.stream) {
    case "assistant":
      return { length: stream.length, op: "replace", stream: "assistant", text: stream.tail };
    case "reasoning":
      return {
        blockId: key.blockId,
        length: stream.length,
        op: "replace",
        stream: "reasoning",
        text: stream.tail,
      };
    case "tool":
      return {
        callId: key.callId,
        length: stream.length,
        op: "replace",
        stream: "tool",
        text: stream.tail,
      };
  }
}
