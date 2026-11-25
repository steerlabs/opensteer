import { mockAgentWorkThreads, mockConnectedAgents, MockHostClient } from "@opensteer/client/mock";
import { mainDoneTasks } from "@opensteer/client/host";
import { expect, it } from "vitest";
import { personDoneTaskList } from "./task-directory.js";

it("counts only rows shown in Done when a held detail identifies an older direct session task", () => {
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
      window: { totalItems: 1, itemCount: 1, nextBefore: null, hasMore: false, byteCount: 0 },
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
