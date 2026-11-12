import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { trackThreadVisits } from "./thread-visits.js";
import type { HostSnapshot, MessageEntry } from "./client.js";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  const mock = new MockHostClient({ latencyMs: 0 });
  disposers.push(() => mock.dispose());
  let snapshot = mock.getSnapshot();
  const thread = snapshot.threads[0]!;
  const id = thread.id;
  snapshot = {
    ...snapshot,
    threadVisits: {},
    threads: [{ ...thread, latestRunCompletedAt: null, lastVisitedAt: null }],
    transcripts: { [id]: [] },
  };
  const listeners = new Set<() => void>();
  const visitThread = vi.fn(async (): Promise<void> => undefined);
  const client = {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    visitThread,
  };
  const change = (patch: Partial<HostSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const fn of listeners) fn();
  };
  return { id, thread, client, change, visitThread, snapshot: () => snapshot };
}
it("coalesces Host completions and presented replies, ignores streaming and deduplicates echoes", async () => {
  const f = fixture();
  const stop = trackThreadVisits(f.client, f.id);
  disposers.push(stop);
  f.change({
    threads: [
      { ...f.thread, latestRunCompletedAt: "2026-01-02T00:00:00.000Z", lastVisitedAt: null },
    ],
  });
  const reply: MessageEntry = {
    kind: "message",
    id: "reply",
    body: "Ready",
    createdAt: "2026-01-03T00:00:00.000Z",
    messageKind: "assistant",
    published: true,
    author: { kind: "platform", cause: "test" },
    runId: null,
  };
  const unpublished = { ...reply };
  delete unpublished.published;
  f.change({ transcripts: { [f.id]: [reply] } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.visitThread).toHaveBeenCalledExactlyOnceWith(f.id, reply.createdAt);
  f.change({
    transcripts: {
      [f.id]: [
        reply,
        {
          ...unpublished,
          id: "stream",
          streaming: true,
          createdAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    },
  });
  f.change({
    transcripts: {
      [f.id]: [
        reply,
        {
          ...unpublished,
          id: "settled-stream",
          streaming: false,
          createdAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    },
  });
  f.change({ threadVisits: { [f.id]: reply.createdAt } });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.visitThread).toHaveBeenCalledTimes(1);
});
it("cancels queued work when a retained pane stops being presented and retries failure only on later activity", async () => {
  const f = fixture();
  f.change({
    threads: [
      { ...f.thread, latestRunCompletedAt: "2026-01-02T00:00:00.000Z", lastVisitedAt: null },
    ],
  });
  trackThreadVisits(f.client, f.id)();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.visitThread).not.toHaveBeenCalled();
  f.visitThread.mockRejectedValueOnce(new Error("Disconnected"));
  disposers.push(trackThreadVisits(f.client, f.id));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.visitThread).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.visitThread).toHaveBeenCalledTimes(1);
  f.change({ connection: "connected" });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.visitThread).toHaveBeenCalledTimes(2);
});

it("coalesces a newer completion while a visit is pending, including its echo", async () => {
  const f = fixture();
  const answer = Promise.withResolvers<void>();
  f.visitThread.mockImplementationOnce(() => answer.promise);
  const completion = (at: string) =>
    f.change({ threads: [{ ...f.thread, latestRunCompletedAt: at, lastVisitedAt: null }] });
  completion("2026-01-02T00:00:00.000Z");
  disposers.push(trackThreadVisits(f.client, f.id));
  await vi.advanceTimersByTimeAsync(0);
  completion("2026-01-03T00:00:00.000Z");
  f.change({ threadVisits: { [f.id]: "2026-01-02T00:00:00.000Z" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.visitThread).toHaveBeenCalledTimes(1);
  answer.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.visitThread).toHaveBeenCalledTimes(2);
  expect(f.visitThread).toHaveBeenLastCalledWith(f.id, "2026-01-03T00:00:00.000Z");
});
