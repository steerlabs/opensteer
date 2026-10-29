/* Failure modes: layout requests overtake each other; failure rolls back another edit;
 * replay throws or guesses when an anchor vanishes; an acknowledgement restores an
 * older base or closed tabs; group/ungroup break order; queued edits cross accounts. */
import { describe, expect, it, vi } from "vitest";
import {
  BrowserSurfaceIdSchema,
  BrowserTabGroupIdSchema,
  type BrowserTabOrderTab,
} from "@opensteer/core";
import type { BrowserTabLayout, HostApiClient } from "@opensteer/protocol";
import { BrowserTabGroupClient } from "./browser-tab-groups.js";

const a = BrowserSurfaceIdSchema.parse("surface_a");
const b = BrowserSurfaceIdSchema.parse("surface_b");
const c = BrowserSurfaceIdSchema.parse("surface_c");
const d = BrowserSurfaceIdSchema.parse("surface_d");
const groupId = BrowserTabGroupIdSchema.parse("btg_00000000-0000-4000-8000-000000000001");
const group = {
  id: groupId,
  title: "Reading",
  color: "blue" as const,
  collapsed: false,
  tabIds: [a, b],
};
function fixture(
  initial: BrowserTabLayout = { revision: 1, order: [a, b, c, d], groups: [group] },
) {
  let tabs: BrowserTabOrderTab[] = [a, b, c, d].map((id, order) => ({
    id,
    openerId: null,
    createdAt: "2026-10-25T00:00:00.000Z",
    lineageCreatedAt: "2026-10-25T00:00:00.000Z",
    order,
  }));
  const requests: {
    type: string;
    resolve: (layout: BrowserTabLayout) => void;
    reject: (error: Error) => void;
  }[] = [];
  const dispatch = vi.fn(
    (command: { type: string }) =>
      new Promise((resolve, reject) => {
        requests.push({
          type: command.type,
          resolve: (layout) => resolve({ ok: true, data: { type: command.type, layout, groupId } }),
          reject,
        });
      }),
  );
  let layout: BrowserTabLayout | undefined;
  let authority = 1;
  const client = new BrowserTabGroupClient(
    { "commands.dispatch": dispatch } as unknown as HostApiClient,
    (next) => {
      layout = next;
    },
    () => authority,
    () => tabs,
  );
  layout = client.receive(initial);
  return {
    client,
    requests,
    dispatch,
    get layout() {
      return layout!;
    },
    set tabs(next: BrowserTabOrderTab[]) {
      tabs = next;
    },
    set authority(next: number) {
      authority = next;
    },
  };
}

describe("ordered personal tab edits", () => {
  it("publishes synchronously and sends moves, grouping, ungrouping and updates one at a time", async () => {
    const f = fixture();
    const moved = f.client.moveBrowserTabs({
      item: { tabIds: [d] },
      to: { groupId: null, before: { groupId } },
    });
    expect(f.layout.order).toEqual([d, a, b, c]);
    const grouped = f.client.groupBrowserTabs([c], { groupId });
    expect(f.layout.order).toEqual([d, a, b, c]);
    expect(f.layout.groups[0]!.tabIds).toEqual([a, b, c]);
    const ungrouped = f.client.ungroupBrowserTabs([a]);
    expect(f.layout.order).toEqual([d, b, c, a]);
    const updated = f.client.updateBrowserTabGroup(groupId, { collapsed: true });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]!.type).toBe("workspace.tabs.move");
    f.requests[0]!.resolve({ revision: 2, order: [d, a, b, c], groups: [group] });
    await moved;
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.requests[1]!.type).toBe("workspace.tabs.group");
    f.requests[1]!.resolve({
      revision: 3,
      order: [d, a, b, c],
      groups: [{ ...group, tabIds: [a, b, c] }],
    });
    await grouped;
    await vi.waitFor(() => expect(f.requests).toHaveLength(3));
    expect(f.requests[2]!.type).toBe("workspace.tabs.ungroup");
    f.requests[2]!.resolve({
      revision: 4,
      order: [d, b, c, a],
      groups: [{ ...group, tabIds: [b, c] }],
    });
    await ungrouped;
    await vi.waitFor(() => expect(f.requests).toHaveLength(4));
    expect(f.requests[3]!.type).toBe("workspace.tabGroup.update");
    f.requests[3]!.resolve({ ...f.layout, revision: 5 });
    await updated;
    expect(f.layout.order).toEqual([d, b, c, a]);
    expect(f.layout.groups[0]!.collapsed).toBe(true);
  });

  it("replays a vanished anchor as a no-op and removes only the refused move", async () => {
    const f = fixture();
    const moved = f.client.moveBrowserTabs({
      item: { tabIds: [d] },
      to: { groupId: null, before: { tabId: c } },
    });
    const updated = f.client.updateBrowserTabGroup(groupId, { title: "Still pending" });
    f.tabs = [a, b, d].map((id, order) => ({
      id,
      order,
      openerId: null,
      createdAt: "2026-10-25T00:00:00.000Z",
      lineageCreatedAt: "2026-10-25T00:00:00.000Z",
    }));
    const base = { revision: 4, order: [a, b, d], groups: [group] };
    expect(() => f.client.receive(base)).not.toThrow();
    expect(f.client.receive(base)?.order).toEqual([a, b, d]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const error = new Error("The anchor closed");
    const refused = expect(moved).rejects.toBe(error);
    f.requests[0]!.reject(error);
    await refused;
    expect(f.layout.groups[0]!.title).toBe("Still pending");
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    f.requests[1]!.resolve({
      ...base,
      revision: 5,
      groups: [{ ...group, title: "Still pending" }],
    });
    await updated;
    expect(f.layout.order).toEqual([a, b, d]);
  });

  it("retires an acknowledged patch without overwriting a newer equal-revision refresh", async () => {
    const f = fixture();
    const moved = f.client.moveBrowserTabs({
      item: { tabIds: [d] },
      to: { groupId: null, before: { tabId: c } },
    });
    f.client.receive({ revision: 2, order: [a, b, d], groups: [group] });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.requests[0]!.resolve({ revision: 2, order: [a, b, d, c], groups: [group] });
    await moved;
    expect(f.layout.order).toEqual([a, b, d]);
    f.client.removeClosed([a, b]);
    expect(f.layout.groups).toEqual([]);
    expect(f.layout.order).toEqual([d]);
  });

  it("does not send an old account's queued edits under a new authority", async () => {
    const f = fixture();
    const first = f.client.updateBrowserTabGroup(groupId, { title: "Old" });
    const second = f.client.ungroupBrowserTabs([a]);
    const firstRefused = expect(first).rejects.toThrow("account changed");
    const secondRefused = expect(second).rejects.toThrow("account changed");
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.authority = 2;
    f.client.receive({ revision: 1, order: [a, b], groups: [group] });
    f.requests[0]!.resolve({ revision: 2, order: [a, b], groups: [{ ...group, title: "Old" }] });
    await firstRefused;
    await secondRefused;
    expect(f.requests).toHaveLength(1);
  });
});
