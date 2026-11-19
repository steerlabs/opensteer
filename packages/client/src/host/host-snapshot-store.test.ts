import { describe, expect, it, vi } from "vitest";
import type { HostClient, TranscriptFixtureSnapshot } from "./client.js";
import { sameStableHostSnapshot } from "./host-snapshot-selectors.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  createHostSelection,
  hostSnapshotStore,
  type HostSelection,
} from "./host-snapshot-store.js";

describe("Host snapshot selectors", () => {
  it("publishes platform reachability changes even when Host connection state is unchanged", () => {
    const harness = clientHarness();
    const store = hostSnapshotStore(harness.client);
    const selection = createHostSelection(store, (snapshot) => snapshot, sameStableHostSnapshot);
    const observer = observeSelection(selection);
    harness.publish({ ...harness.snapshot(), network: "offline" });
    expect(observer.renderCount()).toBe(2);
    expect(observer.value().network).toBe("offline");
    observer.unsubscribe();
  });

  it("publishes pending profile erasure changes to settings without other catalog changes", () => {
    const harness = clientHarness();
    const store = hostSnapshotStore(harness.client);
    const selection = createHostSelection(store, (snapshot) => snapshot, sameStableHostSnapshot);
    const observer = observeSelection(selection);
    try {
      for (const state of ["pending-computer", "pending-restart"] as const) {
        const browserProfileDeletions = [
          { profileId: "bpr_deleted", computerId: "rnr_owner", state },
        ];
        harness.publish({ ...harness.snapshot(), browserProfileDeletions });
        expect(observer.value().browserProfileDeletions).toEqual(browserProfileDeletions);
      }
      harness.publish({ ...harness.snapshot(), browserProfileDeletions: [] });
      expect(observer.value().browserProfileDeletions).toEqual([]);
      expect(observer.renderCount()).toBe(4);
    } finally {
      observer.unsubscribe();
    }
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
    const observer = observeSelection(selection);

    const activity = transcriptActivity(harness.snapshot());
    harness.publish(activity);
    expect(observer.renderCount()).toBe(1);
    expect(observer.value()).toBe(harness.initialSnapshot);

    const thread = activity.threads[0];
    expect(thread).toBeDefined();
    const status = thread?.status === "failed" ? "idle" : "failed";
    const semanticChange: TranscriptFixtureSnapshot = {
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

  it("notifies only the selections whose slice one shell change moved", () => {
    const harness = clientHarness();
    const store = hostSnapshotStore(harness.client);
    const visits = vi.fn();
    const machines = vi.fn();
    const counts = vi.fn();
    const releases = [
      createHostSelection(store, (snapshot) => snapshot.threadVisits).subscribe(visits),
      createHostSelection(store, (snapshot) => snapshot.machines).subscribe(machines),
      createHostSelection(store, (snapshot) => snapshot.needsYouCount ?? 0).subscribe(counts),
    ];
    harness.publish({
      ...harness.snapshot(),
      threadVisits: { ...harness.snapshot().threadVisits, thr_seen: "2026-11-18T00:00:00.000Z" },
    });
    expect(visits).toHaveBeenCalledTimes(1);
    expect(machines).not.toHaveBeenCalled();
    expect(counts).not.toHaveBeenCalled();
    for (const release of releases) release();
  });

  it("updates a stable shell consumer when the authenticated surface changes", () => {
    const harness = clientHarness();
    const store = hostSnapshotStore(harness.client);
    const selection = createHostSelection(store, (snapshot) => snapshot, sameStableHostSnapshot);
    const observer = observeSelection(selection);

    const remote: TranscriptFixtureSnapshot = {
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

function observeSelection<Selection>(selection: HostSelection<Selection>) {
  let value = selection.getSnapshot();
  let renderCount = 1;
  // A notification is a render: the selection calls back only when its value changed.
  const unsubscribe = selection.subscribe(() => {
    value = selection.getSnapshot();
    renderCount += 1;
  });
  return {
    renderCount: () => renderCount,
    unsubscribe,
    value: () => value,
  };
}

function transcriptActivity(snapshot: TranscriptFixtureSnapshot): TranscriptFixtureSnapshot {
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
    publish: (next: TranscriptFixtureSnapshot) => {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    snapshot: () => snapshot,
    subscribe,
    unsubscribe,
  };
}
