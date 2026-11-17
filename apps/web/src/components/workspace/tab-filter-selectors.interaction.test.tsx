// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { useTabDeviceChoice, useTabFilterMatches } from "@opensteer/client/react";
import {
  TabStore,
  type HostClient,
  type HostSnapshot,
  type TabDeviceChoice,
} from "@opensteer/client/host";
import { DeviceIdSchema, TabIdSchema, ThreadIdSchema } from "@opensteer/core";
import { tabFixture } from "@opensteer/client/test-support";
import * as tabList from "../../../../../packages/client/src/host/tab-list.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("derives tab matches and device counts only when the tab list changes", () => {
  const mock = new MockHostClient({ latencyMs: 0 });
  const base = mock.getSnapshot();
  // Spread over two computers, so the device choice has something to choose between.
  const computers = base.machines.slice(0, 2).map((machine) => ({
    computerId: DeviceIdSchema.parse(machine.id),
    name: machine.name,
  }));
  const rows = Array.from({ length: 1200 }, (_, i) =>
    tabFixture({ tabId: TabIdSchema.parse(`filter-${i}`), computer: computers[i % 2]! }),
  );
  const store = new TabStore();
  store.apply({ op: "begin", generation: "filter" });
  store.apply({ op: "rows", rows });
  store.apply({
    op: "end",
    revision: 0,
    count: rows.length,
    meta: {
      layout: { revision: 1, items: rows.map((row) => ({ kind: "tab", tabId: row.tabId })) },
    },
  });
  let snapshot: HostSnapshot = { ...base, tabs: store };
  const listeners = new Set<() => void>();
  const client = {
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
    // A title arriving changes no match and no count.
    store.apply({
      op: "change",
      generation: "filter",
      base: 0,
      revision: 1,
      update: [{ tabId: rows[1]!.tabId, title: "Renamed" }],
    });
    publish({ ...snapshot });
    expect(counts).not.toHaveBeenCalled();
    expect(matching).not.toHaveBeenCalled();
    expect(matches).toBe(before);
    store.apply({
      op: "change",
      generation: "filter",
      base: 1,
      revision: 2,
      update: [
        { tabId: rows[0]!.tabId, usedBy: [{ taskId: ThreadIdSchema.parse(base.threads[0]!.id) }] },
      ],
    });
    publish({ ...snapshot });
    expect(matches).toContain(rows[0]!.tabId);
    expect(counts).toHaveBeenCalledOnce();
    expect(choice!.devices.reduce((total, device) => total + device.count, 0)).toBeGreaterThan(0);
    store.apply({
      op: "change",
      generation: "filter",
      base: 2,
      revision: 3,
      remove: [rows[0]!.tabId],
    });
    publish({ ...snapshot });
    expect(matches).not.toContain(rows[0]!.tabId);
  } finally {
    act(() => root.unmount());
    counts.mockRestore();
    matching.mockRestore();
    mock.dispose();
  }
});
