import {
  compareSequence,
  type Sequence,
  type TabKind,
  type PlaceEnteredEventView,
} from "@opensteer/core";
import type { HostSnapshot } from "./client.js";
import type { TabDestination } from "./surfaces.js";

/** Current Run places live outside every transcript window and catalog. */
export class RunPlaceStore {
  readonly #values = new Map<string, PlaceEnteredEventView>();
  readonly #ended = new Set<string>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #changed = new Set<string>();
  readonly get = (runId: string): PlaceEnteredEventView | null => this.#values.get(runId) ?? null;
  readonly subscribe = (runId: string, listener: () => void): (() => void) => {
    const listeners = this.#listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(runId);
    };
  };
  accept(event: PlaceEnteredEventView, notify = true): void {
    const previous = this.#values.get(event.runId);
    if (
      this.#ended.has(event.runId) ||
      (previous && compareSequence(previous.sequence, event.sequence) >= 0)
    )
      return;
    this.#values.set(event.runId, event);
    this.#changed.add(event.runId);
    if (notify) this.flush();
  }
  seed(events: readonly PlaceEnteredEventView[], notify = true): void {
    for (const event of events) this.accept(event, false);
    if (notify) this.flush();
  }
  reconcile(sequence: Sequence, events: readonly PlaceEnteredEventView[]): void {
    const present = new Set(events.map((event) => event.runId));
    for (const event of this.#values.values())
      if (compareSequence(event.sequence, sequence) <= 0 && !present.has(event.runId))
        this.end(event.runId, false);
    this.seed(events, false);
  }
  end(runId: string, notify = true): void {
    this.#ended.add(runId);
    // Like the Run queue, fence late reads without retaining every past Run forever.
    if (this.#ended.size > 4096) this.#ended.delete(this.#ended.values().next().value!);
    if (this.#values.delete(runId)) this.#changed.add(runId);
    if (notify) this.flush();
  }
  /** Publish after the Host snapshot, so terminal Runs and reply chips change together. */
  flush(): void {
    const changed = [...this.#changed];
    this.#changed.clear();
    for (const id of changed) for (const listener of this.#listeners.get(id) ?? []) listener();
  }
  clear(): void {
    for (const id of this.#values.keys()) this.#changed.add(id);
    this.#values.clear();
    this.#ended.clear();
    this.flush();
  }
  dispose(): void {
    this.clear();
    this.#listeners.clear();
  }
}

/** A Run's place is its tab while the person's list holds it; a closed tab is no destination. */
export function runPlaceDestination(
  entry: { readonly runId: string; readonly data: Pick<PlaceEnteredEventView["data"], "tabId"> },
  snapshot: Pick<HostSnapshot, "tabs">,
): TabDestination | null {
  return snapshot.tabs.get(entry.data.tabId) ? { kind: "tab", tabId: entry.data.tabId } : null;
}

/** The Run's own session at a window or phone tab, which a picture of its work reads. */
export function runPlaceSessionId(
  entry: { readonly runId: string; readonly data: Pick<PlaceEnteredEventView["data"], "tabId"> },
  snapshot: Pick<HostSnapshot, "tabs" | "machines">,
): string | null {
  const tab = snapshot.tabs.get(entry.data.tabId);
  if (!tab || (tab.kind !== "window" && tab.kind !== "phone")) return null;
  const session = snapshot.machines
    .find((machine) => machine.id === tab.computer.computerId)
    ?.computerUse?.sessions.find(
      (session) =>
        session.runId === entry.runId &&
        (tab.kind === "phone"
          ? session.display
          : session.apps.some((app) => app.bundleId === tab.bundleId)),
    );
  return session?.sessionId ?? null;
}

/**
 * The session whose picture shows a Run's place. A window or phone session
 * shows its app's current window, which is this tab's only while the Host's
 * activity for this exact tab is the Run's latest: that record moves with the
 * Run between windows, so another window's picture never shows under this tab.
 */
export function runPlacePictureSession(
  kind: TabKind | undefined,
  sessionId: string | null,
  runId: string,
  activity: readonly { readonly runId: string }[],
): string | null {
  if (kind !== "window" && kind !== "phone") return sessionId;
  return activity.some((record) => record.runId === runId) ? sessionId : null;
}
