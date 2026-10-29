import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { placeList } from "./places.js";
import { taskAttention, taskWaitingReason } from "./task-list.js";
import { BrowserContextCandidateSchema } from "@opensteer/protocol/browser";

describe("round two place contracts", () => {
  it("reads an unviewed candidate, binds document identity and refuses stale close revisions", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const session = client.getSnapshot().browserSessions[0]!;
      const tab = session.tabCatalog!.tabs[0]!;
      const candidate = await client.readBrowserContextCandidate(session.id, tab.id);
      expect(BrowserContextCandidateSchema.safeParse(candidate).success).toBe(true);
      expect(candidate.tabId).toBe(tab.id);
      expect(candidate.documentId).toBeTruthy();
      expect(session.viewerState).toBe("disconnected");
      await expect(
        client.closeBrowserTab(session.id, tab.id, { generation: 0, revision: 0 }),
      ).rejects.toMatchObject({ reason: "stale-tab-inventory" });
      const result = await client.closeBrowserTab(session.id, tab.id, session.tabCatalog!);
      expect(result.outcome).toBe("tab-closed");
      expect(
        client.getSnapshot().browserSessions[0]?.tabCatalog?.tabs.some(({ id }) => id === tab.id),
      ).toBe(false);
    } finally {
      client.dispose();
    }
  });
  it("keeps latest-place across cursor expiry and reports a nullable destination on close", async () => {
    vi.useFakeTimers();
    const client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
    try {
      const loading = client.load();
      await vi.advanceTimersByTimeAsync(0);
      await loading;
      const place = placeList(client.getSnapshot()).find(
        (place) => place.kind === "browser" && place.occupants.some((occupant) => occupant.acting),
      )!;
      const threadId = place.occupants[0]!.threadId;
      const changed = vi.fn();
      client.subscribeLatestPlace(threadId, changed);
      const latest = client.latestPlaceOfThread(threadId)!;
      expect(latest).not.toBeNull();
      expect(latest.runId).toBe(
        client.getSnapshot().runQueue.find((run) => run.threadId === threadId)?.id,
      );
      if (latest.destination?.kind !== "browser" || !latest.destination.tabId)
        throw new Error("Expected browser");
      const session = client
        .getSnapshot()
        .browserSessions.find(
          ({ id }) => latest.destination?.kind === "browser" && id === latest.destination.sessionId,
        )!;
      await client.closeBrowserTab(session.id, latest.destination.tabId, session.tabCatalog!);
      expect(client.latestPlaceOfThread(threadId)?.placeKey).toBe(latest.placeKey);
      expect(client.latestPlaceOfThread(threadId)?.runId).toBe(latest.runId);
      expect(client.latestPlaceOfThread(threadId)?.destination).toBeNull();
      expect(changed).toHaveBeenCalled();
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });
  it("uses row attribution for the Tasks count and real reasons for waiting", () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const snapshot = client.getSnapshot();
      const attention = taskAttention(snapshot);
      expect(new Set(attention.map(({ threadId }) => threadId)).size).toBe(attention.length);
      for (const entry of attention) expect(entry.requestId).toBeTruthy();
      const thread = snapshot.threads[0]!;
      expect(
        taskWaitingReason(
          {
            ...snapshot,
            requests: {},
            waitingRequests: [],
            assignments: {},
            threads: [{ ...thread, status: "waiting", inputQueuePaused: true }],
          },
          thread.id,
        ),
      ).toMatchObject({ kind: "paused-queue" });
      expect(
        taskWaitingReason(
          { ...snapshot, threads: [{ ...thread, status: "idle", inputQueuePaused: false }] },
          thread.id,
        ),
      ).toBeNull();
    } finally {
      client.dispose();
    }
  });
});
