import { describe, expect, it, vi } from "vitest";
import { readTeamReply } from "./personal-team-links.js";

const teamId = "dep_00000000-0000-4000-8000-000000000001";
const channelId = "tch_00000000-0000-4000-8000-000000000001";
const taskId = "thr_00000000-0000-4000-8000-000000000001";
const origin = { teamId, channelId, threadRootId: "12" };

function client(
  state: { readSequence: string | null; unreadSequence: string | null } | null,
  task: string | null = taskId,
) {
  const markThreadRead = vi.fn(async () => undefined);
  const threadTask = vi.fn(async () => ({ ok: true, data: { taskId: task } }));
  return {
    markThreadRead,
    threadTask,
    rpc: { "teams.threadTask.get": threadTask } as never,
    getSnapshot: () =>
      ({
        threadReadStates: state ? { [taskId]: { threadId: taskId, asOfSequence: "9", ...state } } : {},
      }) as never,
  };
}

describe("readTeamReply", () => {
  it("reads the thread's local task through what it last published", async () => {
    const fake = client({ readSequence: "3", unreadSequence: "7" });
    await readTeamReply(fake, origin);
    expect(fake.threadTask).toHaveBeenCalledWith({ teamId, channelId, threadRootId: "12" });
    expect(fake.markThreadRead).toHaveBeenCalledWith(taskId, "7");
  });

  it("leaves a task already read, and a thread with no task here", async () => {
    const read = client({ readSequence: "7", unreadSequence: "7" });
    await readTeamReply(read, origin);
    const none = client(null, null);
    await readTeamReply(none, origin);
    expect(read.markThreadRead).not.toHaveBeenCalled();
    expect(none.markThreadRead).not.toHaveBeenCalled();
  });
});
