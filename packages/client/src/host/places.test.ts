import { AppTabSchema } from "@opensteer/protocol";
import { defaultTaskSymbol } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { placeIdentityKey } from "@opensteer/protocol";
import { MockHostClient } from "../mock/mock-host-client.js";
import { placeList, placeDestinationEnded, samePlaceListSource } from "./places.js";
import { taskMark, threadMark } from "./task-marks.js";
import { assignmentMark } from "./assignment-presentation.js";

const now = () => new Date("2026-10-19T12:00:00.000Z");

describe("place catalog", () => {
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
        (session) => session.origin === "workspace" && (session.tabCatalog?.tabs.length ?? 0) > 1,
      )!;
      expect(shared).toBeDefined();
      const tabs = places.filter(
        (place) =>
          place.destination.kind === "browser" && place.destination.sessionId === shared.id,
      );
      expect(tabs[0]?.occupants).toEqual([]);
      expect(tabs.some((place) => place.occupants.some((occupant) => occupant.acting))).toBe(true);
      expect(shared.tabCatalog!.tabs.some((tab) => tab.openerId)).toBe(true);
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
        workspaceTabs: undefined,
        workspaceTabRestoreVersion: undefined,
      };
      const source = { ...snapshot, workspaceTabRestoreVersion: 1 as const, workspaceTabs: [] };
      const expected = placeList(snapshot).filter((place) => place.kind === "browser");
      expect(expected.length).toBeGreaterThan(0);
      expect(placeList(source).filter((place) => place.kind === "browser")).toEqual(expected);
      expect(placeDestinationEnded(source, expected[0]!.destination)).toBe(false);
    } finally {
      client.dispose();
    }
  });
  it("suppresses the live projection only for a participating durable session", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const snapshot = {
        ...client.getSnapshot(),
        browserSessions: client.getSnapshot().browserSessions.map((session) => ({
          ...session,
          workspaceTabRestoreVersion: undefined as 1 | undefined,
        })),
      };
      const participating = snapshot.browserSessions[0]!;
      const source = {
        ...snapshot,
        workspaceTabRestoreVersion: 1 as const,
        workspaceTabs: [],
        browserSessions: snapshot.browserSessions.map((session) =>
          session === participating
            ? { ...session, workspaceTabRestoreVersion: 1 as const }
            : session,
        ),
      };
      const places = placeList(source).filter((place) => place.kind === "browser");
      expect(places.some((place) => place.browser?.sessionId === participating.id)).toBe(false);
      expect(places.length).toBeGreaterThan(0);
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
          { ...snapshot, browserSessions: [], workspaceTabRestoreVersion: 1, workspaceTabs: [] },
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
