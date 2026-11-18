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
  HostClientRequestError,
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

it("fences a paused dispatch in another window after a refusal is edited", async () => {
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("window", new EventTarget());
  const a = controlledClientSession();
  const b = controlledClientSession();
  a.change({ phase: "recovering" });
  b.change({ phase: "recovering" });
  const first = createMessageOutboxStorage(browserMessageRecords());
  const other = createMessageOutboxStorage(browserMessageRecords());
  const held = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  // Each renderer has a different fallback lock. Pause this one after it
  // finishes the durable sending claim, before it can invoke dispatch.
  const second = {
    ...other,
    delivery: <T>(
      _scope: Parameters<typeof other.load>[0],
      _threadId: string,
      work: () => Promise<T>,
    ) => work(),
    async replace(...args: Parameters<NonNullable<typeof other.replace>>) {
      const replaced = await other.replace!(...args);
      if (args[2]?.phase === "sending" && args[1].localId === "take-back") {
        held.resolve();
        await resume.promise;
      }
      return replaced;
    },
  };
  const acknowledgement = Promise.withResolvers<never>();
  const sentA = vi.fn(() => acknowledgement.promise);
  const sentB = vi.fn(async () => ({ messageId: "delivered" }));
  const drafts = { restore: async () => "restored" as const };
  const writer = createMessageOutbox({ session: a, storage: first, dispatch: sentA, drafts });
  const reader = createMessageOutbox({ session: b, storage: second, dispatch: sentB, drafts });
  try {
    const pending = sendMessageCommand(createId("thread"), {
      body: "Take this back",
      attachments: [],
      idempotencyKey: "take-back",
    });
    await writer.enqueue(pending);
    a.change({ phase: "ready", readyRevision: 2 });
    await vi.waitFor(() => expect(sentA).toHaveBeenCalledOnce(), { timeout: 1000 });
    await reader.enqueue(pending);
    b.change({ phase: "ready", readyRevision: 2 });
    await vi.waitFor(() => expect(reader.getSnapshot().messages).toHaveLength(1), {
      timeout: 1000,
    });
    let paused = false;
    void held.promise.then(() => {
      paused = true;
    });
    await vi.waitFor(() => expect(paused).toBe(true), { timeout: 1000 });
    acknowledgement.reject(
      new HostClientRequestError({
        code: "forbidden",
        status: 403,
        message: "Refused",
        retryable: false,
      }),
    );
    await vi.waitFor(() => expect(writer.getSnapshot().messages[0]?.phase).toBe("rejected"), {
      timeout: 1000,
    });
    await expect(writer.restoreDraft("take-back")).resolves.toBe("restored");
    resume.resolve();
    await reader.enqueue(pending);
    await reader.enqueue({ ...pending, idempotencyKey: "follows" });
    await vi.waitFor(() => expect(reader.getSnapshot().messages).toEqual([]), { timeout: 1000 });
    expect(sentB.mock.calls).toEqual([[expect.objectContaining({ idempotencyKey: "follows" })]]);
  } finally {
    resume.resolve();
    acknowledgement.resolve(undefined as never);
    writer.dispose();
    reader.dispose();
  }
});

