import {
  createMessageOutbox,
  createMessageOutboxStorage,
  messageStorageFingerprint,
} from "@opensteer/client/host";
import { controlledClientSession } from "@opensteer/client/test-support";
import { createId } from "@opensteer/core";
import {
  browserMessageRecords,
  browserTaskStartKeys,
  mutateBrowserMessageRecord,
} from "../../host/message-outbox-records.js";
import type { PendingSendCommand } from "@opensteer/client/host";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { ClientOperationError, clientScopeKey } from "@opensteer/client/connections";
import { ModelSelectionSchema } from "@opensteer/core";
import { createComposerDraftStore, type DraftStorage } from "../composer-drafts.js";
import { draftTaskStart, retireTaskStarts, startTask } from "./task-start.js";

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

const draftKey = "opensteer:composer-draft:v1:deployment:user:task:home";
const creation = {
  accessMode: "auto" as const,
  environmentId: "env",
  generateTitle: true as const,
  harnessInstanceId: "harness",
  modelSelection: ModelSelectionSchema.parse({
    modelId: "claude",
    options: {},
    providerId: "anthropic",
  }),
  title: "Compare quotes",
};

/** A Host that makes one task per creation key, and a link that can lose its answers. */
function host() {
  const tasks = new Map<string, string>();
  const queued: { threadId: string; key: string }[] = [];
  return {
    tasks,
    queued,
    createThread: vi.fn(async ({ idempotencyKey }: { idempotencyKey?: string }) => {
      const id = tasks.get(idempotencyKey!) ?? `thr_${tasks.size + 1}`;
      tasks.set(idempotencyKey!, id);
      return { id };
    }),
  };
}

function journal() {
  const records = new Map<string, string>();
  const writes = new MutationQueue();
  return {
    records,
    mutate: vi.fn((key: string, change: (raw: string | null) => string | null) =>
      writes.run(async () => {
        const next = change(records.get(key) ?? null);
        if (next === null) records.delete(key);
        else records.set(key, next);
      }),
    ),
  };
}

let keys = 0;
async function attempt(
  drafts: ReturnType<typeof createComposerDraftStore>,
  fake: ReturnType<typeof host>,
  saved: ReturnType<typeof journal>,
  enqueue = async (threadId: string, key: string, _content: PendingSendCommand["content"]) => {
    if (!fake.queued.some((entry) => entry.key === key)) fake.queued.push({ threadId, key });
  },
) {
  const generation = drafts.taskStartGeneration(draftKey);
  if (generation === null) throw new Error("Draft storage refused.");
  return startTask({
    records: draftTaskStart(draftKey, generation, saved.mutate),
    creation,
    creationKey: () => `thread-key-${++keys}`,
    messageKey: `message-key-${++keys}`,
    message: { content: [{ type: "text", text: drafts.read(draftKey)?.text ?? "Text" }] },
    legacyStart: drafts.read(draftKey)?.start,
    confirmLegacy: true,
    assertCurrent: () => {},
    createThread: fake.createThread,
    enqueue: (command) => enqueue(command.threadId, command.idempotencyKey, command.content),
  });
}

const lost = () =>
  new ClientOperationError("The answer was lost.", "transient", {
    kind: "transport",
    provenance: "transport",
    retryable: true,
  });

afterEach(() => vi.unstubAllGlobals());

it("reclaims settled handoff receipts after discard and fences a stale window", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const scope = controlledClientSession().connection.getSnapshot().scope!;
  const key = JSON.stringify([clientScopeKey(scope), draftKey]);
  const generation = "discarded-generation";
  let active: string | undefined = generation;
  const records = draftTaskStart(key, generation);
  const storage = createMessageOutboxStorage(browserMessageRecords({ notify: false }));
  const threadId = createId("thread");
  const first = "settled-first-message";
  const entry = {
    createdAt: new Date().toISOString(),
    order: 1,
    phase: "waiting" as const,
    attempted: false,
    localId: first,
    command: {
      type: "thread.sendMessage" as const,
      threadId,
      idempotencyKey: first,
      content: [{ type: "text" as const, text: "Private words" }],
    },
  };
  await records.claim(
    () => ({
      creation: { ...creation, idempotencyKey: "same-task" },
      messageKey: first,
      threadId,
    }),
    () => {},
  );
  await storage.put(scope, entry, { handoff: true });
  await storage.remove(scope, first);
  const oldId = "legacy-completed-message";
  const oldDraft = draftKey + "-legacy";
  const oldKey = JSON.stringify([clientScopeKey(scope), oldDraft]);
  await mutateBrowserMessageRecord(`task-start:${oldKey}`, () =>
    JSON.stringify({ completedThreadId: threadId, generation: "legacy-completion" }),
  );
  await mutateBrowserMessageRecord(
    `message-outbox-v1-${messageStorageFingerprint(clientScopeKey(scope)!)}`,
    (raw) => {
      const record = JSON.parse(raw!);
      return JSON.stringify({ ...record, handoffs: [...record.handoffs, oldId] });
    },
  );
  expect(await storage.hasHandoff?.(scope, oldId)).toBe(true);
  await retireTaskStarts(() => active);
  expect(await storage.hasHandoff?.(scope, first)).toBe(true);
  active = undefined;
  await expect(retireTaskStarts(() => active, draftKey, generation)).resolves.toMatchObject({
    creation: { idempotencyKey: "same-task" },
    threadId,
    messageKey: first,
  });
  expect(await browserTaskStartKeys()).toEqual([]);
  expect(await storage.hasHandoff?.(scope, oldId)).toBe(false);
  expect(await storage.hasHandoff?.(scope, first)).toBe(false);
  await expect(
    records.claim(
      () => {
        throw new Error("A stale journal cannot be re-created.");
      },
      () => {
        if (active !== generation) throw new Error("Draft discarded.");
      },
    ),
  ).rejects.toThrow();
});

