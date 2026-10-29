import { describe, expect, it, vi } from "vitest";
import type { HostClient, HostSnapshot } from "./client.js";
import { sameStableHostSnapshot } from "./host-snapshot-selectors.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  createHostSelection,
  hostSnapshotStore,
  type HostSelection,
  type HostSnapshotStore,
} from "./host-snapshot-store.js";

describe("Host snapshot selectors", () => {
  it("publishes platform reachability changes even when Host connection state is unchanged", () => {
    const harness = clientHarness();
    const store = hostSnapshotStore(harness.client);
    const selection = createHostSelection(store, (snapshot) => snapshot, sameStableHostSnapshot);
    const observer = observeSelection(store, selection);
    harness.publish({ ...harness.snapshot(), network: "offline" });
    expect(observer.renderCount()).toBe(2);
    expect(observer.value().network).toBe("offline");
    observer.unsubscribe();
  });

  it("multiplexes every consumer through one HostClient subscription", () => {
    const harness = clientHarness();
    const firstStore = hostSnapshotStore(harness.client);
    const secondStore = hostSnapshotStore(harness.client);
    expect(secondStore).toBe(firstStore);

    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = firstStore.subscribe(first);
    const unsubscribeSecond = secondStore.subscribe(second);

    expect(harness.subscribe).toHaveBeenCalledTimes(1);
    harness.publish(transcriptActivity(harness.snapshot()));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    expect(harness.unsubscribe).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps a stable shell consumer at one render during transcript activity", () => {
    const harness = clientHarness();
    const store = hostSnapshotStore(harness.client);
    const selection = createHostSelection(store, (snapshot) => snapshot, sameStableHostSnapshot);
    const observer = observeSelection(store, selection);

    const activity = transcriptActivity(harness.snapshot());
    harness.publish(activity);
    expect(observer.renderCount()).toBe(1);
    expect(observer.value()).toBe(harness.initialSnapshot);

    const thread = activity.threads[0];
    expect(thread).toBeDefined();
    const status = thread?.status === "failed" ? "idle" : "failed";
    const semanticChange: HostSnapshot = {
      ...activity,
      revision: activity.revision + 1,
      threads: activity.threads.map((candidate, index) =>
        index === 0 ? { ...candidate, status } : candidate,
      ),
    };
    harness.publish(semanticChange);

    expect(observer.renderCount()).toBe(2);
    expect(observer.value()).toBe(semanticChange);
    observer.unsubscribe();
  });

  it("updates a stable shell consumer when the authenticated surface changes", () => {
    const harness = clientHarness();
    const store = hostSnapshotStore(harness.client);
    const selection = createHostSelection(store, (snapshot) => snapshot, sameStableHostSnapshot);
    const observer = observeSelection(store, selection);

    const remote: HostSnapshot = {
      ...harness.snapshot(),
      revision: harness.snapshot().revision + 1,
      sessionSurface: "personal-remote",
    };
    harness.publish(remote);

    expect(observer.renderCount()).toBe(2);
    expect(observer.value()).toBe(remote);
    observer.unsubscribe();
  });
});

function observeSelection<Selection>(
  store: HostSnapshotStore,
  selection: HostSelection<Selection>,
) {
  let value = selection.getSnapshot();
  let renderCount = 1;
  const unsubscribe = store.subscribe(() => {
    const next = selection.getSnapshot();
    if (Object.is(next, value)) return;
    value = next;
    renderCount += 1;
  });
  return {
    renderCount: () => renderCount,
    unsubscribe,
    value: () => value,
  };
}

function transcriptActivity(snapshot: HostSnapshot): HostSnapshot {
  const timestamp = new Date(
    Date.parse(snapshot.threads[0]?.updatedAt ?? "2026-01-01") + 1,
  ).toISOString();
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    threads: snapshot.threads.map((thread, index) =>
      index === 0 ? { ...thread, updatedAt: timestamp } : thread,
    ),
    transcripts: { ...snapshot.transcripts, __stream_activity__: [] },
    workspaces: snapshot.workspaces.map((workspace, index) =>
      index === 0 ? { ...workspace, updatedAt: timestamp } : workspace,
    ),
  };
}

function clientHarness() {
  const initialSnapshot = new MockHostClient({ latencyMs: 0 }).getSnapshot();
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      unsubscribe();
    };
  });
  const client = {
    getSnapshot: () => snapshot,
    subscribe,
  } as unknown as HostClient;

  return {
    client,
    initialSnapshot,
    publish: (next: HostSnapshot) => {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    snapshot: () => snapshot,
    subscribe,
    unsubscribe,
  };
}
