import { createId } from "@opensteer/core";
import {
  type PersonalResumeCursor,
  ScopedHostMessageSchema,
} from "@opensteer/protocol/personal-sync";
import {
  PersonalResourceRevisionsSchema,
  personalResourceKinds,
} from "@opensteer/protocol/resources";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, test, vi } from "vitest";
import { PersonalSyncSocket } from "./personal-sync.js";

const scope = { kind: "shell" as const };
const deploymentId = createId("deployment");
const viewerId = createId("user");
const epoch = crypto.randomUUID();
const cursor: PersonalResumeCursor = {
  deploymentId,
  viewerId,
  epoch,
  scopeKey: "shell",
  afterSequence: "1",
};
const snapshot = {
  deploymentId,
  viewerId,
  epoch,
  tasks: [],
  visits: [],
  attention: [],
  counts: { pendingRequestCount: 0, needsYouCount: 0, unreadTaskCount: 0 },
  resourceRevisions: PersonalResourceRevisionsSchema.parse(
    Object.fromEntries(personalResourceKinds.map((kind) => [kind, "0"])),
  ),
};

const subscription = (generation: number) => ({
  type: "client.subscribe" as const,
  subscriptionId: "shell" as const,
  scope,
  generation,
});

function deadline<T>(promise: Promise<T>, message: string) {
  return withTimeout(promise, 1000, { timeoutError: () => new Error(message) });
}

test("registers before the cut and drains a later commit without another wake", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const frames: unknown[] = [];
  let reads = 0;
  const socket = new PersonalSyncSocket({
    async read(_scope, after) {
      reads++;
      if (after)
        return {
          throughSequence: "2",
          cursor: { ...cursor, afterSequence: "2" },
          frames: [
            {
              type: "host.changes",
              scope,
              fromSequence: after.afterSequence,
              throughSequence: "2",
              changes: [],
            },
          ],
        };
      entered.resolve();
      await release.promise;
      return {
        throughSequence: "1",
        cursor,
        frames: [{ type: "host.snapshot", scope, snapshot, throughSequence: "1" }],
      };
    },
    async send(raw, guard) {
      if (!guard()) return false;
      const frame = ScopedHostMessageSchema.parse(JSON.parse(raw));
      frames.push(frame);
      if (frame.type === "host.changes") delivered.resolve();
      return true;
    },
    close() {},
  });
  try {
    socket.subscribe(subscription(1));
    await deadline(entered.promise, "First cut did not start");
    socket.wake("2");
    socket.wake("1");
    release.resolve();
    await deadline(delivered.promise, "Committed work was left waiting for a later wake");
    expect(reads).toBe(2);
    expect(frames).toMatchObject([
      { type: "host.snapshot", generation: 1, throughSequence: "1" },
      { type: "host.synchronized", generation: 1, throughSequence: "1" },
      { type: "host.changes", generation: 1, throughSequence: "2" },
    ]);
  } finally {
    release.resolve();
    socket.close("test finished");
  }
});

test("cannot dispatch an old generation after replacing the same slot", async () => {
  const oldEntered = Promise.withResolvers<void>();
  const oldMaySend = Promise.withResolvers<void>();
  const oldDone = Promise.withResolvers<void>();
  const newDone = Promise.withResolvers<void>();
  const delivered: number[] = [];
  const closed = vi.fn();
  const socket = new PersonalSyncSocket({
    read: async () => ({
      throughSequence: "1",
      cursor,
      frames: [{ type: "host.snapshot", scope, snapshot, throughSequence: "1" }],
    }),
    async send(raw, guard) {
      const frame = ScopedHostMessageSchema.parse(JSON.parse(raw));
      if (frame.generation === 1) {
        oldEntered.resolve();
        await oldMaySend.promise;
        oldDone.resolve();
      }
      if (!guard()) return false;
      delivered.push(frame.generation);
      if (frame.type === "host.synchronized") newDone.resolve();
      return true;
    },
    close: closed,
  });
  try {
    socket.subscribe(subscription(1));
    await deadline(oldEntered.promise, "The old snapshot did not reach transport");
    socket.subscribe(subscription(2));
    await deadline(newDone.promise, "Replacement did not synchronize");
    socket.ack({ subscriptionId: "shell", generation: 1, throughSequence: "42" });
    oldMaySend.resolve();
    await deadline(oldDone.promise, "The old transport attempt did not settle");
    expect(delivered).toEqual([2, 2]);
    expect(closed).not.toHaveBeenCalled();
  } finally {
    oldMaySend.resolve();
    socket.close("test finished");
  }
});
