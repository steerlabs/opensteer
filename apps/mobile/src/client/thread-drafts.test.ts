import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { BrowserPageContentPartSchema, ModelSelectionSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { createThreadDraftStore, newTaskDraftKey, sameDraftSummary } from "./thread-drafts.js";

const filePath = "/private/drafts.json";
const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const userId = "usr_0192f4a1-aaaa-4000-8000-00000000000a";
const otherUserId = "usr_0192f4a1-bbbb-4000-8000-00000000000b";
const threadId = "thr_0192f4a1-2222-4000-8000-000000000002";
const otherThreadId = "thr_0192f4a1-3333-4000-8000-000000000003";
/** Words holding an inline reference: drafts and sends keep its Markdown byte for byte. */
const referenced = `Compare with [Fix \\[login\\] 🦊](opensteer:${otherThreadId}) first`;
const page = BrowserPageContentPartSchema.parse({
  sessionId: "bsn_0192f4a1-6666-4000-8000-000000000006",
  tabId: "tab-1",
  title: "Flights to Tokyo",
  type: "browser-page",
  url: "https://example.com/flights",
});

/** A device that can be made to refuse writes, the way a full one does. */
class FlakyFilesystem extends MemoryPrivateFilesystem {
  failWrites = false;

  override async writeFileAtomic(path: string, content: Uint8Array | string): Promise<void> {
    if (this.failWrites) throw new Error("This device has no space left.");
    await super.writeFileAtomic(path, content);
  }
}

function open(privateFiles: MemoryPrivateFilesystem = new FlakyFilesystem()) {
  return {
    drafts: createThreadDraftStore({
      filePath,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      privateFiles,
      saveRetryDelaysMs: [0],
    }),
    privateFiles,
  };
}

describe("createThreadDraftStore", () => {
  it("shows the latest edit to a remounted composer while disk writes are waiting", async () => {
    const ready = Promise.withResolvers<void>();
    class DelayedFilesystem extends MemoryPrivateFilesystem {
      override async writeFileAtomic(path: string, content: Uint8Array | string): Promise<void> {
        await ready.promise;
        await super.writeFileAtomic(path, content);
      }
    }
    const { drafts, privateFiles } = open(new DelayedFilesystem());
    await drafts.load();
    const first = drafts.writeDraft(deploymentId, userId, threadId, "first edit");
    const second = drafts.writeDraft(deploymentId, userId, threadId, referenced);
    expect(drafts.readDraft(deploymentId, userId, threadId)?.text).toBe(referenced);
    ready.resolve();
    await Promise.all([first, second]);
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readDraft(deploymentId, userId, threadId)?.text).toBe(referenced);
  });

  it("keeps the queued message when the draft has its own quote and page", async () => {
    const { drafts } = open();
    const scope = { authorityKey: "host", deploymentId, viewerId: userId, loginId: "login" };
    const firstQuote = "msg_0192f4a1-1111-4000-8000-000000000001";
    const draftQuote = "msg_0192f4a1-2222-4000-8000-000000000002";
    await drafts.writeDraft(deploymentId, userId, threadId, "current draft");
    await drafts.writeDraftQuote(deploymentId, userId, threadId, {
      messageId: draftQuote,
      attribution: "Current",
      excerpt: "Current",
    });
    await drafts.writeDraftPage(deploymentId, userId, threadId, page);
    const restore = (quotedMessageId: string, tabId: string) =>
      drafts.restoreMessage(scope, {
        localId: "waiting",
        createdAt: new Date().toISOString(),
        order: 1,
        phase: "waiting",
        attempted: false,
        command: {
          type: "thread.sendMessage",
          delivery: "queue",
          idempotencyKey: "waiting",
          threadId,
          quotedMessageId,
          content: [
            { type: "text", text: "queued" },
            { ...page, tabId },
          ],
        },
      });
    await expect(restore(firstQuote, page.tabId)).resolves.toBe("occupied");
    await expect(restore(draftQuote, "another-tab")).resolves.toBe("occupied");
    expect(drafts.readDraft(deploymentId, userId, threadId)).toMatchObject({
      text: "current draft",
      quote: { messageId: draftQuote },
      page,
    });
  });

  it("never exposes one signed-in user's draft or pending work to another", async () => {
    const { drafts } = open();
    await drafts.load();
    await drafts.writeDraft(deploymentId, userId, otherThreadId, "private draft");
    await drafts.writeDraftPage(deploymentId, userId, otherThreadId, page);
    await drafts.claimTaskStart(deploymentId, userId, threadId, {
      idempotencyKey: "message:private",
      text: "private message",
      threadId,
    });

    expect(drafts.readDraft(deploymentId, otherUserId, otherThreadId)).toBeNull();
    expect(drafts.readTaskStart(deploymentId, otherUserId, threadId)).toBeNull();
  });

  it("keeps the page Ask put on a draft through edits and a restart, until it is removed or sent", async () => {
    const { drafts, privateFiles } = open();
    await drafts.load();
    const written = drafts.writeDraftPage(deploymentId, userId, threadId, page);
    expect(drafts.readDraft(deploymentId, userId, threadId)?.page).toEqual(page);
    await written;
    await drafts.writeDraft(deploymentId, userId, threadId, "Which is cheapest?");
    await drafts.writeDraftQuote(deploymentId, userId, threadId, null);
    await drafts.writeDraftAttachments(deploymentId, userId, threadId, []);

    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readDraft(deploymentId, userId, threadId)).toMatchObject({
      page,
      text: "Which is cheapest?",
    });
    // The words go; a page alone is still a draft.
    await relaunched.writeDraft(deploymentId, userId, threadId, "");
    expect(relaunched.readDraft(deploymentId, userId, threadId)?.page).toEqual(page);
    await relaunched.writeDraftPage(deploymentId, userId, threadId, null);
    expect(relaunched.readDraft(deploymentId, userId, threadId)).toBeNull();

    await relaunched.writeDraftPage(deploymentId, userId, threadId, page);
    await relaunched.claimTaskStart(deploymentId, userId, threadId, {
      browserPage: page,
      idempotencyKey: "message:page",
      text: "Which is cheapest?",
      threadId,
    });
    expect(relaunched.readDraft(deploymentId, userId, threadId)).toBeNull();
    expect(relaunched.readTaskStart(deploymentId, userId, threadId)?.browserPage).toEqual(page);
  });

  it("brings back the exact command a killed app was sending, key and all", async () => {
    const { drafts, privateFiles } = open();
    await drafts.load();
    await drafts.claimTaskStart(deploymentId, userId, threadId, {
      idempotencyKey: "message:abc",
      text: referenced,
      threadId,
    });

    const relaunched = open(privateFiles).drafts;
    await relaunched.load();

    expect(relaunched.readTaskStart(deploymentId, userId, threadId)).toEqual({
      createdAt: "2026-09-14T12:00:00.000Z",
      delivery: "queue",
      idempotencyKey: "message:abc",
      text: referenced,
      threadId,
      userId,
    });
  });

  it("replays the canonical quote target and rejects a changed quote under the same key", async () => {
    const { drafts, privateFiles } = open();
    await drafts.load();
    const command = {
      idempotencyKey: "message:quoted",
      quotedMessageId: "msg_0192f4a1-4444-4000-8000-000000000004",
      text: "Answer this update",
      threadId,
    };
    await drafts.claimTaskStart(deploymentId, userId, threadId, command);

    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readTaskStart(deploymentId, userId, threadId)).toMatchObject(command);
    await expect(relaunched.claimTaskStart(deploymentId, userId, threadId, command)).resolves.toBe(
      undefined,
    );
    await expect(
      relaunched.claimTaskStart(deploymentId, userId, threadId, {
        ...command,
        quotedMessageId: "msg_0192f4a1-5555-4000-8000-000000000005",
      }),
    ).rejects.toThrow(/awaiting acknowledgement/u);
    expect(relaunched.readTaskStart(deploymentId, userId, threadId)).toMatchObject(command);
  });

  it("replays attachment order with the original send after a restart and rejects a changed retry", async () => {
    const { drafts, privateFiles } = open();
    await drafts.load();
    const first = {
      type: "artifact" as const,
      artifactId: "att-first",
      name: "first.png",
      mediaType: "image/png",
      sizeBytes: 12,
    };
    const second = {
      type: "artifact" as const,
      artifactId: "att-second",
      name: "second.txt",
      mediaType: "text/plain",
      sizeBytes: 8,
    };
    const command = {
      attachments: [first, second],
      idempotencyKey: "message:with-files",
      localUris: ["file:///private/drafts/photo.draft", null],
      text: "compare these",
      threadId,
    };
    await drafts.claimTaskStart(deploymentId, userId, threadId, command);
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readTaskStart(deploymentId, userId, threadId)).toMatchObject(command);
    await expect(
      relaunched.claimTaskStart(deploymentId, userId, threadId, {
        ...command,
        attachments: [second, first],
      }),
    ).rejects.toThrow(/awaiting acknowledgement/);
    expect(relaunched.readTaskStart(deploymentId, userId, threadId)).toMatchObject(command);
  });

  it("does not expose unattributed version two state to either signed-in user", async () => {
    const privateFiles = new FlakyFilesystem();
    privateFiles.put(
      filePath,
      JSON.stringify({
        drafts: {
          [`${deploymentId}:${threadId}`]: {
            text: "from the previous release",
            updatedAt: "2026-09-14T12:00:00.000Z",
          },
        },
        pending: {
          [`${deploymentId}:${threadId}`]: {
            createdAt: "2026-09-14T11:00:00.000Z",
            idempotencyKey: "message:legacy",
            text: "unacknowledged legacy message",
            threadId,
          },
        },
        schemaVersion: 2,
      }),
    );
    const { drafts } = open(privateFiles);
    await drafts.load();

    expect(drafts.readDraft(deploymentId, userId, threadId)).toBeNull();
    expect(drafts.readTaskStart(deploymentId, userId, threadId)).toBeNull();
    expect(drafts.readDraft(deploymentId, otherUserId, threadId)).toBeNull();
    expect(drafts.readTaskStart(deploymentId, otherUserId, threadId)).toBeNull();
  });

  it("clears the draft when the command that carries it is claimed", async () => {
    const { drafts } = open();
    await drafts.load();
    await drafts.writeDraft(deploymentId, userId, threadId, "send me");
    await drafts.claimTaskStart(deploymentId, userId, threadId, {
      idempotencyKey: "message:abc",
      text: "send me",
      threadId,
    });

    expect(drafts.readDraft(deploymentId, userId, threadId)).toBeNull();
  });

  it("keeps typing out of the command in flight", async () => {
    const { drafts } = open();
    await drafts.load();
    await drafts.claimTaskStart(deploymentId, userId, threadId, {
      idempotencyKey: "message:abc",
      text: "send me",
      threadId,
    });
    await drafts.writeDraft(deploymentId, userId, threadId, "and another thing");

    expect(drafts.readTaskStart(deploymentId, userId, threadId)?.text).toBe("send me");
    expect(drafts.readDraft(deploymentId, userId, threadId)?.text).toBe("and another thing");
  });

  it("refuses a claim it could not write, so no key is used that the disk never saw", async () => {
    const privateFiles = new FlakyFilesystem();
    const { drafts } = open(privateFiles);
    await drafts.load();
    await drafts.writeDraft(deploymentId, userId, threadId, "send me");
    privateFiles.failWrites = true;

    await expect(
      drafts.claimTaskStart(deploymentId, userId, threadId, {
        idempotencyKey: "message:abc",
        text: "send me",
        threadId,
      }),
    ).rejects.toThrow(/no space/u);

    // Nothing was claimed, and the draft the person typed is still theirs.
    expect(drafts.readTaskStart(deploymentId, userId, threadId)).toBeNull();
    expect(drafts.readDraft(deploymentId, userId, threadId)?.text).toBe("send me");
  });

  it("retains an unacknowledged command when clearing it cannot reach disk", async () => {
    const privateFiles = new FlakyFilesystem();
    const { drafts } = open(privateFiles);
    await drafts.load();
    await drafts.claimTaskStart(deploymentId, userId, threadId, {
      idempotencyKey: "message:original",
      text: "keep me",
      threadId,
    });
    privateFiles.failWrites = true;
    await expect(drafts.clearTaskStart(deploymentId, userId, threadId)).rejects.toThrow(
      /no space/u,
    );
    expect(drafts.readTaskStart(deploymentId, userId, threadId)?.idempotencyKey).toBe(
      "message:original",
    );
    privateFiles.failWrites = false;
    await drafts.writeDraft(deploymentId, userId, otherThreadId, "later edit");
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readTaskStart(deploymentId, userId, threadId)?.idempotencyKey).toBe(
      "message:original",
    );
  });

  it("serializes competing claims without replacing an unacknowledged key", async () => {
    const { drafts, privateFiles } = open();
    await drafts.load();
    const results = await Promise.allSettled([
      drafts.claimTaskStart(deploymentId, userId, threadId, {
        idempotencyKey: "message:first",
        text: "first",
        threadId,
      }),
      drafts.claimTaskStart(deploymentId, userId, threadId, {
        idempotencyKey: "message:second",
        text: "second",
        threadId,
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readTaskStart(deploymentId, userId, threadId)?.idempotencyKey).toBe(
      "message:first",
    );
  });

  it("retries a failed draft save, then says it is unsaved and keeps the words until one lands", async () => {
    let refusals = 1;
    class RefusingFilesystem extends MemoryPrivateFilesystem {
      override async writeFileAtomic(path: string, content: Uint8Array | string): Promise<void> {
        if (refusals > 0) {
          refusals -= 1;
          throw new Error("This device has no space left.");
        }
        await super.writeFileAtomic(path, content);
      }
    }
    const { drafts, privateFiles } = open(new RefusingFilesystem());
    await drafts.load();

    // One refusal: the retry saves it, so a relaunch finds the words.
    await drafts.writeDraft(deploymentId, userId, threadId, "first words");
    expect(drafts.readDraftUnsaved(deploymentId, userId, threadId)).toBe(false);
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readDraft(deploymentId, userId, threadId)?.text).toBe("first words");

    // Every attempt refused: the words stay on screen and the store says so.
    refusals = Number.POSITIVE_INFINITY;
    await expect(drafts.writeDraft(deploymentId, userId, threadId, "newer words")).rejects.toThrow(
      /no space/u,
    );
    expect(drafts.readDraft(deploymentId, userId, threadId)?.text).toBe("newer words");
    expect(drafts.readDraftUnsaved(deploymentId, userId, threadId)).toBe(true);
    // A later edit still pending keeps saying so instead of flickering clear.
    const later = drafts.writeDraft(deploymentId, userId, threadId, "newest words");
    expect(drafts.readDraftUnsaved(deploymentId, userId, threadId)).toBe(true);
    refusals = 0;
    await later;
    expect(drafts.readDraftUnsaved(deploymentId, userId, threadId)).toBe(false);
    const again = open(privateFiles).drafts;
    await again.load();
    expect(again.readDraft(deploymentId, userId, threadId)?.text).toBe("newest words");
  });

  it("recovers the write queue after a failure instead of rejecting everything after it", async () => {
    const privateFiles = new FlakyFilesystem();
    const { drafts } = open(privateFiles);
    await drafts.load();
    privateFiles.failWrites = true;

    await expect(drafts.writeDraft(deploymentId, userId, threadId, "one")).rejects.toThrow(
      /no space/u,
    );

    privateFiles.failWrites = false;
    await drafts.writeDraft(deploymentId, userId, threadId, "two");

    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readDraft(deploymentId, userId, threadId)?.text).toBe("two");
  });

  it("never hands one Thread's command to another", async () => {
    const { drafts, privateFiles } = open();
    await drafts.load();
    await drafts.claimTaskStart(deploymentId, userId, threadId, {
      idempotencyKey: "message:abc",
      text: "send me",
      threadId,
    });

    expect(drafts.readTaskStart(deploymentId, userId, otherThreadId)).toBeNull();
    expect(
      drafts.readTaskStart("dep_0192f4a1-9999-4000-8000-000000000009", userId, threadId),
    ).toBeNull();

    // A file that files a command under the wrong Thread is not this Thread's
    // message, whatever it says.
    privateFiles.put(
      filePath,
      JSON.stringify({
        drafts: {},
        pending: {
          [`${deploymentId}:${threadId}`]: {
            createdAt: "2026-09-14T12:00:00.000Z",
            idempotencyKey: "message:abc",
            text: "send me",
            threadId: otherThreadId,
          },
        },
        schemaVersion: 2,
      }),
    );
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readTaskStart(deploymentId, userId, threadId)).toBeNull();
  });

  it("never loses a draft to a newer one", async () => {
    const { drafts } = open();
    await drafts.load();
    for (let index = 0; index < 60; index += 1) {
      await drafts.writeDraft(deploymentId, userId, `thread-${index}`, `draft ${index}`);
    }
    expect(drafts.readDraft(deploymentId, userId, "thread-0")?.text).toBe("draft 0");
    expect(drafts.readDraft(deploymentId, userId, "thread-59")?.text).toBe("draft 59");
  });

  it("refuses out loud once the file is full, keeping every draft already saved", async () => {
    // Escaping doubles a quote on disk, so these leave less room than one more.
    const full = '"'.repeat(16_000);
    const saved = Object.fromEntries(
      Array.from({ length: 325 }, (_, index) => [
        `${deploymentId}:${userId}:thread-${index}`,
        { text: full, updatedAt: "2026-09-14T12:00:00.000Z", userId },
      ]),
    );
    const privateFiles = new MemoryPrivateFilesystem();
    await privateFiles.writeFileAtomic(
      filePath,
      JSON.stringify({ drafts: saved, pending: {}, schemaVersion: 4 }),
    );
    const { drafts } = open(privateFiles);
    await drafts.load();

    await expect(drafts.writeDraft(deploymentId, userId, "one-more", full)).rejects.toThrow(
      "storage limit",
    );
    // The words stay in the composer that could not save them.
    expect(drafts.readDraft(deploymentId, userId, "one-more")?.text).toBe(full);
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readDraft(deploymentId, userId, "thread-0")?.text).toBe(full);
    expect(relaunched.readDraft(deploymentId, userId, "one-more")).toBeNull();
  });

  it("bounds one draft rather than refusing to store it", async () => {
    const { drafts } = open();
    await drafts.load();
    await drafts.writeDraft(deploymentId, userId, threadId, "x".repeat(20_000));

    expect(drafts.readDraft(deploymentId, userId, threadId)?.text).toHaveLength(16_000);
  });

  it("loses drafts rather than the app when the file cannot be read", async () => {
    const { privateFiles } = open();
    privateFiles.put(filePath, "{not json");
    const drafts = open(privateFiles).drafts;
    await drafts.load();

    expect(drafts.readDraft(deploymentId, userId, threadId)).toBeNull();
    await drafts.writeDraft(deploymentId, userId, threadId, "fresh");
    expect(drafts.readDraft(deploymentId, userId, threadId)?.text).toBe("fresh");
  });
});

