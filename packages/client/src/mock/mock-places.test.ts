import { BrowserSurfaceIdSchema, BrowserTabGroupIdSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "./mock-host-client.js";
import { placeIdentityKey } from "@opensteer/protocol";
import { browserTabStrip } from "../host/browser-tab-strip.js";
import { placeList } from "../host/places.js";
import { runPages } from "../host/surfaces.js";

it("activates an existing mock surface without replacing its document or duplicating the tab", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const session = client
      .getSnapshot()
      .browserSessions.find((held) => held.tabCatalog?.tabs.length)!;
    const tab = session.tabCatalog!.tabs[0]!;
    const response = await client.rpc["commands.dispatch"]({
      type: "workspace.tab.activate",
      tabId: BrowserSurfaceIdSchema.parse(tab.id),
      idempotencyKey: "existing-surface",
    });
    expect(response.ok).toBe(true);
    const updated = client.getSnapshot().browserSessions.find((held) => held.id === session.id)!;
    expect(updated.tabCatalog?.tabs.find((held) => held.id === tab.id)?.documentId).toBe(
      tab.documentId,
    );
    expect(updated.tabs.filter((held) => held.id === tab.id)).toHaveLength(1);
    expect(
      client
        .getSnapshot()
        .workspaceTabs?.find((group) => group.session.id === session.id)
        ?.tabs?.find((held) => held.id === tab.id)?.state,
    ).toBe("live");
  } finally {
    client.dispose();
  }
});

it("publishes mock browser rows with stable sibling identities and no dormant live catalog", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const before = client.getSnapshot();
    const own = before.browserSessions.find((s) => s.tabCatalog?.tabs.length)!;
    const other = before.browserSessions.find((s) => s.id !== own.id && s.tabCatalog?.tabs.length)!;
    const tab = own.tabCatalog!.tabs[0]!;
    client.setBrowserLoading(tab.id, !tab.loading);
    const after = client.getSnapshot();
    expect(after.browserSessions.find((s) => s.id === other.id)).toBe(other);
    expect(after.browserSessions.find((s) => s.id === own.id)!.tabCatalog!.tabs[0]!.loading).toBe(
      !tab.loading,
    );
    expect(after.browserSessions.find((s) => s.id === own.id)!.tabCatalog!.tabs[1]).toBe(
      own.tabCatalog!.tabs[1],
    );
    const dormant = client.scriptDormantBrowser({ profileName: "Saved" });
    const snapshot = client.getSnapshot();
    const group = snapshot.workspaceTabs!.find((g) => g.session.id === dormant.sessionId)!;
    expect(group.whole).toBe(true);
    expect(group.tabs!.find((t) => t.id === dormant.tabId)!.state).toBe("suspended");
    expect(
      snapshot.browserSessions.find((s) => s.id === dormant.sessionId)?.tabCatalog?.tabs ?? [],
    ).toEqual([]);
    const current = snapshot.browserSessions.find((s) => s.tabCatalog?.tabs.length)!;
    const release = client.retainBrowserViewer(current.id, current.tabCatalog!.tabs[0]!.id);
    await client.rpc["auth.signOut"]({});
    expect(client.getSnapshot().browserSessions).toEqual([]);
    expect(client.getSnapshot().workspaceTabs).toEqual([]);
    release();
  } finally {
    client.dispose();
  }
});

