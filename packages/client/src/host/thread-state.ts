import { compareSequence, type AgentEventView as AgentEvent, type Sequence } from "@opensteer/core";
import type { ThreadSummary } from "./client.js";

const unloadedThreadLimit = 4096;

export type ThreadName = Pick<ThreadSummary, "title" | "icon"> &
  Partial<Pick<ThreadSummary, "doneAt" | "doneReason" | "latestRunCompletedAt" | "lastVisitedAt">>;

type ThreadState = { returnHint?: ThreadSummary["returnHint"] } & Pick<
  ThreadSummary,
  "status" | "inputQueuePaused" | "pendingRequests" | "updatedAt"
> & {
    readonly doneAt?: ThreadSummary["doneAt"] | undefined;
    readonly doneReason?: ThreadSummary["doneReason"] | undefined;
    readonly title?: string | undefined;
    readonly icon?: ThreadSummary["icon"] | undefined;
    readonly latestRunCompletedAt?: string | null | undefined;
    readonly stateSequence: Sequence;
  };

export class ThreadStateProjection {
  readonly #loaded = new Map<string, ThreadState>();
  readonly #unloaded = new Map<string, ThreadState>();

  #coverageFloor: Sequence | null = null;

  cover(sequence: Sequence): void {
    const previous = this.#coverageFloor;
    if (previous === null || compareSequence(sequence, previous) > 0)
      this.#coverageFloor = sequence;
  }

  needsRead(thread: Pick<ThreadSummary, "id">, sequence: Sequence): boolean {
    const floor = this.#coverageFloor;
    if (floor === null || compareSequence(sequence, floor) >= 0) return false;
    const loaded = this.#loaded.get(thread.id);
    return loaded === undefined || compareSequence(loaded.stateSequence, floor) < 0;
  }

  record(event: AgentEvent): boolean {
    const state =
      event.type === "thread.state-changed"
        ? event.data
        : event.type === "thread.created" ||
            event.type === "thread.execution-updated" ||
            event.type === "thread.listed"
          ? event.data.thread
          : null;
    if (!state) return false;
    this.#accept(event.threadId, {
      ...state,
      stateSequence: event.sequence,
      updatedAt: event.createdAt,
    });
    return true;
  }

  reconcile(
    summary: ThreadSummary,
    asOfSequence: Sequence,
    current?: ThreadSummary,
  ): ThreadSummary {
    const accepted = this.#accept(summary.id, { ...summary, stateSequence: asOfSequence }, true);
    const state = {
      ...accepted,
      doneAt: accepted.doneAt === undefined ? summary.doneAt : accepted.doneAt,
      doneReason: accepted.doneAt === undefined ? summary.doneReason : accepted.doneReason,
      title: accepted.title ?? summary.title,
      icon: accepted.icon === undefined ? summary.icon : accepted.icon,
    };
    const updatedAt = [state.updatedAt, current?.updatedAt ?? ""].reduce(
      (latest, timestamp) => (timestamp > latest ? timestamp : latest),
      summary.updatedAt,
    );
    this.#unloaded.delete(summary.id);
    this.#loaded.set(summary.id, { ...state, updatedAt });
    return {
      ...summary,
      returnHint: state.returnHint === undefined ? summary.returnHint : state.returnHint,
      doneAt: state.doneAt,
      doneReason: state.doneReason ?? null,
      title: state.title,
      icon: state.icon,
      latestRunCompletedAt:
        state.latestRunCompletedAt === undefined
          ? summary.latestRunCompletedAt
          : state.latestRunCompletedAt,
      status: state.status,
      inputQueuePaused: state.inputQueuePaused,
      pendingRequests: state.pendingRequests,
      updatedAt,
    };
  }

  name(thread: ThreadSummary): ThreadName {
    const state = this.#loaded.get(thread.id) ?? this.#unloaded.get(thread.id);
    return {
      doneAt: state?.doneAt === undefined ? thread.doneAt : state.doneAt,
      doneReason: state?.doneAt === undefined ? thread.doneReason : (state.doneReason ?? null),
      latestRunCompletedAt:
        state?.latestRunCompletedAt === undefined
          ? thread.latestRunCompletedAt
          : state.latestRunCompletedAt,
      title: state?.title ?? thread.title,
      icon: state?.icon === undefined ? thread.icon : state.icon,
    };
  }

  retainLoaded(threads: readonly ThreadSummary[]): void {
    const ids = new Set(threads.map((thread) => thread.id));
    for (const [id, state] of this.#loaded) {
      if (ids.has(id)) continue;
      this.#loaded.delete(id);
      this.#remember(id, state);
    }
    for (const thread of threads) {
      const state = this.#loaded.get(thread.id) ?? this.#unloaded.get(thread.id);
      if (!state) continue;
      this.#unloaded.delete(thread.id);
      this.#loaded.set(thread.id, {
        ...state,
        updatedAt: thread.updatedAt > state.updatedAt ? thread.updatedAt : state.updatedAt,
      });
    }
  }

  #accept(id: string, incoming: ThreadState, loaded = false): ThreadState {
    const previous = this.#loaded.get(id) ?? this.#unloaded.get(id);
    if (previous && compareSequence(incoming.stateSequence, previous.stateSequence) <= 0)
      return previous;
    const state = {
      doneAt: incoming.doneAt === undefined ? previous?.doneAt : incoming.doneAt,
      // Events that predate reasons carry Done alone, which then reads as a person's.
      doneReason:
        incoming.doneAt === undefined ? previous?.doneReason : (incoming.doneReason ?? null),
      title: incoming.title ?? previous?.title,
      icon: incoming.icon === undefined ? previous?.icon : incoming.icon,
      latestRunCompletedAt:
        incoming.latestRunCompletedAt === undefined
          ? previous?.latestRunCompletedAt
          : incoming.latestRunCompletedAt,
      returnHint: incoming.returnHint === undefined ? previous?.returnHint : incoming.returnHint,
      status: incoming.status,
      inputQueuePaused: incoming.inputQueuePaused,
      pendingRequests: incoming.pendingRequests,
      stateSequence: incoming.stateSequence,
      updatedAt:
        previous && previous.updatedAt > incoming.updatedAt
          ? previous.updatedAt
          : incoming.updatedAt,
    };
    if (loaded || this.#loaded.has(id)) this.#loaded.set(id, state);
    else this.#remember(id, state);
    return state;
  }

  #remember(id: string, state: ThreadState): void {
    this.#unloaded.delete(id);
    this.#unloaded.set(id, state);
    if (this.#unloaded.size > unloadedThreadLimit) {
      const [evictedId, evicted] = this.#unloaded.entries().next().value!;
      this.cover(evicted.stateSequence);
      this.#unloaded.delete(evictedId);
    }
  }

  checkpoint() {
    return {
      coverage: this.#coverageFloor,
      loaded: [...this.#loaded],
      unloaded: [...this.#unloaded],
    };
  }
  restore(checkpoint: ReturnType<ThreadStateProjection["checkpoint"]>): void {
    this.clear();
    this.#coverageFloor = checkpoint.coverage;
    for (const [id, state] of checkpoint.loaded) this.#loaded.set(id, state);
    for (const [id, state] of checkpoint.unloaded) this.#remember(id, state);
  }

  clear(): void {
    this.#loaded.clear();
    this.#unloaded.clear();
    this.#coverageFloor = null;
  }
}