/**
 * The previous release (schema 3) could hold a steering decision: an answer to
 * an approval and the message that followed it, saved before either was sent.
 * The message's key was only ever handed to the Host after the decision had
 * been answered and the message claimed, so a held record's message key is
 * one the Host has never seen. Typing no longer answers an approval.
 */
describe("new-task drafts", () => {
  const first = "0192f4a1-7777-4000-8000-000000000007";
  const second = "0192f4a1-8888-4000-8000-000000000008";
  const start = {
    accessMode: "full-access",
    environmentId: "env-1",
    harnessInstanceId: "harness-1",
    idempotencyKey: "thread:saved",
    modelSelection: ModelSelectionSchema.parse({
      modelId: "model-1",
      options: {},
      providerId: "provider-1",
    }),
    title: "Saved task",
  } as const;
  const summary = (store: ReturnType<typeof open>["drafts"]) =>
    store.readDraftSummary(deploymentId, userId);

  it("restores Home and drops unreachable new-task drafts and pending files", async () => {
    const { drafts, privateFiles } = open();
    await drafts.load();
    await drafts.writeDraft(deploymentId, userId, newTaskDraftKey("home"), "Home words");
    await drafts.writeDraft(deploymentId, userId, newTaskDraftKey(first), "Obsolete");
    await drafts.writeDraftAttachments(deploymentId, userId, newTaskDraftKey(first), [
      {
        attachmentId: null,
        localUri: "file:///draft-old",
        mediaType: "image/png",
        name: "old.png",
        sizeBytes: 3,
        status: "staged",
      },
    ]);
    await drafts.claimTaskStart(deploymentId, userId, newTaskDraftKey(second), {
      idempotencyKey: "pending-old",
      text: "Obsolete pending",
      threadId: newTaskDraftKey(second),
      localUris: ["file:///pending-old"],
      attachments: [
        { type: "artifact", artifactId: "art_old", mediaType: "image/png", name: "old.png" },
      ],
      start,
    });
    await drafts.claimTaskStart(deploymentId, userId, newTaskDraftKey("home"), {
      idempotencyKey: "pending-home",
      text: "Held home",
      threadId: newTaskDraftKey("home"),
      start,
    });
    await drafts.writeDraft(deploymentId, userId, newTaskDraftKey("home"), "Home words");
    await drafts.writeDraft(deploymentId, userId, threadId, "Task reply");
    const forgetDraftFiles = vi.fn();
    const relaunched = createThreadDraftStore({
      filePath,
      now: () => new Date(),
      privateFiles,
      forgetDraftFiles,
    });
    await relaunched.load();
    expect(relaunched.readDraft(deploymentId, userId, newTaskDraftKey("home"))?.text).toBe(
      "Home words",
    );
    expect(
      relaunched.readTaskStart(deploymentId, userId, newTaskDraftKey("home"))?.idempotencyKey,
    ).toBe("pending-home");
    expect(relaunched.readDraft(deploymentId, userId, newTaskDraftKey(first))).toBeNull();
    expect(relaunched.readTaskStart(deploymentId, userId, newTaskDraftKey(second))).toBeNull();
    expect(relaunched.readDraft(deploymentId, userId, threadId)?.text).toBe("Task reply");
    expect(forgetDraftFiles.mock.calls).toEqual([
      [{ deploymentId, userId, kind: "new-task", draftId: first }, ["file:///draft-old"]],
      [{ deploymentId, userId, kind: "new-task", draftId: second }, ["file:///pending-old"]],
    ]);
    expect(
      new TextDecoder().decode((await privateFiles.readFile(filePath, 10 * 1024 * 1024))!),
    ).not.toContain(`new-task:${first}`);
    expect(
      new TextDecoder().decode((await privateFiles.readFile(filePath, 10 * 1024 * 1024))!),
    ).not.toContain(`new-task:${second}`);
  });

  it("forgets a discarded draft for good, and only that draft", async () => {
    const files = new FlakyFilesystem();
    const { drafts } = open(files);
    await drafts.load();
    const key = newTaskDraftKey(first);
    await drafts.writeDraft(deploymentId, userId, key, "Saved");
    await drafts.writeDraft(deploymentId, userId, newTaskDraftKey(second), "Kept");
    files.failWrites = true;
    await drafts.writeDraft(deploymentId, userId, key, "Never saved").catch(() => undefined);
    await expect(drafts.discardDraft(deploymentId, userId, key)).rejects.toThrow();
    expect(drafts.readDraft(deploymentId, userId, key)?.text).toBe("Never saved");
    files.failWrites = false;

    await drafts.discardDraft(deploymentId, userId, key);
    expect(drafts.readDraft(deploymentId, userId, key)).toBeNull();
    expect(drafts.readDraft(deploymentId, userId, newTaskDraftKey(second))?.text).toBe("Kept");
  });

  it("leaves a message in flight alone when its draft is discarded", async () => {
    const { drafts } = open();
    await drafts.load();
    const key = newTaskDraftKey(first);
    await drafts.claimTaskStart(deploymentId, userId, key, {
      idempotencyKey: "message:held",
      start,
      text: "Held",
      threadId: key,
    });
    await drafts.writeDraft(deploymentId, userId, key, "Typed after");
    await drafts.discardDraft(deploymentId, userId, key);
    expect(drafts.readTaskStart(deploymentId, userId, key)?.idempotencyKey).toBe("message:held");
  });

  it("shows the sidebar nothing new for a keystroke or another reader", async () => {
    const { drafts } = open();
    await drafts.load();
    const key = newTaskDraftKey(first);
    await drafts.writeDraft(deploymentId, userId, threadId, "An unsent reply");
    await drafts.writeDraft(deploymentId, userId, key, "A new task");
    await drafts.writeDraft(deploymentId, otherUserId, otherThreadId, "Theirs");
    await drafts.writeDraft("dep_other", userId, newTaskDraftKey(second), "Elsewhere");
    const before = summary(drafts);
    expect([...before.threadIds]).toEqual([threadId]);

    await drafts.writeDraft(deploymentId, userId, threadId, "An unsent reply, longer");
    await drafts.writeDraft(deploymentId, userId, key, "A new task\nwith a second line");
    expect(sameDraftSummary(before, summary(drafts))).toBe(true);

    await drafts.writeDraft(deploymentId, userId, key, "A new task, retitled");
    expect(sameDraftSummary(before, summary(drafts))).toBe(true);
    await drafts.writeDraft(deploymentId, userId, threadId, "");
    expect(summary(drafts).threadIds.size).toBe(0);
  });
});

