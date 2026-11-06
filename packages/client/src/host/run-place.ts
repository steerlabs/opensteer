import {
  compareSequence,
  type EventData,
  type Sequence,
  type PlaceEnteredEventView,
} from "@opensteer/core";
import { computerAppIdentityKey, type MachineSummary } from "@opensteer/protocol";
import type { BrowserSessionSummary, HostSnapshot } from "./client.js";
import { phoneTabOpen } from "./phone-tab.js";
import type { SurfaceDestination } from "./surfaces.js";

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
  reconcile(
    workspaceId: string,
    sequence: Sequence,
    events: readonly PlaceEnteredEventView[],
  ): void {
    const present = new Set(events.map((event) => event.runId));
    for (const event of this.#values.values())
      if (
        event.workspaceId === workspaceId &&
        compareSequence(event.sequence, sequence) <= 0 &&
        !present.has(event.runId)
      )
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

/** A viewing binding never decides whether the Run's place exists. */
export function runPlaceDestination(
  entry: { readonly runId: string; readonly data: Pick<EventData<"place.entered">, "place"> },
  snapshot: {
    readonly machines: readonly MachineSummary[];
    readonly browserSessions?: readonly BrowserSessionSummary[];
    readonly workspaceTabs?: HostSnapshot["workspaceTabs"];
  },
): SurfaceDestination | null {
  const place = entry.data.place;
  if (place.kind === "browser") {
    const durable = snapshot.workspaceTabs
      ?.flatMap((group) => group.tabs ?? [])
      .find((tab) => tab.id === place.surfaceId);
    const candidates = snapshot.browserSessions?.filter(
      (session) =>
        session.state === "ready" &&
        session.tabCatalog?.tabs.some((tab) => tab.id === place.surfaceId),
    );
    const ready =
      candidates?.find((session) => session.id === durable?.sessionId) ?? candidates?.[0];
    return { kind: "browser", sessionId: ready?.id ?? place.sessionId, tabId: place.surfaceId };
  }
  const machine = snapshot.machines.find((machine) => machine.id === place.machineId);
  if (place.kind === "phone")
    return machine && phoneTabOpen(machine) ? { kind: "phone", machineId: machine.id } : null;
  const sessionId = runPlaceSessionId(entry, snapshot);
  if (sessionId === null) return null;
  return {
    kind: "app",
    machineId: place.machineId,
    appKey: place.appKey,
    computerSessionId: sessionId,
    source: { kind: "task-session", sessionId },
  };
}

/** The Run's own session in a native place, which a picture of its work reads. */
export function runPlaceSessionId(
  entry: { readonly runId: string; readonly data: Pick<EventData<"place.entered">, "place"> },
  snapshot: { readonly machines: readonly MachineSummary[] },
): string | null {
  const place = entry.data.place;
  if (place.kind === "browser") return null;
  const session = snapshot.machines
    .find((machine) => machine.id === place.machineId)
    ?.computerUse?.sessions.find(
      (session) =>
        session.runId === entry.runId &&
        (place.kind === "phone"
          ? session.display
          : session.apps.some((app) => computerAppIdentityKey(app) === place.appKey)),
    );
  return session?.sessionId ?? null;
}