describe("moving mock workspace", () => {
  it("moves cursors independently, churns tabs, resolves icons and shares targeted demand", async () => {
    vi.useFakeTimers();
    const client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
    try {
      const loading = client.load();
      await vi.advanceTimersByTimeAsync(0);
      await loading;
      const places = placeList(client.getSnapshot());
      const browser = places.find(
        (place) =>
          place.destination.kind === "browser" &&
          place.occupants.some((occupant) => occupant.acting),
      )!;
      if (browser.destination.kind !== "browser" || !browser.destination.tabId)
        throw new Error("Missing mock tab");
      const { sessionId, tabId } = browser.destination;
      const snapshot = client.getSnapshot();
      const homeThreadId = snapshot.homeThreadId!;
      const homeRun = snapshot.runQueue.find((run) => run.threadId === homeThreadId)!;
      const homePlace = places.find((place) => place.title === "Weekend ideas")!;
      expect(homeRun.status).toBe("running");
      expect(client.runPlace(homeRun.id)).toMatchObject({
        runId: homeRun.id,
        data: { title: homePlace.title },
      });
      expect(client.placeActivity(homePlace.key)[0]?.runId).toBe(homeRun.id);
      expect(runPages(snapshot.browserUses, snapshot.browserSessions, [homeRun.id])).toEqual([
        expect.objectContaining({
          destination: homePlace.destination,
          title: "Weekend ideas",
          acting: true,
        }),
      ]);
      const actingRun = snapshot.runQueue.find(
        (run) => run.threadId === browser.occupants.find((occupant) => occupant.acting)?.threadId,
      )!;
      expect(client.placeActivity(browser.key)[0]?.runId).toBe(actingRun.id);
      expect(
        runPages(snapshot.browserUses, snapshot.browserSessions, [actingRun.id]),
      ).toContainEqual(expect.objectContaining({ destination: browser.destination, acting: true }));
      const phone = places.find(
        (place) => place.kind === "phone" && place.occupants.some((occupant) => occupant.acting),
      )!;
      const phoneThreadId = phone.occupants.find((occupant) => occupant.acting)!.threadId;
      const phoneRun = snapshot.runQueue.find((run) => run.threadId === phoneThreadId)!;
      expect(client.runPlace(phoneRun.id)).toMatchObject({
        runId: phoneRun.id,
        data: { title: phone.title },
      });
      const updates = vi.fn();
      client.subscribePlaceActivity(browser.key, updates);
      const first = client.placeActivity(browser.key)[0];
      vi.advanceTimersByTime(250);
      expect(client.getSnapshot()).toBe(snapshot);
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
      const icon = places.find((place) => place.icon.kind === "site" && place.icon.ref !== null)!;
      if (icon.icon.kind !== "site" || icon.destination.kind !== "browser" || !icon.icon.ref)
        throw new Error("Missing icon");
      expect(await client.readBrowserTabIcon(icon.destination.sessionId, icon.icon.ref)).toMatch(
        /^data:image\//,
      );
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
      const session = client
        .getSnapshot()
        .browserSessions.find((session) => session.tabs.length >= 2)!;
      const [first, second] = session.tabs;
      const sessionId = session.id;
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
      const threadId = client.getSnapshot().homeThreadId!;
      const runId = client.getSnapshot().runQueue.find((run) => run.threadId === threadId)!.id;
      const latest = client.runPlace(runId)!;
      expect(latest.runId).toBeTruthy();
      await client.stopRun(threadId);
      await vi.advanceTimersByTimeAsync(250);
      expect(client.runPlace(runId)).toBeNull();
      expect(client.placeActivity(placeIdentityKey(latest.data.place))).toEqual([]);
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
      const page = places.find(
        (place) => place.destination.kind === "browser" && place.occupants.length === 0,
      )!;
      if (page.destination.kind !== "browser" || !page.destination.tabId)
        throw new Error("Missing mock tab");
      const { sessionId, tabId } = page.destination;
      const run = snapshot.runQueue.find(
        (candidate) =>
          candidate.status === "running" && candidate.threadId !== snapshot.homeThreadId,
      )!;
      script.apply({
        type: "host.place-activity",
        activity: {
          place: { kind: "browser", sessionId, surfaceId: tabId },
          threadId: run.threadId,
          home: false,
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

// Failure modes: the mock advertises moves but has no durable rows, loses saved order
// on grouping or ungrouping, or forgets the order when a moved tab closes.
it("moves durable mock tabs through the same personal order and group operations", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const snapshot = client.getSnapshot();
    const places = browserTabStrip(placeList(snapshot), snapshot.browserTabGroups).ordered.filter(
      (p) => p.kind === "browser",
    );
    expect(places.every((p) => p.workspaceTab)).toBe(true);
    const ids = places.map((p) => {
      if (p.destination.kind !== "browser" || !p.destination.tabId) throw new Error("Missing tab");
      return p.destination.tabId;
    });
    expect(client.getSnapshot().browserTabGroups?.order).toBeDefined();
    await client.moveBrowserTabs({
      item: { tabIds: [BrowserSurfaceIdSchema.parse(ids[0])] },
      to: { groupId: null, before: null },
    });
    expect(client.getSnapshot().browserTabGroups?.order?.at(-1)).toBe(ids[0]);
    const groupId = await client.groupBrowserTabs([ids[1]!, ids[2]!], { title: "Reading" });
    await client.moveBrowserTabs({
      item: { tabIds: [BrowserSurfaceIdSchema.parse(ids[0])] },
      to: { groupId: BrowserTabGroupIdSchema.parse(groupId), before: null },
    });
    expect(
      client.getSnapshot().browserTabGroups?.groups.find((g) => g.id === groupId)?.tabIds,
    ).toEqual([ids[1], ids[2], ids[0]]);
    await client.ungroupBrowserTabs([ids[1]!]);
    const order = client.getSnapshot().browserTabGroups!.order!;
    expect(order.indexOf(BrowserSurfaceIdSchema.parse(ids[1]))).toBe(
      order.indexOf(BrowserSurfaceIdSchema.parse(ids[0])) + 1,
    );
    const closed = await client.closeWorkspaceTabs([ids[0]!]);
    expect(closed.closed).toEqual([ids[0]]);
    expect(client.getSnapshot().browserTabGroups?.order).not.toContain(ids[0]);
  } finally {
    client.dispose();
  }
});
