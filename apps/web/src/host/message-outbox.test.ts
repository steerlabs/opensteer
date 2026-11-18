import { IDBFactory } from "fake-indexeddb";
import { controlledClientSession } from "@opensteer/client/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserMessageRecords } from "./message-outbox-records.js";
import {
  initializeBrowserMessageOutbox,
  restoreComposerDraft,
  sendMessageCommand,
} from "./message-outbox.js";
import {
  createMessageOutbox,
  createMessageOutboxStorage,
  hostMessageOutbox,
  disposeMessageOutbox,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { createId } from "@opensteer/core";

import {
  composerDraftKey,
  createComposerDraftStore,
  type DraftStorage,
} from "../components/composer-drafts.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("persists and sends messages through IndexedDB without Web Locks", async () => {
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("window", new EventTarget());
  const session = controlledClientSession();
  session.change({ phase: "recovering" });
  const storage = createMessageOutboxStorage(browserMessageRecords());
  const acknowledgement = Promise.withResolvers<{ messageId: string }>();
  const dispatch = vi.fn(() => acknowledgement.promise);
  const outbox = createMessageOutbox({
    session,
    storage,
    dispatch,
    drafts: { restore: async () => "restored" },
  });
  try {
    const command = sendMessageCommand(createId("thread"), {
      body: "Stays on this device until the Host is ready",
      attachments: [],
      idempotencyKey: "no-locks",
    });
    await outbox.enqueue(command);
    const scope = session.connection.getSnapshot().scope!;
    expect((await storage.load(scope))[0]?.command).toEqual(command);
    expect(dispatch).not.toHaveBeenCalled();
    session.change({ phase: "ready", readyRevision: 2 });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce(), { timeout: 1_000 });
    acknowledgement.resolve({ messageId: "ack" });
    await vi.waitFor(() => expect(outbox.getSnapshot().messages).toEqual([]), { timeout: 1_000 });
  } finally {
    acknowledgement.resolve({ messageId: "ack" });
    outbox.dispose();
  }
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
      const outbox = hostMessageOutbox(client)!;
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

function memoryStorage(): DraftStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, value),
  };
}

describe("Edit's hand-back to the composer draft", () => {
  it("puts the whole message above a draft already there, and is idempotent", () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    const scope = {
      authorityKey: "host",
      deploymentId: "deployment",
      viewerId: "viewer",
      loginId: "login",
    };
    const threadId = createId("thread");
    const key = composerDraftKey(
      { deploymentId: "deployment", userId: "viewer" },
      { kind: "thread", threadId },
    );
    drafts.update(key, { text: "Newer draft" });
    const file = {
      artifactId: createId("attachment"),
      mediaType: "application/pdf",
      name: "agenda.pdf",
      sizeBytes: 2048,
      type: "artifact" as const,
    };
    const quotedMessageId = createId("message");
    const entry = {
      localId: "queued",
      command: {
        content: [{ text: "Queued words", type: "text" as const }, file],
        delivery: "queue" as const,
        idempotencyKey: "queued",
        quotedMessageId,
        threadId,
        type: "thread.sendMessage" as const,
      },
      createdAt: new Date().toISOString(),
      order: 1,
      attempted: false,
      phase: "waiting" as const,
    };
    drafts.update(key, {
      quote: { messageId: createId("message"), attribution: "Other", excerpt: "Other" },
    });
    expect(restoreComposerDraft(drafts, scope, entry)).toBe("occupied");
    expect(drafts.read(key)?.text).toBe("Newer draft");
    drafts.update(key, { quote: null });
    expect(restoreComposerDraft(drafts, scope, entry)).toBe("restored");
    expect(restoreComposerDraft(drafts, scope, entry)).toBe("restored");
    expect(drafts.read(key)).toMatchObject({
      files: [{ part: file }],
      quote: { messageId: quotedMessageId },
      text: "Queued words\n\nNewer draft",
    });
  });
});
