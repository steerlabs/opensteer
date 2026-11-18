import { afterEach, expect, it, vi } from "vitest";
import { browserMessageRecords } from "./message-outbox-records.js";
import { initializeBrowserMessageOutbox, sendMessageCommand } from "./message-outbox.js";
import { hostMessageOutbox, disposeMessageOutbox } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { createId } from "@opensteer/core";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("disables browser message storage when cross-window locks are unavailable", async () => {
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("BroadcastChannel", undefined);
  const open = vi.fn(() => {
    throw new Error("IndexedDB should not be used without Web Locks");
  });
  vi.stubGlobal("indexedDB", { open });
  await expect(browserMessageRecords().read("scope")).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
});

it.each(["one malformed entry", "localStorage inaccessible"] as const)(
  "keeps the durable queue usable with %s",
  async (problem) => {
    vi.useFakeTimers();
    const client = new MockHostClient({ latencyMs: 0 });
    const records = new Map<string, string>();
    const legacy = new Map<string, string>();
    if (problem === "localStorage inaccessible") {
      vi.stubGlobal(
        "localStorage",
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("denied");
            },
          },
        ),
      );
    } else {
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => legacy.get(key) ?? null,
        removeItem: (key: string) => legacy.delete(key),
      });
    }
    try {
      await vi.advanceTimersByTimeAsync(0);
      const scope = client.connection.getSnapshot().scope!;
      const command = sendMessageCommand(createId("thread"), {
        body: "Legacy",
        attachments: [],
        idempotencyKey: "legacy",
      });
      if (problem === "one malformed entry") {
        const prefix = `opensteer:pending-send:v1:${scope.deploymentId}:${scope.viewerId}:`;
        legacy.set(prefix + createId("thread"), "{ invalid");
        legacy.set(prefix + command.threadId, JSON.stringify(command));
        for (const key of legacy.keys())
          Object.defineProperty(globalThis.localStorage, key, {
            enumerable: true,
            configurable: true,
          });
        globalThis.localStorage.removeItem = (key: string) => {
          legacy.delete(key);
          Reflect.deleteProperty(globalThis.localStorage, key);
        };
      }
      client.connection.stop();
      initializeBrowserMessageOutbox(client, {
        read: async (key) => records.get(key) ?? null,
        write: async (key, value) => {
          records.set(key, value);
        },
        remove: async (key) => {
          records.delete(key);
        },
      });
      const outbox = hostMessageOutbox(client);
      await vi.advanceTimersByTimeAsync(0);
      expect(outbox.getSnapshot().issue).toBeNull();
      if (problem === "one malformed entry")
        expect(outbox.getSnapshot().messages).toMatchObject([
          { localId: "legacy", phase: "rejected" },
        ]);
      const draft = sendMessageCommand(createId("thread"), {
        body: "New",
        attachments: [],
        idempotencyKey: "new",
      });
      await expect(outbox.enqueue(draft)).resolves.toBe("new");
    } finally {
      disposeMessageOutbox(client);
      client.dispose();
    }
  },
);
