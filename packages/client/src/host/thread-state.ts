import { compareSequence, type AgentEvent, type Sequence } from "@opensteer/core";
import type { ThreadSummary } from "./client.js";

const unloadedThreadLimit = 4096;

export type ThreadName = Pick<ThreadSummary, "title" | "icon"> &
  Partial<Pick<ThreadSummary, "doneAt">>;

type ThreadState = Pick<
  ThreadSummary,
  "status" | "inputQueuePaused" | "pendingRequests" | "updatedAt" | "workspaceId"
> & {
  readonly doneAt?: ThreadSummary["doneAt"] | undefined;
  readonly title?: string | undefined;
  readonly icon?: ThreadSummary["icon"] | undefined;
  readonly stateSequence: Sequence;
};

/** Each source supplies an absolute state at a Workspace sequence, never a delta. */
export class ThreadStateProjection {
  readonly #loaded = new Map<string, ThreadState>();
  readonly #unloaded = new Map<string, ThreadState>();
  // Sequences are Workspace-local. Each floor covers both snapshot gaps and eviction.
  readonly #coverageFloor = new Map<string, Sequence>();

  cover(workspaceId: string, sequence: Sequence): void {
    const previous = this.#coverageFloor.get(workspaceId);
    if (previous === undefined || compareSequence(sequence, previous) > 0)
      this.#coverageFloor.set(workspaceId, sequence);
  }

  needsRead(thread: Pick<ThreadSummary, "id" | "workspaceId">, sequence: Sequence): boolean {
    const floor = this.#coverageFloor.get(thread.workspaceId);
    if (floor === undefined || compareSequence(sequence, floor) >= 0) return false;
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
      workspaceId: event.workspaceId,
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
      doneAt: state.doneAt,
      title: state.title,
      icon: state.icon,
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
      title: incoming.title ?? previous?.title,
      icon: incoming.icon === undefined ? previous?.icon : incoming.icon,
      status: incoming.status,
      inputQueuePaused: incoming.inputQueuePaused,
      pendingRequests: incoming.pendingRequests,
      workspaceId: incoming.workspaceId,
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
      this.cover(evicted.workspaceId, evicted.stateSequence);
      this.#unloaded.delete(evictedId);
    }
  }

  clear(): void {
    this.#loaded.clear();
    this.#unloaded.clear();
    this.#coverageFloor.clear();
  }
}