it("keeps a shared take-back fenced when one window cannot restore its copy", async () => {
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("window", new EventTarget());
  const first = controlledClientSession();
  const second = controlledClientSession();
  const scope = { ...first.connection.getSnapshot().scope!, loginId: "simultaneous-edit" };
  for (const session of [first, second]) session.change({ scope, phase: "recovering" });
  const occupied = Promise.withResolvers<"occupied">();
  const restored = Promise.withResolvers<"restored">();
  const dispatch = vi.fn(async () => ({ messageId: "should-not-send" }));
  const outbox = (session: typeof first, restore: () => Promise<"occupied" | "restored">) =>
    createMessageOutbox({
      session,
      dispatch,
      drafts: { restore },
      storage: {
        ...createMessageOutboxStorage(browserMessageRecords()),
        delivery: (_scope, _threadId, work) => work(),
      },
    });
  const restoreA = vi.fn(() => occupied.promise);
  const restoreB = vi.fn(() => restored.promise);
  const a = outbox(first, restoreA);
  const b = outbox(second, restoreB);
  const pending = sendMessageCommand(createId("thread"), {
    body: "Restore this message",
    attachments: [],
    idempotencyKey: "shared-edit",
  });
  try {
    await a.enqueue(pending);
    await b.enqueue(pending);
    const editingA = a.restoreDraft(pending.idempotencyKey);
    await vi.waitFor(() => expect(restoreA).toHaveBeenCalledOnce(), { timeout: 1000 });
    const editingB = b.restoreDraft(pending.idempotencyKey).catch((error: unknown) => error);
    await vi.waitFor(() => expect(restoreB).toHaveBeenCalledOnce(), { timeout: 1000 });
    occupied.resolve("occupied");
    await expect(editingA).resolves.toBe("occupied");
    expect(a.getSnapshot().messages[0]?.phase).toBe("restoring");
    first.change({ phase: "ready", readyRevision: 2 });
    restored.resolve("restored");
    await expect(editingB).resolves.toBe("restored");
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    occupied.resolve("occupied");
    restored.resolve("restored");
    a.dispose();
    b.dispose();
  }
});

it("allocates distinct send order inside IndexedDB for two writers with the same snapshot", async () => {
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("window", new EventTarget());
  const session = controlledClientSession();
  const scope = { ...session.connection.getSnapshot().scope!, loginId: "simultaneous-enqueue" };
  const one = createMessageOutboxStorage(browserMessageRecords());
  const two = createMessageOutboxStorage(browserMessageRecords());
  const threadId = createId("thread");
  const row = (localId: string) => ({
    localId,
    order: 1,
    createdAt: new Date().toISOString(),
    attempted: false,
    phase: "waiting" as const,
    command: sendMessageCommand(threadId, {
      body: localId,
      attachments: [],
      idempotencyKey: localId,
    }),
  });
  await Promise.all([
    one.put(scope, row("z-first"), { append: true }),
    two.put(scope, row("a-next"), { append: true }),
  ]);
  expect((await one.load(scope)).map(({ localId, order }) => ({ localId, order }))).toEqual([
    { localId: "z-first", order: 1 },
    { localId: "a-next", order: 2 },
  ]);
});

it.each(["foreground", "recovery"] as const)(
  "reloads the committed queue on %s when the browser could not signal another window",
  async (wake) => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("denied");
      },
    });
    const session = controlledClientSession();
    session.change({ scope: { ...session.connection.getSnapshot().scope!, loginId: wake } });
    const dispatch = vi.fn(async () => ({ messageId: "delivered" }));
    const reader = createMessageOutbox({
      session,
      dispatch,
      storage: createMessageOutboxStorage(browserMessageRecords()),
      drafts: { restore: async () => "restored" },
    });
    const scope = session.connection.getSnapshot().scope!;
    const writer = createMessageOutboxStorage(browserMessageRecords());
    try {
      await vi.waitFor(() => expect(reader.getSnapshot().loading).toBe(false), { timeout: 1000 });
      if (wake === "foreground") session.change({ visibility: "background" });
      else session.change({ phase: "recovering" });
      const command = sendMessageCommand(createId("thread"), {
        body: "Saved in another window",
        attachments: [],
        idempotencyKey: "missed-notice",
      });
      await writer.put(scope, {
        localId: command.idempotencyKey,
        command,
        phase: "waiting",
        attempted: false,
        createdAt: new Date().toISOString(),
        order: 1,
      });
      expect(reader.getSnapshot().messages).toEqual([]);
      if (wake === "foreground") session.change({ visibility: "foreground" });
      else session.change({ phase: "ready", readyRevision: 2 });
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(command), { timeout: 1000 });
    } finally {
      reader.dispose();
    }
  },
);

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
