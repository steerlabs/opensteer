// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { useTabDeviceChoice, useTabFilterMatches } from "@opensteer/client/react";
import type { HostClient, HostSnapshot, TabDeviceChoice } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema, ThreadIdSchema } from "@opensteer/core";
import * as tabList from "../../../../../packages/client/src/host/tab-list.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("derives tab matches and device counts only when their inputs change", () => {
  const mock = new MockHostClient({ latencyMs: 0 });
  let snapshot = mock.getSnapshot();
  const store = mock.browserTabs;
  const first = store.structure()[0]!;
  const template = store.tab(first.groupId, first.tabId)!;
  const rows = Array.from({ length: 10_000 }, (_, i) => ({
    ...template,
    id: BrowserSurfaceIdSchema.parse(`filter-${i}`),
    order: i,
    openerId: null,
    occupants: [],
  }));
  store.applyTabs(first.groupId, { op: "begin", generation: "filter" });
  store.applyTabs(first.groupId, { op: "rows", rows });
  store.applyTabs(first.groupId, { op: "end", revision: 0, count: rows.length, meta: {} });
  const listeners = new Set<() => void>();
  const client = {
    browserTabs: store,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as HostClient;
  const publish = (next: HostSnapshot) =>
    act(() => {
      snapshot = next;
      for (const listener of listeners) listener();
    });
  const filter = { agents: true, profile: null, device: null };
  let matches: ReadonlySet<string> | null = null;
  let choice: TabDeviceChoice;
  function Probe() {
    matches = useTabFilterMatches(client, filter);
    choice = useTabDeviceChoice(client, null, null, filter);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const counts = vi.spyOn(tabList, "tabDeviceChoice");
  const matching = vi.spyOn(tabList, "tabMatchesFilter");
  try {
    act(() => root.render(<Probe />));
    const before = matches;
    counts.mockClear();
    matching.mockClear();
    for (let i = 0; i < 20; i++) publish({ ...snapshot, transcripts: { ...snapshot.transcripts } });
    expect(counts).not.toHaveBeenCalled();
    expect(matching).not.toHaveBeenCalled();
    expect(matches).toBe(before);
    store.applyTabs(first.groupId, {
      op: "change",
      generation: "filter",
      base: 0,
      revision: 1,
      update: [{ id: rows[0]!.id, title: "New title" }],
    });
    publish({ ...snapshot });
    expect(counts).not.toHaveBeenCalled();
    expect(matching).not.toHaveBeenCalled();
    const occupant = {
      threadId: ThreadIdSchema.parse(snapshot.homeThreadId!),
      home: true,
      holding: true,
      acting: false,
      lastActiveAt: "2026-11-01T00:00:00.000Z",
    };
    store.applyTabs(first.groupId, {
      op: "change",
      generation: "filter",
      base: 1,
      revision: 2,
      update: [{ id: rows[0]!.id, occupants: [occupant] }],
    });
    publish({ ...snapshot });
    expect(matches).toContain(`browser:${first.sessionId}:${rows[0]!.id}`);
    expect(counts).toHaveBeenCalledOnce();
    expect(choice!.devices.reduce((total, device) => total + device.count, 0)).toBeGreaterThan(0);
    store.applyTabs(first.groupId, {
      op: "change",
      generation: "filter",
      base: 2,
      revision: 3,
      remove: [rows[0]!.id],
    });
    publish({ ...snapshot });
    expect(matches).not.toContain(`browser:${first.sessionId}:${rows[0]!.id}`);
  } finally {
    act(() => root.unmount());
    counts.mockRestore();
    matching.mockRestore();
    mock.dispose();
  }
});