describe("a draft file from the release that steered approvals", () => {
  const entryKey = `${deploymentId}:${userId}:${threadId}`;
  const requestId = "req_0192f4a1-4444-4000-8000-000000000004";
  const heldSteer = {
    createdAt: "2026-09-14T11:00:00.000Z",
    draftText: "  do this instead  ",
    idempotencyKey: "request:original",
    messageIdempotencyKey: "message:original",
    optionId: "reject",
    requestId,
    text: "do this instead",
    threadId,
    userId,
  };

  function previousRelease(file: {
    readonly drafts?: Record<string, unknown>;
    readonly pending?: Record<string, unknown>;
    readonly pendingSteers?: Record<string, unknown>;
  }): MemoryPrivateFilesystem {
    const privateFiles = new FlakyFilesystem();
    privateFiles.put(
      filePath,
      JSON.stringify({
        drafts: file.drafts ?? {},
        pending: file.pending ?? {},
        pendingSteers: file.pendingSteers ?? {},
        schemaVersion: 3,
      }),
    );
    return privateFiles;
  }

  it("decodes a held message for review under its original key", async () => {
    const privateFiles = previousRelease({
      drafts: {
        [entryKey]: { text: heldSteer.draftText, updatedAt: heldSteer.createdAt, userId },
      },
      pendingSteers: { [entryKey]: heldSteer },
    });
    const { drafts } = open(privateFiles);
    await drafts.load();

    const pending = drafts.readTaskStart(deploymentId, userId, threadId);
    expect(pending).toEqual({
      createdAt: heldSteer.createdAt,
      delivery: "queue",
      idempotencyKey: heldSteer.messageIdempotencyKey,
      text: heldSteer.text,
      threadId,
      userId,
    });
    // The words are the message now; showing them in the field too would
    // invite sending them twice.
    expect(drafts.readDraft(deploymentId, userId, threadId)).toBeNull();

    if (pending === null) throw new Error("The held message was not carried over.");
    const recovered = await drafts.legacyMessages.load({
      authorityKey: "old-host",
      deploymentId,
      viewerId: userId,
      loginId: "reviewing-login",
    });
    expect(recovered.map((entry) => entry.command)).toEqual([
      {
        content: [{ text: heldSteer.text, type: "text" }],
        delivery: "queue",
        idempotencyKey: heldSteer.messageIdempotencyKey,
        threadId,
        type: "thread.sendMessage",
      },
    ]);
  });

  it("never keeps the approval decision, on disk or anywhere it could be replayed", async () => {
    const privateFiles = previousRelease({ pendingSteers: { [entryKey]: heldSteer } });
    const { drafts } = open(privateFiles);
    await drafts.load();
    // Any write saves the file in the current form.
    await drafts.writeDraft(deploymentId, userId, otherThreadId, "elsewhere");

    const saved = privateFiles.text(filePath) ?? "";
    expect(JSON.parse(saved)).toMatchObject({ schemaVersion: 4 });
    expect(saved).not.toContain("pendingSteers");
    expect(saved).not.toContain(heldSteer.idempotencyKey);
    expect(saved).not.toContain(requestId);
    expect(saved).not.toContain(heldSteer.optionId);
    expect(drafts).not.toHaveProperty("readTaskStartSteer");
    expect(drafts).not.toHaveProperty("claimTaskStartSteer");

    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readTaskStart(deploymentId, userId, threadId)?.idempotencyKey).toBe(
      heldSteer.messageIdempotencyKey,
    );
  });

  it("brings the same message back if the app is closed before the upgrade is saved", async () => {
    const privateFiles = previousRelease({ pendingSteers: { [entryKey]: heldSteer } });
    const first = open(privateFiles).drafts;
    await first.load();
    const second = open(privateFiles).drafts;
    await second.load();

    expect(second.readTaskStart(deploymentId, userId, threadId)).toEqual(
      first.readTaskStart(deploymentId, userId, threadId),
    );
  });

  it("keeps words typed after the held message in the draft", async () => {
    const privateFiles = previousRelease({
      drafts: { [entryKey]: { text: "newer draft", updatedAt: heldSteer.createdAt, userId } },
      pendingSteers: { [entryKey]: heldSteer },
    });
    const { drafts } = open(privateFiles);
    await drafts.load();

    expect(drafts.readTaskStart(deploymentId, userId, threadId)?.text).toBe(heldSteer.text);
    expect(drafts.readDraft(deploymentId, userId, threadId)?.text).toBe("newer draft");
  });

  it("leaves held words with the files and quote saved beside them, for the person to send", async () => {
    const quote = { attribution: "Opensteer", excerpt: "Earlier", messageId: "msg-quoted" };
    const attachments = [
      {
        attachmentId: "att-ready",
        localUri: null,
        mediaType: "text/plain",
        name: "notes.txt",
        sizeBytes: 4,
        status: "ready",
      },
    ];
    const privateFiles = previousRelease({
      drafts: {
        [entryKey]: {
          attachments,
          quote,
          text: heldSteer.draftText,
          updatedAt: heldSteer.createdAt,
          userId,
        },
      },
      pendingSteers: { [entryKey]: heldSteer },
    });
    const { drafts } = open(privateFiles);
    await drafts.load();

    // Sent alone they would lose what they were meant to go with, so nothing
    // is owed and the draft stays as it was.
    expect(drafts.readTaskStart(deploymentId, userId, threadId)).toBeNull();
    expect(drafts.readDraft(deploymentId, userId, threadId)).toEqual({
      attachments,
      quote,
      text: heldSteer.draftText,
      updatedAt: heldSteer.createdAt,
      userId,
    });
    await drafts.writeDraft(deploymentId, userId, otherThreadId, "elsewhere");
    expect(privateFiles.text(filePath)).not.toContain(heldSteer.idempotencyKey);
    expect(privateFiles.text(filePath)).not.toContain(heldSteer.messageIdempotencyKey);
  });

  it("loses a file the previous release could not have written rather than the app", async () => {
    // Release 3 saved only words it was about to send: trimmed, never blank.
    const privateFiles = previousRelease({
      drafts: { [entryKey]: { text: "kept?", updatedAt: heldSteer.createdAt, userId } },
      pendingSteers: { [entryKey]: { ...heldSteer, draftText: "   ", text: "   " } },
    });
    const { drafts } = open(privateFiles);
    await expect(drafts.load()).resolves.toBeUndefined();

    expect(drafts.readTaskStart(deploymentId, userId, threadId)).toBeNull();
    expect(drafts.readDraft(deploymentId, userId, threadId)).toBeNull();
  });

  it("never hands one person's held message to another", async () => {
    const privateFiles = previousRelease({ pendingSteers: { [entryKey]: heldSteer } });
    const { drafts } = open(privateFiles);
    await drafts.load();

    expect(drafts.readTaskStart(deploymentId, otherUserId, threadId)).toBeNull();
    expect(drafts.readDraft(deploymentId, otherUserId, threadId)).toBeNull();
  });

  it("decodes a previous message with its exact content, quote and files", async () => {
    // As the previous release wrote it: each file in the order its schema
    // names the fields, which is also the order it dispatched them in.
    const owed = {
      attachments: [
        {
          type: "artifact",
          artifactId: "att-first",
          name: "first.png",
          mediaType: "image/png",
          sizeBytes: 12,
        },
        { type: "artifact", artifactId: "att-second", name: "second.txt", mediaType: "text/plain" },
      ],
      createdAt: "2026-09-14T10:00:00.000Z",
      idempotencyKey: "message:owed",
      localUris: ["file:///private/drafts/first.draft", null],
      quotedMessageId: "msg_0192f4a1-5555-4000-8000-000000000005",
      text: "compare these",
      threadId,
      userId,
    };
    const privateFiles = previousRelease({ pending: { [entryKey]: owed } });
    const { drafts } = open(privateFiles);
    await drafts.load();

    const pending = drafts.readTaskStart(deploymentId, userId, threadId);
    expect(pending).toEqual({ ...owed, delivery: "queue" });
    if (pending === null) throw new Error("The owed message was not loaded.");
    const recovered = await drafts.legacyMessages.load({
      authorityKey: "old-host",
      deploymentId,
      viewerId: userId,
      loginId: "reviewing-login",
    });
    expect(recovered[0]?.command).toEqual({
      content: [{ text: "compare these", type: "text" }, ...owed.attachments],
      delivery: "queue",
      idempotencyKey: "message:owed",
      quotedMessageId: owed.quotedMessageId,
      threadId,
      type: "thread.sendMessage",
    });
  });

  it("keeps a stored steering delivery unchanged for review", async () => {
    const owed = {
      createdAt: "2026-09-14T10:00:00.000Z",
      delivery: "steer",
      idempotencyKey: "message:steer",
      text: "change course",
      threadId,
      userId,
    };
    const privateFiles = previousRelease({ pending: { [entryKey]: owed } });
    const { drafts } = open(privateFiles);
    await drafts.load();

    const pending = drafts.readTaskStart(deploymentId, userId, threadId);
    expect(pending).toEqual(owed);
    if (pending === null) throw new Error("The owed message was not loaded.");
    const recovered = await drafts.legacyMessages.load({
      authorityKey: "old-host",
      deploymentId,
      viewerId: userId,
      loginId: "reviewing-login",
    });
    expect(recovered[0]?.command).toEqual({
      content: [{ text: "change course", type: "text" }],
      delivery: "steer",
      idempotencyKey: "message:steer",
      threadId,
      type: "thread.sendMessage",
    });
  });
});

it.each(["compactFirst", "keepFullHistory"] as const)(
  "preserves %s through a device restart and refuses changing it under the same key",
  async (compaction) => {
    const { drafts, privateFiles } = open();
    await drafts.load();
    const command = { text: "Continue", threadId, idempotencyKey: "compaction-choice", compaction };
    await drafts.claimTaskStart(deploymentId, userId, threadId, command);
    const restored = open(privateFiles).drafts;
    await restored.load();
    expect(restored.readTaskStart(deploymentId, userId, threadId)).toMatchObject(command);
    await expect(
      restored.claimTaskStart(deploymentId, userId, threadId, {
        ...command,
        compaction: compaction === "compactFirst" ? "keepFullHistory" : "compactFirst",
      }),
    ).rejects.toThrow(/awaiting acknowledgement/);
  },
);
