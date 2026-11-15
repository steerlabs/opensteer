import { BrowserSurfaceIdSchema, type TabId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "./mock-host-client.js";
import { layoutTabIds } from "../host/tab-store.js";
import { placeList } from "../host/places.js";
import { runPages } from "../host/surfaces.js";

/** The browser session this device is shown a page tab through. */
async function pageSession(client: MockHostClient, tabId: TabId) {
  const viewer = await client.activateTab(tabId);
  if (viewer.kind !== "page") throw new Error("Expected a page viewer");
  return { sessionId: viewer.sessionId, tabId: viewer.surfaceId };
}

describe("moving mock workspace", () => {
  it("moves cursors independently, churns tabs and shares targeted demand", async () => {
    vi.useFakeTimers();
    const client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
    try {
      const loading = client.load();
      await vi.advanceTimersByTimeAsync(0);
      await loading;
      const places = placeList(client.getSnapshot());
      const snapshot = client.getSnapshot();
      const running = (place: (typeof places)[number]) =>
        place.occupants.find((occupant) =>
          snapshot.runQueue.some(
            (run) => run.threadId === occupant.threadId && run.status === "running",
          ),
        );
      const browser = places.find((place) => place.kind === "page" && running(place))!;
      const homeRun = snapshot.runQueue.find(
        (run) => run.threadId === running(browser)!.threadId && run.status === "running",
      )!;
      expect(client.runPlace(homeRun.id)).toMatchObject({
        runId: homeRun.id,
        data: { tabId: browser.key, title: browser.title },
      });
      expect(client.placeActivity(browser.key)[0]?.runId).toBe(homeRun.id);
      expect(runPages(snapshot.browserUses, snapshot, [homeRun.id])).toContainEqual(
        expect.objectContaining({ destination: browser.destination, title: browser.title }),
      );
      const { sessionId, tabId } = await pageSession(client, browser.key);
      const updates = vi.fn();
      client.subscribePlaceActivity(browser.key, updates);
      const first = client.placeActivity(browser.key)[0];
      vi.advanceTimersByTime(250);
      expect(client.placeActivity(browser.key)[0]?.seq).toBeGreaterThan(first?.seq ?? 0);
      expect(updates).toHaveBeenCalled();
      const releaseA = client.retainBrowserWatch(sessionId, tabId);
      const releaseB = client.retainBrowserWatch(sessionId, tabId);
      expect(client.browserWatchFrame(sessionId, tabId)?.header.surfaceId).toBe(tabId);
      // A page given a new size draws in new geometry, and its agents' pointers follow it.
      client.sendBrowserCommand(sessionId, {
        type: "viewport.follow",
        surfaceId: BrowserSurfaceIdSchema.parse(tabId),
        width: 700,
        height: 500,
      });
      vi.advanceTimersByTime(250);
      const resized = client.browserWatchFrame(sessionId, tabId)!.header;
      expect(resized.geometryRevision).toBeGreaterThan(1);
      expect(client.placeActivity(browser.key)[0]?.geometryRevision).toBe(resized.geometryRevision);
      releaseA();
      expect(client.browserWatchFrame(sessionId, tabId)).not.toBeNull();
      releaseB();
      expect(client.browserWatchFrame(sessionId, tabId)).toBeNull();
      vi.advanceTimersByTime(8000);
      expect(placeList(client.getSnapshot()).map((place) => place.key)).not.toEqual(
        places.map((place) => place.key),
      );
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });
  it("sends a tab watched again a picture its viewer has not finished", async () => {
    vi.useFakeTimers();
    const client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
    try {
      const loading = client.load();
      await vi.advanceTimersByTimeAsync(0);
      await loading;
      const [one, two] = placeList(client.getSnapshot()).filter((place) => place.kind === "page");
      const { sessionId, tabId: firstId } = await pageSession(client, one!.key);
      const first = { id: firstId };
      const second = { id: (await pageSession(client, two!.key)).tabId };
      // A tile scrolls into view, shows its picture, scrolls away and back within one tick.
      const release = client.retainBrowserWatch(sessionId, first!.id);
      const shown = client.browserWatchFrame(sessionId, first!.id)!;
      client.acceptBrowserWatchFrame(sessionId, shown.header.watchToken!, first!.id);
      release();
      client.retainBrowserWatch(sessionId, first!.id);
      expect(client.browserWatchFrame(sessionId, first!.id)!.header.watchToken).not.toBe(
        shown.header.watchToken,
      );
      // Another tile coming into view never re-sends one already finished.
      const next = client.browserWatchFrame(sessionId, first!.id)!;
      client.acceptBrowserWatchFrame(sessionId, next.header.watchToken!, first!.id);
      client.retainBrowserWatch(sessionId, second!.id);
      expect(client.browserWatchFrame(sessionId, first!.id)!.header.watchToken).not.toBe(
        next.header.watchToken,
      );
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });
  it("drops a stopped Run's place without publishing new activity", async () => {
    vi.useFakeTimers();
    const client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
    try {
      const loading = client.load();
      await vi.advanceTimersByTimeAsync(0);
      await loading;
      const threadId = client.getSnapshot().threads[0]!.id!;
      const runId = client.getSnapshot().runQueue.find((run) => run.threadId === threadId)!.id;
      const latest = client.runPlace(runId)!;
      expect(latest.runId).toBeTruthy();
      await client.stopRun(threadId);
      await vi.advanceTimersByTimeAsync(250);
      expect(client.runPlace(runId)).toBeNull();
      expect(client.placeActivity(latest.data.tabId)).toEqual([]);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });
  /*
   * Ways a scripted world can fail a journey: it keeps moving or expiring
   * cursors on its own; a notice it is given is dropped; a Run that ends
   * leaves its cursor; a cropped picture does not say what it shows.
   */
  it("moves cursors only as a journey tells it, until their Run ends", async () => {
    vi.useFakeTimers();
    const client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
    try {
      const loading = client.load();
      await vi.advanceTimersByTimeAsync(0);
      await loading;
      const snapshot = client.getSnapshot();
      const places = placeList(snapshot);
      const script = client.scriptPlaces();
      vi.advanceTimersByTime(1_000);
      expect(places.flatMap((place) => client.placeActivity(place.key))).toEqual([]);
      const page = places.find((place) => place.kind === "page" && place.occupants.length === 0)!;
      const { sessionId, tabId } = await pageSession(client, page.key);
      const run = snapshot.runQueue.find(
        (candidate) =>
          candidate.status === "running" && candidate.threadId !== snapshot.threads[0]!.id,
      )!;
      script.apply({
        type: "host.place-activity",
        activity: {
          tabId,
          threadId: run.threadId,
          runId: run.id,
          generation: 1,
          seq: 1,
          order: 1,
          at: Date.now(),
          expiresAt: Date.now() + 15_000,
          pointer: { x: 0.25, y: 0.5 },
          geometryRevision: 1,
        },
      });
      vi.advanceTimersByTime(60_000);
      expect(client.placeActivity(page.key)).toEqual([
        expect.objectContaining({ runId: run.id, pointer: { x: 0.25, y: 0.5 } }),
      ]);
      const release = client.retainBrowserWatch(sessionId, tabId);
      script.crop(sessionId, tabId, { width: 480, height: 600 });
      expect(client.browserWatchFrame(sessionId, tabId)?.header.capture).toMatchObject({
        width: 480,
        height: 600,
      });
      release();
      await client.stopRun(run.threadId);
      await vi.advanceTimersByTimeAsync(0);
      expect(client.placeActivity(page.key)).toEqual([]);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });
});

// Failure modes: the mock demos only pages; a command changes the list without the
// layout following; a closed tab comes back elsewhere; an app opens a second tab.
it("moves a mixed list of page, window, phone and app tabs through the tab commands", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const tabs = client.getSnapshot().tabs;
    const group = tabs.layout.items.find((item) => item.kind === "group");
    if (group?.kind !== "group") throw new Error("Expected a seeded group");
    expect(new Set(group.group.tabIds.map((id) => tabs.get(id)?.kind))).toEqual(
      new Set(["page", "window", "phone", "app"]),
    );
    const order = () => layoutTabIds(client.getSnapshot().tabs.layout);
    const loose = order().filter((id) => !group.group.tabIds.includes(id));
    const moved = loose[0]!;
    await client.organizeTabs({ tabIds: [moved], group: { groupId: group.group.groupId } });
    expect(client.getSnapshot().tabs.get(moved)?.groupId).toBe(group.group.groupId);
    await client.organizeTabs({ tabIds: [moved], group: null });
    expect(client.getSnapshot().tabs.get(moved)?.groupId).toBeNull();

    const before = order();
    const closing = group.group.tabIds[1]!;
    const closed = await client.closeTabs([closing]);
    expect(closed.closed).toEqual([closing]);
    expect(client.getSnapshot().tabs.get(closing)).toBeUndefined();
    const reopened = await client.reopenTab();
    expect(reopened.tabId).toBe(closing);
    expect(order()).toEqual(before);

    await client.updateTabGroup({ groupId: group.group.groupId, collapsed: true });
    expect(
      client.getSnapshot().tabs.strip.visible.some((id) => group.group.tabIds.includes(id)),
    ).toBe(false);
    await client.deleteTabGroup(group.group.groupId);
    expect(client.getSnapshot().tabs.layout.items.some((item) => item.kind === "group")).toBe(
      false,
    );
    // Ungrouping keeps every tab, in place.
    expect(order()).toEqual(before);

    const app = (await client.listApps()).find(
      (candidate) => ![...tabs.rows.values()].some((tab) => tab.appId === candidate.appId),
    )!;
    const opened = await client.openTab({ kind: "app", appId: app.appId });
    expect(order().at(-1)).toBe(opened.tabId);
    expect((await client.openTab({ kind: "app", appId: app.appId })).tabId).toBe(opened.tabId);
    expect(await client.activateTab(opened.tabId)).toEqual({ kind: "app", appId: app.appId });
  } finally {
    client.dispose();
  }
});