describe("starting a new task from a draft", () => {
  it("does not create a task when IndexedDB rejects the start transaction", async () => {
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    const fake = host();
    const saved = journal();
    drafts.update(draftKey, { text: "Compare quotes" });
    saved.mutate.mockRejectedValueOnce(new Error("disk full"));
    await expect(attempt(drafts, fake, saved)).rejects.toThrow();
    expect(fake.createThread).not.toHaveBeenCalled();
  });

  it("uses one creation key when separate windows start the same saved draft", async () => {
    const storage = memoryStorage();
    const first = createComposerDraftStore(() => storage);
    const second = createComposerDraftStore(() => storage);
    const fake = host();
    const saved = journal();
    first.update(draftKey, { text: "Compare quotes" });
    // Both readers can capture the same value before either commits a claim.
    const [started, another] = await Promise.all([
      attempt(first, fake, saved),
      attempt(second, fake, saved),
    ]);
    expect(another).toEqual(started);
    await expect(attempt(second, fake, saved)).resolves.toEqual(started);
    second.clear(draftKey);
    second.update(draftKey, { text: "A different draft" });
    expect(await attempt(second, fake, saved)).not.toEqual(started);
    expect(fake.tasks.size).toBe(2);
    expect(fake.queued).toHaveLength(2);
  });

  it("makes one task when the creation's answer is lost and Start is pressed again after a reload", async () => {
    const storage = memoryStorage();
    const fake = host();
    const saved = journal();
    const first = createComposerDraftStore(() => storage);
    first.update(draftKey, { text: "Compare quotes" });
    const made = fake.createThread.getMockImplementation()!;
    fake.createThread.mockImplementationOnce(async (input) => {
      await made(input);
      throw lost();
    });
    await expect(attempt(first, fake, saved)).rejects.toThrow();

    // A reload reads the same draft from storage.
    const reloaded = createComposerDraftStore(() => storage);
    const thread = await attempt(reloaded, fake, saved);
    expect(fake.tasks.size).toBe(1);
    expect(thread.id).toBe("thr_1");
    expect(fake.queued).toEqual([{ threadId: "thr_1", key: expect.any(String) }]);
    expect([...saved.records.values()].map((value) => JSON.parse(value))).toMatchObject([
      { completedThreadId: "thr_1" },
    ]);
  });

  it("queues the first message on retry without making the task again when this device couldn't save it", async () => {
    const fake = host();
    const saved = journal();
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    drafts.update(draftKey, { text: "Compare quotes" });
    await expect(
      attempt(drafts, fake, saved, async () => {
        throw new Error("Storage refused.");
      }),
    ).rejects.toThrow();
    const [raw] = saved.records.values();
    const held = JSON.parse(raw!) as { start: { threadId: string; messageKey: string } };
    expect(held.start.threadId).toBe("thr_1");

    await attempt(drafts, fake, saved);
    expect(fake.createThread).toHaveBeenCalledOnce();
    expect(fake.queued).toEqual([{ threadId: "thr_1", key: held.start.messageKey }]);
  });

  it("queues the revised first message after a failed save and rejects a different draft after completion", async () => {
    const fake = host();
    const saved = journal();
    const drafts = createComposerDraftStore(() => memory);
    const memory = memoryStorage();
    drafts.update(draftKey, { text: "Version A" });
    await expect(
      attempt(drafts, fake, saved, async () => {
        throw new Error("Disk full.");
      }),
    ).rejects.toThrow();

    drafts.update(draftKey, { text: "Version B" });
    const enqueue = vi.fn(
      async (_threadId: string, _key: string, _message: PendingSendCommand["content"]) => {},
    );
    await expect(attempt(drafts, fake, saved, enqueue)).resolves.toEqual({ id: "thr_1" });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith("thr_1", expect.any(String), [
      { type: "text", text: "Version B" },
    ]);
    expect(fake.createThread).toHaveBeenCalledOnce();

    drafts.update(draftKey, { text: "Version C" });
    await expect(attempt(drafts, fake, saved, enqueue)).rejects.toThrow();
    expect(drafts.read(draftKey)?.text).toBe("Version C");
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("imports a previous-format draft's confirmed task and message keys before sending", async () => {
    const store = memoryStorage();
    const drafts = createComposerDraftStore(() => store);
    const fake = host();
    const saved = journal();
    store.setItem(
      draftKey,
      JSON.stringify({
        text: "A previous draft",
        updatedAt: 100,
        files: [],
        quote: null,
        start: {
          creation: { ...creation, idempotencyKey: "previous-creation" },
          messageKey: "previous-message",
          threadId: "previous-task",
        },
      }),
    );
    await expect(attempt(drafts, fake, saved)).resolves.toEqual({ id: "previous-task" });
    expect(fake.createThread).not.toHaveBeenCalled();
    expect(fake.queued).toEqual([{ threadId: "previous-task", key: "previous-message" }]);
  });

  it("does not duplicate message contents in the journal after a handoff failure", async () => {
    const drafts = createComposerDraftStore(() => memory);
    const memory = memoryStorage();
    const fake = host();
    const saved = journal();
    drafts.update(draftKey, { text: "Private unfinished message" });
    await expect(
      attempt(drafts, fake, saved, async () => {
        throw new Error("Disk full.");
      }),
    ).rejects.toThrow();
    expect([...saved.records.values()].join()).not.toContain("Private unfinished message");
    expect(drafts.read(draftKey)?.text).toBe("Private unfinished message");
  });

  it("settles the revised message's durable receipt after upgrade and interrupted completion", async () => {
    const session = controlledClientSession();
    session.change({ phase: "recovering" });
    const scope = session.connection.getSnapshot().scope!;
    const threadId = createId("thread");
    const saved = journal();
    const generation = "previous-journal";
    const messageKey = "previous-first-message";
    const message = { content: [{ type: "text" as const, text: "Revised and saved" }] };
    const command = {
      ...message,
      threadId,
      idempotencyKey: messageKey,
      type: "thread.sendMessage" as const,
      delivery: "queue" as const,
    };
    saved.records.set(
      `task-start:${draftKey}`,
      JSON.stringify({
        generation,
        start: {
          creation: { ...creation, idempotencyKey: "previous-creation" },
          message: { content: [{ type: "text", text: "Old words" }] },
          messageKey,
          threadId,
        },
      }),
    );
    const raw = new Map<string, string>();
    const storage = createMessageOutboxStorage({
      read: async (key) => raw.get(key) ?? null,
      write: async (key, value) => void raw.set(key, value),
      remove: async (key) => void raw.delete(key),
    });
    await storage.put(
      scope,
      {
        command,
        localId: messageKey,
        phase: "waiting",
        attempted: false,
        order: 1,
        createdAt: new Date().toISOString(),
      },
      { handoff: true },
    );
    await storage.remove(scope, messageKey);
    const outbox = createMessageOutbox({
      session,
      storage,
      dispatch: vi.fn(async () => ({ messageId: "unexpected" })),
      drafts: { restore: async () => "restored" },
    });
    const createThread = vi.fn();
    try {
      await expect(
        startTask({
          records: draftTaskStart(draftKey, generation, saved.mutate),
          creation,
          creationKey: () => "unused",
          createThread,
          message,
          messageKey,
          assertCurrent: () => {},
          hasLegacyHandoff: (id) => outbox.hasHandoff(scope, id, "legacy"),
          enqueue: (pending) => outbox.enqueue(pending, { handoff: true, assertCurrent: () => {} }),
        }),
      ).resolves.toEqual({ id: threadId });
      expect(createThread).not.toHaveBeenCalled();
      expect(await storage.load(scope)).toEqual([]);
    } finally {
      outbox.dispose();
    }
  });

  it("starts afresh after the Host refused the creation, so a changed choice is not refused again", async () => {
    const fake = host();
    const saved = journal();
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    drafts.update(draftKey, { text: "Compare quotes" });
    fake.createThread.mockRejectedValueOnce(
      new ClientOperationError("No such model.", "blocked", {
        kind: "rejection",
        provenance: "host",
        retryable: false,
      }),
    );
    await expect(attempt(drafts, fake, saved)).rejects.toThrow();
    expect(saved.records.size).toBe(0);
    await attempt(drafts, fake, saved);
    const [refused, made] = fake.createThread.mock.calls.map(([input]) => input.idempotencyKey);
    expect(made).not.toBe(refused);
  });
});
