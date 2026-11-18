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

let keys = 0;
function attempt(
  drafts: ReturnType<typeof createComposerDraftStore>,
  fake: ReturnType<typeof host>,
  enqueue = async (threadId: string, key: string) => void fake.queued.push({ threadId, key }),
) {
  return startTask({
    records: draftTaskStart(drafts, draftKey),
    creation,
    creationKey: () => `thread-key-${++keys}`,
    messageKey: `message-key-${++keys}`,
    createThread: fake.createThread,
    queued: (key) => fake.queued.some((entry) => entry.key === key),
    enqueue,
  });
}

const lost = () =>
  new ClientOperationError("The answer was lost.", "transient", {
    kind: "transport",
    provenance: "transport",
    retryable: true,
  });

describe("starting a new task from a draft", () => {
  it("makes one task when the creation's answer is lost and Start is pressed again after a reload", async () => {
    const storage = memoryStorage();
    const fake = host();
    const first = createComposerDraftStore(() => storage);
    first.update(draftKey, { text: "Compare quotes" });
    const made = fake.createThread.getMockImplementation()!;
    fake.createThread.mockImplementationOnce(async (input) => {
      await made(input);
      throw lost();
    });
    await expect(attempt(first, fake)).rejects.toThrow();

    // A reload reads the same draft from storage.
    const reloaded = createComposerDraftStore(() => storage);
    const thread = await attempt(reloaded, fake);
    expect(fake.tasks.size).toBe(1);
    expect(thread.id).toBe("thr_1");
    expect(fake.queued).toEqual([{ threadId: "thr_1", key: expect.any(String) }]);
    expect(reloaded.read(draftKey)?.start).toBeUndefined();
  });

  it("queues the first message on retry without making the task again when this device couldn't save it", async () => {
    const fake = host();
    const storage = memoryStorage();
    const drafts = createComposerDraftStore(() => storage);
    drafts.update(draftKey, { text: "Compare quotes" });
    await expect(
      attempt(drafts, fake, async () => {
        throw new Error("Storage refused.");
      }),
    ).rejects.toThrow();
    const held = drafts.read(draftKey)!.start!;
    expect(held.threadId).toBe("thr_1");

    await attempt(drafts, fake);
    expect(fake.createThread).toHaveBeenCalledOnce();
    expect(fake.queued).toEqual([{ threadId: "thr_1", key: held.messageKey }]);
  });

  it("starts afresh after the Host refused the creation, so a changed choice is not refused again", async () => {
    const fake = host();
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
    await expect(attempt(drafts, fake)).rejects.toThrow();
    expect(drafts.read(draftKey)?.start).toBeUndefined();
    await attempt(drafts, fake);
    const [refused, made] = fake.createThread.mock.calls.map(([input]) => input.idempotencyKey);
    expect(made).not.toBe(refused);
  });
});
