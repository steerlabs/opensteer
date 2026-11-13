import { describe, expect, it, vi } from "vitest";
import { readTeamReply, watchTeamReplyRead } from "./personal-team-links.js";
import { withTimeout } from "@opensteer/shared/withTimeout";

const teamId = "dep_00000000-0000-4000-8000-000000000001";
const channelId = "tch_00000000-0000-4000-8000-000000000001";
const taskId = "thr_00000000-0000-4000-8000-000000000001";
const date = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const origin = { teamId, channelId, threadRootId: "12", replyMessageId: "15" };

function client(lastVisitedAt: string | null, task: string | null = taskId) {
  const visitThread = vi.fn(async () => undefined);
  const threadTask = vi.fn(async () => ({
    ok: true,
    data: { taskId: task, completedAt: task ? date(7) : null },
  }));
  return {
    visitThread,
    threadTask,
    rpc: { "teams.replyTask.get": threadTask } as never,
    getSnapshot: () =>
      ({
        threadVisits: lastVisitedAt ? { [taskId]: lastVisitedAt } : {},
      }) as never,
  };
}

describe("readTeamReply", () => {
  it("reads the thread's local task through what it last published", async () => {
    const fake = client(date(3));
    await readTeamReply(fake, origin);
    expect(fake.threadTask).toHaveBeenCalledWith({
      teamId,
      channelId,
      threadRootId: "12",
      replyMessageId: "15",
    });
    expect(fake.visitThread).toHaveBeenCalledWith(taskId, date(7));
  });

  it("leaves a task already read, and a thread with no task here", async () => {
    const read = client(date(7));
    await readTeamReply(read, origin);
    const none = client(null, null);
    await readTeamReply(none, origin);
    expect(read.visitThread).not.toHaveBeenCalled();
    expect(none.visitThread).not.toHaveBeenCalled();
  });
  it("marks two publications independently and never reads newer private work", async () => {
    const fake = client(date(3));
    await readTeamReply(fake, origin);
    expect(fake.visitThread).toHaveBeenCalledWith(taskId, date(7));
    fake.threadTask.mockResolvedValue({ ok: true, data: { taskId, completedAt: date(8) } });
    await readTeamReply(fake, { ...origin, replyMessageId: "16" });
    expect(fake.visitThread).toHaveBeenLastCalledWith(taskId, date(8));
    expect(fake.visitThread).not.toHaveBeenCalledWith(taskId, date(9));
  });

  it("retries an unresolved visible read on a receipt notice even when the notice arrives during lookup", async () => {
    const fake = client(date(3), null);
    const attempted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const marked = Promise.withResolvers<void>();
    fake.threadTask.mockImplementationOnce(async () => {
      attempted.resolve();
      await withTimeout(release.promise, 1000, {
        timeoutError: () => new Error("First visible read was not released"),
      });
      return { ok: true, data: { taskId: null, completedAt: null } };
    });
    fake.visitThread.mockImplementation(async () => {
      marked.resolve();
      return undefined;
    });
    let snapshot = fake.getSnapshot();
    const listeners = new Set<() => void>();
    const watched = {
      ...fake,
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const stop = watchTeamReplyRead(watched, origin);
    try {
      await withTimeout(attempted.promise, 1000, {
        timeoutError: () => new Error("Visible reply never attempted its lookup"),
      });
      fake.threadTask.mockResolvedValue({ ok: true, data: { taskId, completedAt: date(7) } });
      snapshot = client(date(3)).getSnapshot();
      for (const listener of listeners) listener();
      release.resolve();
      await withTimeout(marked.promise, 1000, {
        timeoutError: () => new Error("Receipt notice did not retry the visible reply"),
      });
      expect(fake.threadTask).toHaveBeenCalledTimes(2);
      expect(fake.visitThread).toHaveBeenCalledWith(taskId, date(7));
    } finally {
      release.resolve();
      stop();
    }
  });

  it("does not mark a reply whose lookup finishes after it leaves the focused view", async () => {
    const fake = client(date(3));
    const lookup = Promise.withResolvers<Awaited<ReturnType<typeof fake.threadTask>>>();
    fake.threadTask.mockReturnValue(lookup.promise);
    const listeners = new Set<() => void>();
    const stop = watchTeamReplyRead(
      {
        ...fake,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      origin,
    );
    stop();
    lookup.resolve({ ok: true, data: { taskId, completedAt: date(7) } });
    await lookup.promise;
    expect(fake.visitThread).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});
