import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { describe, expect, it, vi } from "vitest";
import { ClientOperationError } from "@opensteer/client/connections";
import { ModelSelectionSchema } from "@opensteer/core";
import { createComposerDraftStore, type DraftStorage } from "../composer-drafts.js";
import { draftTaskStart, startTask } from "./task-start.js";

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
  enqueue = async (threadId: string, key: string) => {
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
    assertCurrent: () => {},
    createThread: fake.createThread,
    enqueue: (command) => enqueue(command.threadId, command.idempotencyKey),
  });
}

const lost = () =>
  new ClientOperationError("The answer was lost.", "transient", {
    kind: "transport",
    provenance: "transport",
    retryable: true,
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
