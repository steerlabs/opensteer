import { placeIdentityKey, type ThreadPlaceReference } from "@opensteer/protocol";
import { placeList, type PlaceListSource, type ThreadPlace } from "./places.js";

/**
 * Each Thread's newest place, exactly as the Host named it. A reference
 * outlives its pointer's expiry; the place list decides only whether its
 * picture is still live.
 */
export class LatestPlaceStore {
  readonly #references = new Map<string, ThreadPlaceReference>();
  readonly #values = new Map<string, ThreadPlace>();
  readonly #listeners = new Map<string, Set<() => void>>();
  #source: PlaceListSource | null = null;
  #itemsByKey = new Map<string, ReturnType<typeof placeList>[number]>();
  readonly get = (threadId: string): ThreadPlace | null => this.#values.get(threadId) ?? null;
  readonly subscribe = (threadId: string, listener: () => void): (() => void) => {
    const listeners = this.#listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(threadId);
    };
  };
  accept(reference: ThreadPlaceReference): void {
    const previous = this.#references.get(reference.threadId);
    if (
      previous &&
      (previous.at > reference.at ||
        (previous.at === reference.at && previous.order >= reference.order))
    )
      return;
    if (!previous && this.#references.size >= 4096) {
      const oldest = this.#references.keys().next().value!;
      this.#references.delete(oldest);
      this.#values.delete(oldest);
      for (const listener of this.#listeners.get(oldest) ?? []) listener();
    }
    this.#references.set(reference.threadId, reference);
    this.#publish(reference.threadId);
  }
  reconcile(source: PlaceListSource, references: readonly ThreadPlaceReference[] = []): void {
    this.#source = source;
    this.#itemsByKey = new Map(placeList(source).map((item) => [item.key, item]));
    for (const reference of references) this.accept(reference);
    for (const threadId of this.#references.keys()) this.#publish(threadId);
  }
  #publish(threadId: string): void {
    const reference = this.#references.get(threadId);
    if (!this.#source || !reference) return;
    const identityKey = placeIdentityKey(reference.place);
    const item =
      reference.place.kind === "browser"
        ? this.#itemsByKey.get(identityKey)
        : [...this.#itemsByKey.values()].find((item) => {
            const destination = item.destination;
            const session =
              destination.kind !== "browser" && !item.ownerView
                ? this.#source?.machines
                    .find((machine) => machine.id === destination.machineId)
                    ?.computerUse?.sessions.find(
                      (session) => session.sessionId === destination.computerSessionId,
                    )
                : null;
            return (
              !item.ownerView &&
              destination.kind === reference.place.kind &&
              destination.kind !== "browser" &&
              reference.place.kind !== "browser" &&
              destination.machineId === reference.place.machineId &&
              session?.threadId === threadId &&
              (!reference.runId || session.runId === reference.runId) &&
              (destination.kind === "app" && reference.place.kind === "app"
                ? destination.appKey === reference.place.appKey
                : destination.kind === "phone" &&
                  reference.place.kind === "phone" &&
                  (destination.display ?? "main") === reference.place.display)
            );
          });
    const placeKey = item?.key ?? identityKey;
    const value: ThreadPlace = {
      placeKey,
      runId: reference.runId ?? null,
      title: item?.title ?? reference.title,
      site: reference.site,
      destination: item?.taskDestination ?? null,
    };
    const old = this.get(threadId);
    if (
      old?.placeKey === value.placeKey &&
      old.runId === value.runId &&
      old.title === value.title &&
      old.site === value.site &&
      JSON.stringify(old.destination) === JSON.stringify(value.destination)
    )
      return;
    this.#values.set(threadId, value);
    for (const listener of this.#listeners.get(threadId) ?? []) listener();
  }
  clear(): void {
    const ids = [...this.#values.keys()];
    this.#values.clear();
    this.#references.clear();
    this.#source = null;
    this.#itemsByKey.clear();
    for (const id of ids) for (const listener of this.#listeners.get(id) ?? []) listener();
  }
  dispose(): void {
    this.clear();
    this.#listeners.clear();
  }
}
