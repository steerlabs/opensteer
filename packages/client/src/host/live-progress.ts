import {
  appendLiveStreamTail,
  compareSequence,
  liveStreamKeyId,
  liveStreamKeyOf,
  type AgentEventView as AgentEvent,
  type LiveStreamKey,
  type RunId,
  type Sequence,
  type ThreadId,
  type WorkspaceId,
} from "@opensteer/core";

/** One stream as the client draws it. */
export interface LiveStreamView {
  readonly key: LiveStreamKey;
  /** Every unit the stream has received; more than `tail` once it was cut. */
  readonly length: number;
  readonly tail: string;
}

/** The streams of one Run that a fold should redraw. */
export interface LiveRunView {
  readonly runId: RunId;
  readonly streams: readonly LiveStreamView[];
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

/** What the Host sends: a Run's items, after the durable events they follow. */
export interface LiveProgressInput {
  readonly afterSequence: Sequence;
  readonly progress: {
    readonly items: readonly LiveItemInput[];
    readonly runId: RunId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  };
}

type LiveItemInput =
  | ({ readonly at: number; readonly op: "append"; readonly text: string } & LiveStreamKey)
  | ({ readonly length: number; readonly op: "replace"; readonly text: string } & LiveStreamKey);

interface LiveStream {
  key: LiveStreamKey;
  length: number;
  /**
   * The durable sequence this stream follows. A completion recorded before it
   * belongs to an earlier stream of the same key and leaves this one open.
   */
  openedAfter: Sequence;
  tail: string;
}

interface LiveRun {
  readonly runId: RunId;
  readonly streams: Map<string, LiveStream>;
  readonly threadId: ThreadId;
  /** Where each stream was last completed, so an older snapshot cannot reopen it. */
  readonly tombstones: Map<string, Sequence>;
  readonly workspaceId: WorkspaceId;
}

const endedRunMemory = 512;

/**
 * The client's own copy of every stream it draws.
 *
 * Progress arrives as appends that name the offset they continue, so a missed
 * frame is detected instead of drawn as a hole; the reader then rereads the
 * Thread's streams whole. A durable completion ends its stream here exactly as
 * it does on the Host, and remembers the sequence it ended at, so a reread that
 * answers late can never put back text the completion already replaced.
 */
export class LiveStreamLedger {
  readonly #runs = new Map<string, LiveRun>();
  readonly #endedRuns = new Set<RunId>();

