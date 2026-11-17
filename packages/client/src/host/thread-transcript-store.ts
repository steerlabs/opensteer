import type { ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import type { TranscriptItem } from "@opensteer/protocol/transcript";

type Frame = Extract<
  ScopedHostMessage,
  {
    type:
      | "host.snapshot"
      | "host.changes"
      | "host.synchronized"
      | "host.removed"
      | "host.snapshot-required";
  }
>;
type DetailSnapshot = Extract<
  Extract<Frame, { type: "host.snapshot" }>["snapshot"],
  { items: unknown }
>;
type Listener = () => void;

export interface TranscriptState {
  readonly generation: number;
  readonly through: string | null;
  readonly synchronized: boolean;
  readonly items: ReadonlyMap<string, TranscriptItem>;
  readonly ids: readonly string[];
  readonly stale: ReadonlySet<string>;
  readonly snapshot: DetailSnapshot | null;
}

const emptyState: TranscriptState = {
  generation: 0,
  through: null,
  synchronized: false,
  items: new Map(),
  ids: [],
  stale: new Set(),
  snapshot: null,
};

function comparePosition(a: TranscriptItem, b: TranscriptItem) {
  const delta = BigInt(a.position) - BigInt(b.position);
  return delta < 0n ? -1 : delta > 0n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class ThreadTranscriptStore {
  readonly #listeners = new Set<Listener>();
  #state: TranscriptState = emptyState;

  getSnapshot = () => this.#state;

  subscribe = (listener: Listener) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  begin(generation: number, retained: boolean) {
    if (generation <= this.#state.generation) return;
    this.#set({ ...(retained ? this.#state : emptyState), generation, synchronized: false });
  }

  apply(frame: Frame): boolean {
    const state = this.#state;
    if (frame.generation !== state.generation || frame.scope.kind === "shell") return false;
    switch (frame.type) {
      case "host.removed":
        this.#set({ ...emptyState, generation: state.generation });
        return true;
      case "host.snapshot-required":
        this.#set({ ...state, through: null, synchronized: false });
        return true;
      case "host.synchronized":
        if (frame.throughSequence !== state.through) return false;
        if (!state.synchronized) this.#set({ ...state, synchronized: true });
        return true;
      case "host.snapshot": {
        if ("tasks" in frame.snapshot) return false;
        const items = new Map(
          frame.snapshot.items.map((item) => [
            item.id,
            state.items.get(item.id)?.revision === item.revision ? state.items.get(item.id)! : item,
          ]),
        );
        this.#set({
          ...state,
          through: frame.throughSequence,
          snapshot: frame.snapshot,
          synchronized: false,
          items,
          ids: frame.snapshot.items.map(({ id }) => id),
          stale: new Set(),
        });
        return true;
      }
      case "host.changes": {
        if (
          frame.fromSequence !== state.through ||
          BigInt(frame.throughSequence) <= BigInt(frame.fromSequence)
        )
          return false;
        let items: Map<string, TranscriptItem> | undefined;
        let stale: Set<string> | undefined;
        let orderChanged = false;
        for (const change of frame.changes) {
          if (change.operation === "invalidate") {
            stale ??= new Set(state.stale);
            stale.add(change.entityId);
            continue;
          }
          if (change.entityKind !== "item") continue;
          const previous = (items ?? state.items).get(change.entityId);
          if (change.operation === "remove") {
            if (!previous) continue;
            items ??= new Map(state.items);
            items.delete(change.entityId);
            orderChanged = true;
          } else {
            if (previous && BigInt(previous.revision) >= BigInt(change.value.revision)) continue;
            items ??= new Map(state.items);
            items.set(change.entityId, change.value);
            orderChanged ||= previous?.position !== change.value.position;
          }
        }
        const ids =
          orderChanged && items
            ? [...items.values()].sort(comparePosition).map(({ id }) => id)
            : state.ids;
        this.#set({
          ...state,
          through: frame.throughSequence,
          items: items ?? state.items,
          ids,
          stale: stale ?? state.stale,
        });
        return true;
      }
    }
  }

  #set(state: TranscriptState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
