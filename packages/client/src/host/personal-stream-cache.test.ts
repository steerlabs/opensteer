import { createId } from "@opensteer/core";
import { expect, test } from "vitest";
import { memoryCheckpointStorage } from "../test-support/memory-checkpoint-storage.js";
import {
  createPersonalStreamCache,
  personalCacheFormat,
  type PersonalStreamCheckpoint,
} from "./personal-stream-cache.js";

const deploymentId = createId("deployment");
const viewerId = createId("user");
const epoch = crypto.randomUUID();
const threadId = createId("thread");
const nodeId = createId("executionNode");
const identity = { deploymentId, viewerId, epoch, format: personalCacheFormat } as const;

function checkpoint(
  scopeKey: PersonalStreamCheckpoint["scope"]["scopeKey"],
  afterSequence: string,
) {
  return {
    scope: { ...identity, scopeKey },
    cursor: { deploymentId, viewerId, epoch, scopeKey, afterSequence },
    kind: "detail",
    state: { thread: { id: threadId } },
  } as unknown as PersonalStreamCheckpoint;
}

test("keeps one stored key per scope and removes a viewer's, a thread's and an old format's keys", async () => {
  const storage = memoryCheckpointStorage();
  storage.values.set(JSON.stringify([64, deploymentId, viewerId, epoch, "shell", null]), {
    value: "{}",
    savedAt: 0,
  });
  const cache = createPersonalStreamCache(storage);
  const other = createId("thread");
  await cache.commit(checkpoint(`thread:${threadId}`, "1"), () => true);
  await cache.commit(checkpoint(`node:${nodeId}`, "2"), () => true);
  await cache.commit(
    { ...checkpoint(`thread:${other}`, "3"), state: { thread: { id: other } } } as never,
    () => true,
  );
  await cache.commit(checkpoint(`thread:${threadId}`, "4"), () => true);
  // The old format's blob is gone; each scope has exactly one key.
  expect(storage.values.size).toBe(3);
  expect(
    (await cache.load({ ...identity, scopeKey: `thread:${threadId}` }))?.cursor.afterSequence,
  ).toBe("4");
  expect(
    (await cache.load({ ...identity, scopeKey: `node:${nodeId}` }))?.cursor.afterSequence,
  ).toBe("2");
  await cache.removeThread(identity, threadId);
  expect(await cache.load({ ...identity, scopeKey: `node:${nodeId}` })).toBeNull();
  expect(await cache.load({ ...identity, scopeKey: `thread:${threadId}` })).toBeNull();
  expect(storage.values.size).toBe(1);
  await cache.removeViewer({ deploymentId, viewerId });
  expect(storage.values.size).toBe(0);
});

test("a write that fails midway leaves the previous checkpoint readable", async () => {
  const storage = memoryCheckpointStorage();
  const cache = createPersonalStreamCache(storage);
  await cache.commit(checkpoint(`thread:${threadId}`, "1"), () => true);
  storage.write = async () => {
    throw new Error("The disk filled up.");
  };
  await expect(cache.commit(checkpoint(`thread:${threadId}`, "2"), () => true)).rejects.toThrow();
  expect(
    (await cache.load({ ...identity, scopeKey: `thread:${threadId}` }))?.cursor.afterSequence,
  ).toBe("1");
  // Later work is not stuck behind the failure.
  await cache.removeViewer({ deploymentId, viewerId });
  expect(storage.values.size).toBe(0);
});

test("keeps the newest checkpoints within the entry budget", async () => {
  const storage = memoryCheckpointStorage();
  const cache = createPersonalStreamCache(storage);
  const threads = Array.from({ length: 20 }, () => createId("thread"));
  for (const id of threads)
    await cache.commit(
      { ...checkpoint(`thread:${id}`, "1"), state: { thread: { id } } } as never,
      () => true,
    );
  expect(storage.values.size).toBe(16);
  expect(await cache.load({ ...identity, scopeKey: `thread:${threads[0]}` })).toBeNull();
  expect(await cache.load({ ...identity, scopeKey: `thread:${threads[19]}` })).not.toBeNull();
});
