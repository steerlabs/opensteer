import { compareSequence, type Sequence } from "@opensteer/core";
import type { ThreadSummary } from "./client.js";

const unloadedThreadLimit = 128;

const contextFields = [
  "returnHint",
  "endedOrigin",
  "retry",
  "agentSessionId",
  "externalWork",
  "revision",
  "originConnectionId",
  "runQueued",
  "runStartHoldReason",
  "failureCode",
] as const satisfies readonly (keyof ThreadSummary)[];

type ThreadContext = Pick<ThreadSummary, (typeof contextFields)[number]>;

export type ThreadView = Pick<ThreadSummary, "title" | "icon"> &
  ThreadContext &
  Partial<
    Pick<
      ThreadSummary,
      | "doneAt"
      | "doneReason"
      | "latestRunCompletedAt"
      | "lastVisitedAt"
      | "status"
      | "inputQueuePaused"
    >
  >;

type OptionalThreadContext = {
  readonly [Field in keyof ThreadContext]?: ThreadContext[Field] | undefined;
};

type ThreadState = OptionalThreadContext &
  Pick<ThreadSummary, "status" | "pendingRequests" | "updatedAt"> & {
    readonly inputQueuePaused?: boolean | undefined;
    readonly compact?: boolean | undefined;
    readonly doneAt?: ThreadSummary["doneAt"] | undefined;
    readonly doneReason?: ThreadSummary["doneReason"] | undefined;
    readonly title?: string | undefined;
    readonly icon?: ThreadSummary["icon"] | undefined;
    readonly latestRunCompletedAt?: string | null | undefined;
    readonly stateSequence: Sequence;
  };

const stateFields = [
  "doneAt",
  "doneReason",
  "title",
  "icon",
  "latestRunCompletedAt",
  ...contextFields,
  "status",
  "inputQueuePaused",
  "compact",
  "pendingRequests",
] as const satisfies readonly (keyof ThreadState)[];

function threadContext(
  primary: OptionalThreadContext,
  fallback?: OptionalThreadContext,
): ThreadContext {
  return Object.fromEntries(
    contextFields.flatMap((key) => {
      const value = primary[key] === undefined ? fallback?.[key] : primary[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

type AcceptedThreadState = ThreadState & {
  readonly supplied: ReadonlySet<(typeof stateFields)[number]>;
};

export class ThreadStateProjection {
  readonly #loaded = new Map<string, AcceptedThreadState>();
  readonly #unloaded = new Map<string, AcceptedThreadState>();

  reconcile(
    summary: ThreadSummary,
    asOfSequence: Sequence,
    current?: ThreadSummary,
    compact?: {
      readonly inputQueuePaused?: boolean | undefined;
      readonly retry?: ThreadSummary["retry"];
    },
  ): ThreadSummary {
    const accepted = this.#accept(
      summary.id,
      {
        ...summary,
        ...(compact && {
          icon: undefined,
          inputQueuePaused: compact.inputQueuePaused,
          returnHint: undefined,
          endedOrigin: undefined,
          retry: compact.retry,
        }),
        compact: !!compact,
        stateSequence: asOfSequence,
      },
      true,
    );
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
      ...threadContext(state),
      doneAt: state.doneAt,
      doneReason: state.doneReason ?? null,
      title: state.title,
      icon: state.icon,
      latestRunCompletedAt:
        state.latestRunCompletedAt === undefined
          ? summary.latestRunCompletedAt
          : state.latestRunCompletedAt,
      status: state.status,
      inputQueuePaused: state.inputQueuePaused ?? summary.inputQueuePaused,
      pendingRequests: state.pendingRequests,
      updatedAt,
    };
  }

  /** The newest accepted state, for every held copy of the thread: page entries carry it too. */
  view(thread: ThreadSummary): ThreadView {
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
      // A page counts only the Requests its reader may see, so the count stays the page's.
      ...(state && {
        status: state.status,
        inputQueuePaused: state.inputQueuePaused ?? thread.inputQueuePaused,
        ...threadContext(state, thread),
      }),
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

  #accept(id: string, incoming: ThreadState, loaded = false): AcceptedThreadState {
    const previous = this.#loaded.get(id) ?? this.#unloaded.get(id);
    const order = previous ? compareSequence(incoming.stateSequence, previous.stateSequence) : 1;
    if (previous && order < 0) return previous;
    let supplied = new Set(stateFields.filter((key) => incoming[key] !== undefined));
    if (previous && order === 0) {
      // A command and the socket can describe the same revision. A value carried over from
      // an older revision leaves room for either of them to supply its current value.
      if (!(previous.compact && !incoming.compact)) {
        if ([...supplied].every((key) => previous.supplied.has(key))) return previous;
        incoming = Object.assign(
          { ...incoming },
          Object.fromEntries([...previous.supplied].map((key) => [key, previous[key]])),
        );
      }
      supplied = new Set([...previous.supplied, ...supplied]);
    }
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
      ...threadContext(incoming, previous),
      status: incoming.status,
      inputQueuePaused: incoming.inputQueuePaused ?? previous?.inputQueuePaused,
      compact: incoming.compact,
      pendingRequests: incoming.pendingRequests,
      stateSequence: incoming.stateSequence,
      supplied,
      updatedAt:
        previous && previous.updatedAt > incoming.updatedAt
          ? previous.updatedAt
          : incoming.updatedAt,
    };
    if (loaded || this.#loaded.has(id)) this.#loaded.set(id, state);
    else this.#remember(id, state);
    return state;
  }

  #remember(id: string, state: AcceptedThreadState): void {
    this.#unloaded.delete(id);
    this.#unloaded.set(id, state);
    if (this.#unloaded.size > unloadedThreadLimit) {
      this.#unloaded.delete(this.#unloaded.keys().next().value!);
    }
  }

  forget(threadId: string) {
    this.#loaded.delete(threadId);
    this.#unloaded.delete(threadId);
  }

  clear(): void {
    this.#loaded.clear();
    this.#unloaded.clear();
  }
}
