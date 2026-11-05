import type { HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { ThreadReadStateSchema } from "@opensteer/core";
import { afterAll, expect, it } from "vitest";
import { voiceRowMark } from "./voice-row.js";

// The Voice Thread is unlisted, so the task list gives it no row: a question it
// asks would reach nobody, while one its listed task asks must not say so twice.

const host = new MockHostClient({ automations: "absent", latencyMs: 0 });
afterAll(() => host.dispose());
const base = host.getSnapshot();
const voice = { ...base.threads.find(({ id }) => id !== base.homeThreadId)!, listed: false };
const task = {
  ...base.threads.find(({ id }) => id !== base.homeThreadId && id !== voice.id)!,
  listed: true,
};
const helper = { ...task, id: "thr_helper", listed: false };
const snapshot = (patch: Partial<HostSnapshot> = {}): HostSnapshot => ({
  ...base,
  threadReadStates: {},
  threads: [
    { ...voice, status: "idle" },
    task,
    helper,
    ...base.threads.filter(({ id }) => id !== voice.id && id !== task.id),
  ],
  voiceThreadId: voice.id,
  waitingRequests: [],
  ...patch,
});
const waiting = (originatingThreadId: string, parents: readonly string[] = []) =>
  ({
    assignments: parents.map((parentThreadId) => ({ parentThreadId })),
    presentation: null,
    request: { originatingThreadId },
    subagent: null,
  }) as unknown as HostSnapshot["waitingRequests"][number];

it("says nothing before the Thread exists", () => {
  expect(voiceRowMark(snapshot({ voiceThreadId: null }))).toBeNull();
});

it("shows what the Voice Thread or its unlisted helpers ask, and leaves a task's ask on its row", () => {
  expect(voiceRowMark(snapshot({ waitingRequests: [waiting(voice.id)] }))).toBe("needs-you");
  expect(voiceRowMark(snapshot({ waitingRequests: [waiting(helper.id, [voice.id])] }))).toBe(
    "needs-you",
  );
  expect(voiceRowMark(snapshot({ waitingRequests: [waiting(task.id, [voice.id])] }))).toBeNull();
});

it("says it is working, then that something arrived unread", () => {
  const running = { ...voice, status: "running" as const };
  expect(voiceRowMark(snapshot({ threads: [running] }))).toBe("working");
  expect(
    voiceRowMark(
      snapshot({
        threadReadStates: {
          [voice.id]: ThreadReadStateSchema.parse({
            asOfSequence: "2",
            readSequence: "1",
            threadId: voice.id,
            unreadSequence: "2",
          }),
        },
      }),
    ),
  ).toBe("unread");
});
