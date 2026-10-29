import { describe, expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { placeList, placeDestinationEnded, samePlaceListSource } from "./places.js";
import { taskMark, threadMark } from "./task-marks.js";
import { assignmentMark } from "./assignment-presentation.js";

const now = () => new Date("2026-10-19T12:00:00.000Z");

describe("place catalog", () => {
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
      const latest = client.latestPlaceOfThread(occupied.occupants[0]!.threadId);
      expect(latest?.placeKey).toBe(occupied.key);
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

  it("keeps live-only sessions visible when the Host also offers durable tabs", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const snapshot = {
        ...client.getSnapshot(),
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
      const snapshot = client.getSnapshot();
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
      expect(threadMark("unknown", directory)).toEqual({
        icon: "document",
        color: null,
        pending: true,
      });
      const assignment = {
        workerThread: { id: task.id, icon: "hotel" as const, color: "green" as const },
      };
      expect(assignmentMark(assignment, { threads: [task] })).toEqual(taskMark(task));
      expect(assignmentMark(assignment, { threads: [] })).toEqual({
        icon: "hotel",
        color: "green",
        pending: false,
      });
      expect(
        assignmentMark({ workerThread: { id: task.id, icon: null } }, { threads: [] }),
      ).toEqual({ icon: "document", color: null, pending: true });
    } finally {
      client.dispose();
    }
  });
});
