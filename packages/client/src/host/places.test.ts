import { AppTabSchema } from "@opensteer/protocol";
import { defaultTaskSymbol, BrowserSurfaceIdSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { placeIdentityKey } from "@opensteer/protocol";
import { MockHostClient } from "../mock/mock-host-client.js";
import { placeList, placeDestinationEnded, samePlaceListSource } from "./places.js";
import { taskMark, threadMark } from "./task-marks.js";
import { assignmentMark } from "./assignment-presentation.js";
import { startPageIndex, startPageResults } from "./start-page-model.js";
import { PlaceProjection } from "./places.js";

const now = () => new Date("2026-10-19T12:00:00.000Z");

describe("place catalog", () => {
  it("visits no rows on unchanged reads and only the changed row after a keyed title update", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const source = client.getSnapshot();
      const store = client.browserTabs;
      const first = store.structure()[0]!;
      const row = store.tab(first.groupId, first.tabId)!;
      const rows = Array.from({ length: 10_000 }, (_, i) => ({
        ...row,
        id: BrowserSurfaceIdSchema.parse(`large-${i}`),
        order: i,
        openerId: null,
      }));
      store.applyTabs(first.groupId, { op: "begin", generation: "large" });
      store.applyTabs(first.groupId, { op: "rows", rows });
      store.applyTabs(first.groupId, { op: "end", revision: 0, count: rows.length, meta: {} });
      const projection = new PlaceProjection(store);
      const before = projection.list(source);
      const visit = vi.spyOn(projection, "place");
      for (let i = 0; i < 20; i++)
        expect(projection.list({ ...source, openingAppTabs: [] })).toBe(before);
      expect(visit).toHaveBeenCalledTimes(0);
      store.applyTabs(first.groupId, {
        op: "change",
        generation: "large",
        base: 0,
        revision: 1,
        update: [{ id: rows[0]!.id, title: "Fresh title" }],
      });
      const after = projection.list(source);
      expect(visit).toHaveBeenCalledTimes(1);
      expect(after.find((place) => place.key.endsWith(":large-0"))?.title).toBe("Fresh title");
      expect(after.find((place) => place.key.endsWith(":large-1"))).toBe(
        before.find((place) => place.key.endsWith(":large-1")),
      );
      visit.mockClear();
      expect(projection.list(source)).toBe(after);
      expect(visit).not.toHaveBeenCalled();
      store.applyTabs(first.groupId, {
        op: "change",
        generation: "large",
        base: 1,
        revision: 2,
        remove: [rows[0]!.id],
      });
      expect(projection.list(source)).toHaveLength(after.length - 1);
      expect(projection.list(source).some((place) => place.key.endsWith(":large-0"))).toBe(false);
    } finally {
      client.dispose();
    }
  });
  it("projects keyed rows without rebuilding structure or unchanged places", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const source = client.getSnapshot();
      const store = client.browserTabs;
      const projection = new PlaceProjection(store);
      const structure = projection.structure(source);
      const first = store.structure().find((key) => store.sessionTabs(key.sessionId).length > 1);
      const second = store
        .structure()
        .find((key) => key.groupId === first?.groupId && key.tabId !== first.tabId);
      if (!first || !second) throw new Error("Missing seeded tabs");
      const key = `browser:${first.sessionId}:${first.tabId}`;
      const siblingKey = `browser:${second.sessionId}:${second.tabId}`;
      const before = projection.place(source, key);
      const sibling = projection.place(source, siblingKey);
      const replace = (rows: ReturnType<typeof store.sessionTabs>) => {
        store.applyTabs(first.groupId, { op: "begin", generation: "places" });
        store.applyTabs(first.groupId, { op: "rows", rows: [...rows] });
        store.applyTabs(first.groupId, { op: "end", revision: 0, count: rows.length, meta: {} });
      };
      const rows = store.sessionTabs(first.sessionId);
      replace(
        rows.map((row) =>
          row.id === first.tabId ? { ...row, title: "Needle in keyed store", loading: true } : row,
        ),
      );
      expect(projection.structure(source)).toBe(structure);
      expect(projection.place(source, siblingKey)).toBe(sibling);
      expect(projection.place(source, key)).not.toBe(before);
      expect(projection.place(source, key)).toMatchObject({
        title: "Needle in keyed store",
        loading: true,
      });
      expect(placeList(source).find((place) => place.key === key)?.title).toBe(
        "Needle in keyed store",
      );
      expect(
        startPageResults(startPageIndex({ snapshot: source }), {
          query: "Needle in keyed store",
          choice: { kind: "guest" },
        }).some((result) => result.kind === "tab" && result.title === "Needle in keyed store"),
      ).toBe(true);
      const committed = projection.structure(source);
      store.applyTabs(first.groupId, { op: "begin", generation: "interrupted" });
      store.applyTabs(first.groupId, { op: "rows", rows: [] });
      expect(projection.structure(source)).toBe(committed);
      store.disconnected();
      expect(projection.structure(source)).toBe(committed);
      expect(projection.place(source, siblingKey)).toBe(sibling);
      const added = {
        ...rows[0]!,
        id: BrowserSurfaceIdSchema.parse("mock-added"),
        openerId: null,
        order: -1,
      };
      replace([added, ...store.sessionTabs(first.sessionId)]);
      expect(
        projection.structure(source).findIndex((place) => place.key.endsWith(":mock-added")),
      ).toBeLessThan(projection.structure(source).findIndex((place) => place.key === key));
      const inserted = projection.structure(source);
      replace(
        store
          .sessionTabs(first.sessionId)
          .map((row) => (row.id === first.tabId ? { ...row, order: -2 } : row)),
      );
      expect(projection.structure(source)).not.toBe(inserted);
      expect(projection.structure(source).findIndex((place) => place.key === key)).toBeLessThan(
        projection.structure(source).findIndex((place) => place.key.endsWith(":mock-added")),
      );
      replace(store.sessionTabs(first.sessionId).filter((row) => row.id !== first.tabId));
      expect(projection.place(source, key)).toBeUndefined();
      expect(projection.structure(source).some((place) => place.key === key)).toBe(false);
    } finally {
      client.dispose();
    }
  });
  it("searches the current store even when the compatibility snapshot has not changed", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const source = client.getSnapshot();
      const store = client.browserTabs;
      const first = store.structure()[0]!;
      const rows = store
        .sessionTabs(first.sessionId)
        .map((tab) => (tab.id === first.tabId ? { ...tab, title: "Keyed search needle" } : tab));
      store.applyTabs(first.groupId, { op: "begin", generation: "search" });
      store.applyTabs(first.groupId, { op: "rows", rows });
      store.applyTabs(first.groupId, { op: "end", revision: 0, count: rows.length, meta: {} });
      const results = startPageResults(startPageIndex({ snapshot: source }), {
        query: "Keyed search needle",
        choice: { kind: "guest" },
      });
      expect(
        results.some((result) => result.kind === "tab" && result.title === "Keyed search needle"),
      ).toBe(true);
    } finally {
      client.dispose();
    }
  });
  it("lists Opensteer apps independently of machines and detects closed tabs", async () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      await client.load();
      const appId = "app_00000000-0000-4000-8000-000000000001";
      const snapshot = client.getSnapshot();
      const tab = AppTabSchema.parse({
        appId,
        title: "Budget",
        threadId: snapshot.threads[0]!.id,
        workspaceId: snapshot.workspaces[0]!.id,
        latestVersion: 3,
        openedAt: now().toISOString(),
      });
      const source = { ...snapshot, appTabs: [tab] };
      const row = placeList(source).find((row) => row.key === `opensteer-app:${appId}`)!;
      expect(row).toMatchObject({
        kind: "opensteer-app",
        title: "Budget",
        destination: { kind: "opensteer-app", appId },
        device: null,
        occupants: [],
        availability: "ready",
        closable: true,
        icon: { kind: "opensteer-app" },
        opensteerApp: { appId, threadId: tab.threadId, workspaceId: tab.workspaceId },
      });
      expect(placeDestinationEnded(source, row.destination)).toBe(false);
      expect(placeDestinationEnded(snapshot, row.destination)).toBe(true);
      expect(samePlaceListSource(snapshot, source)).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it("cold-loads exact tabs and native places without observing transcripts", async () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      await client.load();
      const snapshot = client.getSnapshot();
      const places = placeList(snapshot);
      expect(new Set(places.map((place) => place.key)).size).toBe(places.length);
      const shared = snapshot.browserSessions.find(
        (session) =>
          session.origin === "workspace" &&
          ((session.browserTabs?.sessionTabs(session?.id) ?? []).length ?? 0) > 1,
      )!;
      expect(shared).toBeDefined();
      const tabs = places.filter(
        (place) =>
          place.destination.kind === "browser" && place.destination.sessionId === shared.id,
      );
      expect(tabs[0]?.occupants).toEqual([]);
      expect(tabs.some((place) => place.occupants.some((occupant) => occupant.acting))).toBe(true);
      expect((shared.browserTabs?.sessionTabs(shared?.id) ?? []).some((tab) => tab.openerId)).toBe(
        true,
      );
      expect(places.some((place) => place.occupants.some((occupant) => occupant.home))).toBe(true);
      expect(
        new Set(
          places.filter((place) => place.kind === "app").map((place) => place.device?.machineId),
        ).size,
      ).toBeGreaterThanOrEqual(2);
      expect(
        places.some(
          (place) => place.kind === "phone" && place.occupants.some((occupant) => occupant.acting),
        ),
      ).toBe(true);
      for (const place of places) {
        if (place.site?.startsWith("http")) expect(new URL(place.site).origin).toBe(place.site);
      }
      const occupied = places.find((place) => place.title === "Weekend ideas")!;
      const runId = snapshot.runQueue.find(
        (run) => run.threadId === occupied.occupants[0]!.threadId,
      )!.id;
      const latest = client.runPlace(runId);
      expect(latest && placeIdentityKey(latest.data.place)).toBe(occupied.key);
      expect(latest?.runId).toBe(
        snapshot.runQueue.find((run) => run.threadId === occupied.occupants[0]!.threadId)?.id,
      );
      const transcriptOnly = { ...snapshot, transcripts: {} };
      expect(samePlaceListSource(snapshot, transcriptOnly)).toBe(true);
      // A reconnect is the transport's state, not the places': nothing dims or leaves.
      const offline: typeof snapshot = { ...snapshot, connection: "offline" };
      expect(samePlaceListSource(snapshot, offline)).toBe(true);
      expect(placeList(offline)).toEqual(places);
    } finally {
      client.dispose();
    }
  });

  it("keeps one phone row through its task until its owner closes the tab", async () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const phones = () =>
        placeList(client.getSnapshot()).filter((place) => place.kind === "phone");
      expect(phones()).toHaveLength(1);
      const held = phones()[0]!;
      const { destination } = held;
      if (destination.kind !== "phone" || !held.task) throw new Error("No held phone");
      expect(held.closable).toBe(false);

      await client.rpc["integration.computer.session.stop"]({ sessionId: held.task.sessionId });
      expect(phones()).toHaveLength(1);
      expect(phones()[0]).toMatchObject({
        closable: true,
        destination,
        key: held.key,
        occupants: [],
        ownerView: null,
        task: null,
      });
      expect(placeDestinationEnded(client.getSnapshot(), destination)).toBe(false);

      await client.closePhoneTab(destination.machineId);
      expect(phones()).toEqual([]);
      expect(placeDestinationEnded(client.getSnapshot(), destination)).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("keeps a phone's tab offline and never lets a dead view hide a live task", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const snapshot = client.getSnapshot();
      const phone = snapshot.machines.find(
        (machine) => machine.computerUse?.sessions.some(({ display }) => display) === true,
      )!;
      const withPhone = (next: typeof phone) => ({
        ...snapshot,
        machines: snapshot.machines.map((machine) => (machine.id === phone.id ? next : machine)),
      });
      const offline = withPhone({ ...phone, computerUse: null, status: "offline" });
      const row = placeList(offline).find((place) => place.kind === "phone")!;
      expect(row.availability).toBe("unavailable");
      expect(placeDestinationEnded(offline, row.destination)).toBe(false);
      const closed = withPhone({
        ...phone,
        computerUse: null,
        status: "offline",
        tabOpenedAt: null,
      });
      expect(placeDestinationEnded(closed, row.destination)).toBe(true);

      const view = {
        generation: 1,
        state: "unavailable",
        target: { display: "main", kind: "phone" },
        viewId: "cvw_dead",
      } as unknown as NonNullable<NonNullable<typeof phone.computerUse>["ownerViews"]>[number];
      const dead = withPhone({
        ...phone,
        computerUse: { ...phone.computerUse!, ownerViews: [view] },
      });
      const held = placeList(dead).find((place) => place.kind === "phone")!;
      expect(held.ownerView).toBeNull();
      expect(held.task).not.toBeNull();
      expect(held.ownerClose).toEqual({ generation: 1, viewId: "cvw_dead" });

      const live = withPhone({
        ...phone,
        computerUse: { ...phone.computerUse!, ownerViews: [{ ...view, state: "ready" }] },
      });
      const shown = placeList(live).find((place) => place.kind === "phone")!;
      expect(shown.ownerView?.viewId).toBe("cvw_dead");
      expect(shown.ownerClose).toBeNull();
    } finally {
      client.dispose();
    }
  });

  it("keeps live-only sessions visible when the Host also offers durable tabs", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const snapshot = {
        ...client.getSnapshot(),
        browserSessions: client.getSnapshot().browserSessions.map((session) => ({
          ...session,
          workspaceTabRestoreVersion: undefined,
        })),
        lineages: undefined,
        workspaceTabRestoreVersion: undefined,
      };
      const source = { ...snapshot, workspaceTabRestoreVersion: 1 as const };
      const expected = placeList(snapshot).filter((place) => place.kind === "browser");
      expect(expected.length).toBeGreaterThan(0);
      expect(placeList(source).filter((place) => place.kind === "browser")).toEqual(expected);
      expect(placeDestinationEnded(source, expected[0]!.destination)).toBe(false);
    } finally {
      client.dispose();
    }
  });
  it("removes only the group whose complete stream ends", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const snapshot = client.getSnapshot();
      const first = client.browserTabs.structure()[0]!;
      const before = placeList(snapshot);
      client.browserTabs.applyTabs(first.groupId, { op: "begin", generation: "removed" });
      client.browserTabs.applyTabs(first.groupId, { op: "end", revision: 0, count: 0, meta: {} });
      const places = placeList(snapshot);
      expect(places.some((place) => place.browser?.sessionId === first.sessionId)).toBe(false);
      expect(places).toEqual(
        before.filter((place) => place.browser?.sessionId !== first.sessionId),
      );
    } finally {
      client.dispose();
    }
  });
  it("lists a tab its browser put to sleep as suspended, so selecting it wakes it", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const snapshot = client.getSnapshot();
      const store = client.browserTabs;
      const group = store
        .groups()
        .ids.map((id) => store.group(id)!)
        .find((group) => group.state === "ready" && store.tabs(group.id).ids.length)!;
      const rows = store.sessionTabs(group.sessionId);
      const asleep = rows[0]!.id;
      store.applyTabs(group.id, { op: "begin", generation: "sleeping" });
      store.applyTabs(group.id, {
        op: "rows",
        rows: rows.map((tab) => (tab.id === asleep ? { ...tab, state: "suspended" } : tab)),
      });
      store.applyTabs(group.id, { op: "end", revision: 0, count: rows.length, meta: {} });
      const states = new Map(
        placeList(snapshot).flatMap((place) =>
          place.workspaceTab ? [[place.workspaceTab.id, place.workspaceTab.state] as const] : [],
        ),
      );
      expect(states.get(asleep)).toBe("suspended");
      expect([...states.values()]).toContain("live");
    } finally {
      client.dispose();
    }
  });
  it("does not treat a browser missing from the bounded durable catalog as closed", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const snapshot = client.getSnapshot();
      const destination = placeList(snapshot).find(
        (place) => place.kind === "browser",
      )!.destination;
      expect(
        placeDestinationEnded(
          { ...snapshot, browserSessions: [], workspaceTabRestoreVersion: 1 },
          destination,
        ),
      ).toBe(false);
    } finally {
      client.dispose();
    }
  });
  it("resolves occupants and cursors from held tasks, then the directory, with a pending fallback", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const snapshot = client.getSnapshot();
      const task = { ...snapshot.threads[1]!, icon: "plane" as const, color: "blue" as const };
      expect(threadMark(task.id, { ...snapshot, threads: [task] })).toEqual(taskMark(task));
      const directory = {
        ...snapshot,
        threads: [],
        tasks: {
          entries: [{ thread: task, lastReply: null, failure: null }],
          window: snapshot.workspaceWindow,
        },
      };
      expect(threadMark(task.id, directory)).toEqual(taskMark(task));
      expect(threadMark("unknown", directory)).toEqual({ icon: defaultTaskSymbol, color: null });
      const assignment = {
        workerThread: { id: task.id, icon: "hotel" as const, color: "green" as const },
      };
      expect(assignmentMark(assignment, { threads: [task] })).toEqual(taskMark(task));
      expect(assignmentMark(assignment, { threads: [] })).toEqual({
        icon: "hotel",
        color: "green",
      });
      expect(
        assignmentMark({ workerThread: { id: task.id, icon: null } }, { threads: [] }),
      ).toEqual({ icon: defaultTaskSymbol, color: null });
    } finally {
      client.dispose();
    }
  });
});