  /**
   * Applies one frame. Returns the Run's changed streams to draw, and whether
   * any append continued an offset this client does not hold.
   */
  apply(input: LiveProgressInput): { readonly changed: LiveRunView | null; readonly gap: boolean } {
    const { progress } = input;
    if (this.#endedRuns.has(progress.runId)) return { changed: null, gap: false };
    const run = this.#run(progress.runId, progress.threadId, progress.workspaceId);
    if (!run) return { changed: null, gap: false };
    const changed = new Set<string>();
    let gap = false;
    for (const item of progress.items) {
      const key = liveStreamKeyOf(item);
      const id = liveStreamKeyId(key);
      const tombstone = run.tombstones.get(id);
      if (tombstone && compareSequence(input.afterSequence, tombstone) < 0) continue;
      if (item.op === "replace") {
        const current = run.streams.get(id);
        // A replacement never takes a stream back: a reread that answers after
        // newer appends were drawn is older than what the client holds.
        if (current && item.length < current.length) continue;
        run.streams.set(id, {
          key,
          length: item.length,
          openedAfter: current?.openedAfter ?? input.afterSequence,
          tail: item.text,
        });
        changed.add(id);
        continue;
      }
      const stream =
        run.streams.get(id) ??
        (item.at === 0
          ? { key, length: 0, openedAfter: input.afterSequence, tail: "" }
          : (undefined as undefined));
      if (!stream) {
        gap = true;
        continue;
      }
      const end = item.at + item.text.length;
      if (end <= stream.length) continue;
      if (item.at > stream.length) {
        gap = true;
        continue;
      }
      stream.tail = appendLiveStreamTail(stream.tail, item.text.slice(stream.length - item.at));
      stream.length = end;
      run.streams.set(id, stream);
      changed.add(id);
    }
    if (changed.size === 0) return { changed: null, gap };
    return {
      changed: {
        runId: progress.runId,
        streams: [...changed].flatMap((id) => {
          const stream = run.streams.get(id);
          return stream ? [{ key: stream.key, length: stream.length, tail: stream.tail }] : [];
        }),
        threadId: run.threadId,
        workspaceId: run.workspaceId,
      },
      gap,
    };
  }

  /** Ends whatever stream a durable event completes, or the whole Run at its terminal. */
  complete(event: AgentEvent): void {
    if (!event.runId) return;
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.interrupted"
    ) {
      this.#runs.delete(event.runId);
      this.#endedRuns.add(event.runId);
      if (this.#endedRuns.size > endedRunMemory) {
        const oldest = this.#endedRuns.values().next();
        if (!oldest.done) this.#endedRuns.delete(oldest.value);
      }
      return;
    }
    // A restart's superseded attempt never completes its streams; the next
    // attempt opens its own from the start.
    if (event.type === "run.restarted") {
      this.#runs.delete(event.runId);
      return;
    }
    const key = completedStreamKey(event);
    if (!key || this.#endedRuns.has(event.runId)) return;
    // History read over HTTP can name a completion before any live frame of
    // its Run arrives; remembering it keeps a late frame from drawing the text
    // it replaced.
    const run = this.#run(event.runId, event.threadId, event.workspaceId);
    if (!run) return;
    const id = liveStreamKeyId(key);
    const stream = run.streams.get(id);
    // History read over HTTP can name a completion older than the stream now
    // open under the same key, such as the previous answer's.
    if (stream && compareSequence(stream.openedAfter, event.sequence) < 0) run.streams.delete(id);
    const tombstone = run.tombstones.get(id);
    if (!tombstone || compareSequence(event.sequence, tombstone) > 0) {
      run.tombstones.set(id, event.sequence);
    }
  }

  /** Forgets one Workspace's streams; a resubscription sends them whole again. */
  resetWorkspace(workspaceId: WorkspaceId): void {
    for (const [runId, run] of this.#runs) {
      if (run.workspaceId === workspaceId) this.#runs.delete(runId);
    }
  }

  /** Forgets everything, for a viewer whose session has ended. */
  clear(): void {
    this.#runs.clear();
    this.#endedRuns.clear();
  }

  /** Whether the stream is open here, so what the transcript draws of it is current. */
  holds(runId: string, key: LiveStreamKey): boolean {
    return this.#runs.get(runId)?.streams.has(liveStreamKeyId(key)) ?? false;
  }

  /** Every stream of the Thread's Runs, to draw again over a freshly read page. */
  threadRuns(threadId: ThreadId): readonly LiveRunView[] {
    return [...this.#runs.values()]
      .filter((run) => run.threadId === threadId && run.streams.size > 0)
      .map((run) => ({
        runId: run.runId,
        streams: [...run.streams.values()].map((stream) => ({
          key: stream.key,
          length: stream.length,
          tail: stream.tail,
        })),
        threadId: run.threadId,
        workspaceId: run.workspaceId,
      }));
  }

  #run(runId: RunId, threadId: ThreadId, workspaceId: WorkspaceId): LiveRun | undefined {
    const existing = this.#runs.get(runId);
    if (existing) {
      return existing.threadId === threadId && existing.workspaceId === workspaceId
        ? existing
        : undefined;
    }
    const run: LiveRun = {
      runId,
      streams: new Map(),
      threadId,
      tombstones: new Map(),
      workspaceId,
    };
    this.#runs.set(runId, run);
    return run;
  }
}

/** The text a stream shows: its tail, marked when the head has been cut. */
export function liveStreamText(stream: LiveStreamView): string {
  return stream.length > stream.tail.length ? `…${stream.tail}` : stream.tail;
}

function completedStreamKey(event: AgentEvent): LiveStreamKey | undefined {
  switch (event.type) {
    case "assistant.message":
      return { stream: "assistant" };
    case "reasoning.completed":
      return { blockId: event.data.blockId, stream: "reasoning" };
    case "tool.completed":
      return { callId: event.data.callId, stream: "tool" };
    default:
      return undefined;
  }
}
