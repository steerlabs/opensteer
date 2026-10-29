import { MemoryPrivateFilesystem } from "../packages/client/src/test-support/memory-private-filesystem.js";
import { describe, expect, it } from "vitest";
import { createThreadDraftStore } from "../apps/mobile/src/client/thread-drafts.js";

const userId = "usr_0192f4a1-aaaa-4000-8000-00000000000a";
const otherUserId = "usr_0192f4a1-bbbb-4000-8000-00000000000b";

describe("mobile draft durability across restart", () => {
  it("can reopen all drafts accepted by its public write API", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    const options = {
      filePath: "/private/drafts-v3.json",
      now: () => new Date("2026-09-15T12:00:00Z"),
      privateFiles,
    };
    const store = createThreadDraftStore(options);
    await store.load();
    for (let index = 0; index < 24; index += 1) {
      await store.writeDraft("deployment", userId, `thread-${index}`, "한".repeat(16_000));
    }
    const restarted = createThreadDraftStore(options);
    await expect(restarted.load()).resolves.toBeUndefined();
    expect(restarted.readDraft("deployment", userId, "thread-23")?.text).toBe("한".repeat(16_000));
  });

  it("retains unacknowledged commands when more threads have pending sends", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    const options = {
      filePath: "/private/drafts-v3.json",
      now: () => new Date("2026-09-15T12:00:00Z"),
      privateFiles,
    };
    const store = createThreadDraftStore(options);
    await store.load();
    for (let index = 0; index < 48; index += 1) {
      await store.claimPending("deployment", userId, `thread-${index}`, {
        idempotencyKey: `message-${index}`,
        text: `Unacknowledged message ${index}`,
        threadId: `thread-${index}`,
      });
    }
    await expect(
      store.claimPending("deployment", userId, "thread-48", {
        idempotencyKey: "message-48",
        text: "Newest message",
        threadId: "thread-48",
      }),
    ).rejects.toThrow(/awaiting acknowledgement/u);
    const restarted = createThreadDraftStore(options);
    await restarted.load();
    expect(restarted.readPending("deployment", userId, "thread-0")?.idempotencyKey).toBe(
      "message-0",
    );
  });

  it("never exposes or replays one user's pending command for another user", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    const options = {
      filePath: "/private/drafts-v3.json",
      now: () => new Date("2026-09-15T12:00:00Z"),
      privateFiles,
    };
    const store = createThreadDraftStore(options);
    await store.load();
    await store.claimPending("deployment", userId, "thread", {
      idempotencyKey: "message:private",
      text: "Private pending message",
      threadId: "thread",
    });

    const restarted = createThreadDraftStore(options);
    await restarted.load();
    expect(restarted.readPending("deployment", otherUserId, "thread")).toBeNull();
    expect(restarted.readPending("deployment", userId, "thread")?.idempotencyKey).toBe(
      "message:private",
    );
  });

  it("reopens full draft and pending collections even when every character needs JSON escaping", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    const options = {
      filePath: "/private/drafts-v3.json",
      now: () => new Date("2026-09-15T12:00:00Z"),
      privateFiles,
    };
    const store = createThreadDraftStore(options);
    await store.load();
    const text = "\u0000".repeat(16_000);
    for (let index = 0; index < 48; index += 1) {
      await store.claimPending("deployment", userId, `thread-${index}`, {
        idempotencyKey: `message-${index}`,
        text,
        threadId: `thread-${index}`,
      });
      await store.writeDraft("deployment", userId, `thread-${index}`, text);
    }
    const restarted = createThreadDraftStore(options);
    await restarted.load();
    for (let index = 0; index < 48; index += 1) {
      expect(restarted.readPending("deployment", userId, `thread-${index}`)).toMatchObject({
        idempotencyKey: `message-${index}`,
        text,
      });
      expect(restarted.readDraft("deployment", userId, `thread-${index}`)?.text).toBe(text);
    }
  });
});
