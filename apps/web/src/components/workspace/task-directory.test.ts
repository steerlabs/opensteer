import { mockAgentWorkThreads, mockConnectedAgents, MockHostClient } from "@opensteer/client/mock";
import { mainDoneTasks } from "@opensteer/client/host";
import { expect, it } from "vitest";
import { personDoneTaskList } from "./task-directory.js";

it("keeps an older direct session row out of Done when the held detail identifies it", () => {
  const host = new MockHostClient({ ...mockConnectedAgents("seeded"), latencyMs: 0 });
  try {
    host.mockAgentWork();
    const snapshot = host.getSnapshot();
    const held = snapshot.threads.find(({ id }) => id === mockAgentWorkThreads.ended)!;
    const entry = {
      thread: { ...held, externalWork: null, agentSessionId: null, doneAt: held.updatedAt },
      failure: null,
      lastReply: null,
    };
    const page = {
      entries: [entry],
      window: { totalItems: 0, itemCount: 1, nextBefore: null, hasMore: false, byteCount: 0 },
    };
    const done = personDoneTaskList({
      ...snapshot,
      quietTasksAvailable: true,
      doneTasks: { [mainDoneTasks]: page },
    });
    expect(done?.rows).toEqual([]);
    expect(done?.total).toBe(0);
  } finally {
    host.dispose();
  }
});

it("shows the Host's Done total while more pages remain", () => {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    const snapshot = host.getSnapshot();
    const entry = snapshot.tasks!.entries[0]!;
    const done = personDoneTaskList({
      ...snapshot,
      quietTasksAvailable: true,
      doneTasks: {
        [mainDoneTasks]: {
          entries: [{ ...entry, thread: { ...entry.thread, doneAt: entry.thread.updatedAt } }],
          window: {
            totalItems: 30,
            itemCount: 1,
            nextBefore: "older",
            hasMore: true,
            byteCount: 0,
          },
        },
      },
    });
    expect(done?.hasMore).toBe(true);
    expect(done?.total).toBe(30);
  } finally {
    host.dispose();
  }
});
