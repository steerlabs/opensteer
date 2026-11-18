import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { createMessageOutboxStorage } from "./message-outbox-storage.js";
import { clientScopeKey } from "../connections/connection-controller.js";
import { controlledClientSession } from "../test-support/client-connection.js";
import type { StoredMessage } from "./message-outbox.js";

it("isolates durable records by login and rejects corrupt or mismatched commands", async () => {
  const records = new Map<string, string>();
  const storage = createMessageOutboxStorage({
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => {
      records.set(key, value);
    },
    remove: async (key) => {
      records.delete(key);
    },
  });
  const scope = controlledClientSession().connection.getSnapshot().scope!;
  const entry: StoredMessage = {
    localId: "frozen-key",
    command: {
      type: "thread.sendMessage",
      threadId: createId("thread"),
      idempotencyKey: "frozen-key",
      content: [{ type: "text", text: "Private words" }],
      delivery: "queue",
    },
    createdAt: new Date().toISOString(),
    order: 1,
    attempted: false,
    phase: "waiting",
  };
  await storage.put(scope, entry);
  expect(await storage.load(scope)).toEqual([entry]);
  expect(await storage.load({ ...scope, loginId: "new-login" })).toEqual([]);
  const [key, raw] = [...records.entries()][0]!;
  const corrupted = JSON.parse(raw) as { entries: { localId: string }[] };
  corrupted.entries[0]!.localId = "different-key";
  records.set(key, JSON.stringify(corrupted));
  await expect(storage.load(scope)).rejects.toThrow();
  records.set(key, "{ interrupted write");
  await expect(storage.load(scope)).rejects.toThrow();
});

it("replays old claims as uncertain and drops their permanent owners", async () => {
  const scope = controlledClientSession().connection.getSnapshot().scope!;
  const id = globalThis.crypto.randomUUID();
  const threadId = createId("thread");
  let raw = JSON.stringify({
    version: 1,
    scope: clientScopeKey(scope),
    entries: [
      {
        localId: "old-claim",
        command: {
          type: "thread.sendMessage",
          threadId,
          idempotencyKey: "old-claim",
          content: [{ type: "text", text: "Held across upgrade" }],
        },
        createdAt: new Date().toISOString(),
        order: 1,
        attempted: true,
        phase: "sending",
        attemptId: id,
        inFlight: [id],
      },
    ],
  });
  const storage = createMessageOutboxStorage({
    read: async () => raw,
    write: async (_key, value) => {
      raw = value;
    },
    remove: async () => {},
  });
  const [waiting] = await storage.load(scope);
  expect(waiting).toMatchObject({ phase: "waiting", attempted: true, uncertain: true });
  const claim = await storage.claim(
    scope,
    waiting!,
    globalThis.crypto.randomUUID(),
    100,
    undefined,
    () => true,
  );
  await claim!.settle({ code: "rejected" });
  expect(await storage.load(scope)).toMatchObject([
    { phase: "rejected", rejection: { code: "unconfirmed" } },
  ]);
  expect(raw).not.toContain(id);
});

it("keeps concurrent windows' writes and enforces the thread bound atomically", async () => {
  const records = new Map<string, string>(),
    queue = new MutationQueue();
  const port = {
    read: async (key: string) => records.get(key) ?? null,
    write: async (key: string, value: string) => {
      records.set(key, value);
    },
    remove: async (key: string) => {
      records.delete(key);
    },
    mutate: (key: string, edit: (raw: string | null) => string | null) =>
      queue.run(async () => {
        const value = edit(records.get(key) ?? null);
        if (value === null) records.delete(key);
        else records.set(key, value);
      }),
  };
  const first = createMessageOutboxStorage(port),
    second = createMessageOutboxStorage(port);
  const scope = controlledClientSession().connection.getSnapshot().scope!,
    threadId = createId("thread");
  const entry = (index: number): StoredMessage => ({
    localId: `key-${index}`,
    command: {
      type: "thread.sendMessage",
      threadId,
      idempotencyKey: `key-${index}`,
      content: [{ type: "text", text: String(index) }],
    },
    createdAt: new Date().toISOString(),
    order: index,
    attempted: false,
    phase: "waiting",
  });
  const results = await Promise.allSettled(
    Array.from({ length: 21 }, (_, i) => (i % 2 ? first : second).put(scope, entry(i))),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(20);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const saved = await first.load(scope);
  expect(saved).toHaveLength(20);
  expect(new Set(saved.map((entry) => entry.localId)).size).toBe(20);
});
