import type { HostClient } from "@opensteer/client/host";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { describe, expect, it, vi } from "vitest";
import { sendPendingMessage } from "../thread/send-pending-message.js";
import { createThreadDraftStore } from "./thread-drafts.js";

const filePath = "/private/drafts.json";
const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const userId = "usr_0192f4a1-aaaa-4000-8000-00000000000a";
const otherUserId = "usr_0192f4a1-bbbb-4000-8000-00000000000b";
const threadId = "thr_0192f4a1-2222-4000-8000-000000000002";
const otherThreadId = "thr_0192f4a1-3333-4000-8000-000000000003";

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
    const second = drafts.writeDraft(deploymentId, userId, threadId, "latest edit");
    expect(drafts.readDraft(deploymentId, userId, threadId)?.text).toBe("latest edit");
    ready.resolve();
    await Promise.all([first, second]);
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readDraft(deploymentId, userId, threadId)?.text).toBe("latest edit");
  });

  it("never exposes one signed-in user's draft or pending work to another", async () => {
    const { drafts } = open();
    await drafts.load();
    await drafts.writeDraft(deploymentId, userId, otherThreadId, "private draft");
    await drafts.claimPending(deploymentId, userId, threadId, {
      idempotencyKey: "message:private",
      text: "private message",
      threadId,
    });

    expect(drafts.readDraft(deploymentId, otherUserId, otherThreadId)).toBeNull();
    expect(drafts.readPending(deploymentId, otherUserId, threadId)).toBeNull();
  });

  it("brings back the exact command a killed app was sending, key and all", async () => {
    const { drafts, privateFiles } = open();
    await drafts.load();
    await drafts.claimPending(deploymentId, userId, threadId, {
      idempotencyKey: "message:abc",
      text: "send me",
      threadId,
    });

    const relaunched = open(privateFiles).drafts;
    await relaunched.load();

    expect(relaunched.readPending(deploymentId, userId, threadId)).toEqual({
      createdAt: "2026-09-14T12:00:00.000Z",
      delivery: "queue",
      idempotencyKey: "message:abc",
      text: "send me",
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
    await drafts.claimPending(deploymentId, userId, threadId, command);

    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readPending(deploymentId, userId, threadId)).toMatchObject(command);
    await expect(relaunched.claimPending(deploymentId, userId, threadId, command)).resolves.toBe(
      undefined,
    );
    await expect(
      relaunched.claimPending(deploymentId, userId, threadId, {
        ...command,
        quotedMessageId: "msg_0192f4a1-5555-4000-8000-000000000005",
      }),
    ).rejects.toThrow(/awaiting acknowledgement/u);
    expect(relaunched.readPending(deploymentId, userId, threadId)).toMatchObject(command);
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
    await drafts.claimPending(deploymentId, userId, threadId, command);
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readPending(deploymentId, userId, threadId)).toMatchObject(command);
    await expect(
      relaunched.claimPending(deploymentId, userId, threadId, {
        ...command,
        attachments: [second, first],
      }),
    ).rejects.toThrow(/awaiting acknowledgement/);
    expect(relaunched.readPending(deploymentId, userId, threadId)).toMatchObject(command);
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
    expect(drafts.readPending(deploymentId, userId, threadId)).toBeNull();
    expect(drafts.readDraft(deploymentId, otherUserId, threadId)).toBeNull();
    expect(drafts.readPending(deploymentId, otherUserId, threadId)).toBeNull();
  });

  it("clears the draft when the command that carries it is claimed", async () => {
    const { drafts } = open();
    await drafts.load();
    await drafts.writeDraft(deploymentId, userId, threadId, "send me");
    await drafts.claimPending(deploymentId, userId, threadId, {
      idempotencyKey: "message:abc",
      text: "send me",
      threadId,
    });

    expect(drafts.readDraft(deploymentId, userId, threadId)).toBeNull();
  });

  it("keeps typing out of the command in flight", async () => {
    const { drafts } = open();
    await drafts.load();
    await drafts.claimPending(deploymentId, userId, threadId, {
      idempotencyKey: "message:abc",
      text: "send me",
      threadId,
    });
    await drafts.writeDraft(deploymentId, userId, threadId, "and another thing");

    expect(drafts.readPending(deploymentId, userId, threadId)?.text).toBe("send me");
    expect(drafts.readDraft(deploymentId, userId, threadId)?.text).toBe("and another thing");
  });

  it("refuses a claim it could not write, so no key is used that the disk never saw", async () => {
    const privateFiles = new FlakyFilesystem();
    const { drafts } = open(privateFiles);
    await drafts.load();
    await drafts.writeDraft(deploymentId, userId, threadId, "send me");
    privateFiles.failWrites = true;

    await expect(
      drafts.claimPending(deploymentId, userId, threadId, {
        idempotencyKey: "message:abc",
        text: "send me",
        threadId,
      }),
    ).rejects.toThrow(/no space/u);

    // Nothing was claimed, and the draft the person typed is still theirs.
    expect(drafts.readPending(deploymentId, userId, threadId)).toBeNull();
    expect(drafts.readDraft(deploymentId, userId, threadId)?.text).toBe("send me");
  });

  it("retains an unacknowledged command when clearing it cannot reach disk", async () => {
    const privateFiles = new FlakyFilesystem();
    const { drafts } = open(privateFiles);
    await drafts.load();
    await drafts.claimPending(deploymentId, userId, threadId, {
      idempotencyKey: "message:original",
      text: "keep me",
      threadId,
    });
    privateFiles.failWrites = true;
    await expect(drafts.clearPending(deploymentId, userId, threadId)).rejects.toThrow(/no space/u);
    expect(drafts.readPending(deploymentId, userId, threadId)?.idempotencyKey).toBe(
      "message:original",
    );
    privateFiles.failWrites = false;
    await drafts.writeDraft(deploymentId, userId, otherThreadId, "later edit");
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readPending(deploymentId, userId, threadId)?.idempotencyKey).toBe(
      "message:original",
    );
  });

  it("serializes competing claims without replacing an unacknowledged key", async () => {
    const { drafts, privateFiles } = open();
    await drafts.load();
    const results = await Promise.allSettled([
      drafts.claimPending(deploymentId, userId, threadId, {
        idempotencyKey: "message:first",
        text: "first",
        threadId,
      }),
      drafts.claimPending(deploymentId, userId, threadId, {
        idempotencyKey: "message:second",
        text: "second",
        threadId,
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readPending(deploymentId, userId, threadId)?.idempotencyKey).toBe(
      "message:first",
    );
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
    await drafts.claimPending(deploymentId, userId, threadId, {
      idempotencyKey: "message:abc",
      text: "send me",
      threadId,
    });

    expect(drafts.readPending(deploymentId, userId, otherThreadId)).toBeNull();
    expect(
      drafts.readPending("dep_0192f4a1-9999-4000-8000-000000000009", userId, threadId),
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
    expect(relaunched.readPending(deploymentId, userId, threadId)).toBeNull();
  });

  it("drops the oldest drafts rather than growing without bound", async () => {
    const { drafts } = open();
    await drafts.load();
    for (let index = 0; index < 60; index += 1) {
      await drafts.writeDraft(deploymentId, userId, `thread-${index}`, `draft ${index}`);
    }

    expect(drafts.readDraft(deploymentId, userId, "thread-0")).toBeNull();
    expect(drafts.readDraft(deploymentId, userId, "thread-59")?.text).toBe("draft 59");
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

  function host() {
    const dispatch = vi.fn(async (_command: unknown) => ({ type: "thread.sendMessage" }));
    return { dispatch, hostClient: { dispatch } as unknown as HostClient };
  }

  it("sends a held message as an ordinary message under the key it was saved with", async () => {
    const privateFiles = previousRelease({
      drafts: {
        [entryKey]: { text: heldSteer.draftText, updatedAt: heldSteer.createdAt, userId },
      },
      pendingSteers: { [entryKey]: heldSteer },
    });
    const { drafts } = open(privateFiles);
    await drafts.load();

    const pending = drafts.readPending(deploymentId, userId, threadId);
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

    const { dispatch, hostClient } = host();
    if (pending === null) throw new Error("The held message was not carried over.");
    await sendPendingMessage(hostClient, pending);
    expect(dispatch.mock.calls).toEqual([
      [
        {
          content: [{ text: heldSteer.text, type: "text" }],
          delivery: "queue",
          idempotencyKey: heldSteer.messageIdempotencyKey,
          threadId,
          type: "thread.sendMessage",
        },
      ],
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
    expect(drafts).not.toHaveProperty("readPendingSteer");
    expect(drafts).not.toHaveProperty("claimPendingSteer");

    const relaunched = open(privateFiles).drafts;
    await relaunched.load();
    expect(relaunched.readPending(deploymentId, userId, threadId)?.idempotencyKey).toBe(
      heldSteer.messageIdempotencyKey,
    );
  });

  it("brings the same message back if the app is closed before the upgrade is saved", async () => {
    const privateFiles = previousRelease({ pendingSteers: { [entryKey]: heldSteer } });
    const first = open(privateFiles).drafts;
    await first.load();
    const second = open(privateFiles).drafts;
    await second.load();

    expect(second.readPending(deploymentId, userId, threadId)).toEqual(
      first.readPending(deploymentId, userId, threadId),
    );
  });

  it("keeps words typed after the held message in the draft", async () => {
    const privateFiles = previousRelease({
      drafts: { [entryKey]: { text: "newer draft", updatedAt: heldSteer.createdAt, userId } },
      pendingSteers: { [entryKey]: heldSteer },
    });
    const { drafts } = open(privateFiles);
    await drafts.load();

    expect(drafts.readPending(deploymentId, userId, threadId)?.text).toBe(heldSteer.text);
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
    expect(drafts.readPending(deploymentId, userId, threadId)).toBeNull();
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

    expect(drafts.readPending(deploymentId, userId, threadId)).toBeNull();
    expect(drafts.readDraft(deploymentId, userId, threadId)).toBeNull();
  });

  it("never hands one person's held message to another", async () => {
    const privateFiles = previousRelease({ pendingSteers: { [entryKey]: heldSteer } });
    const { drafts } = open(privateFiles);
    await drafts.load();

    expect(drafts.readPending(deploymentId, otherUserId, threadId)).toBeNull();
    expect(drafts.readDraft(deploymentId, otherUserId, threadId)).toBeNull();
  });

  it("replays a message the previous release still owed exactly as it was first sent", async () => {
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

    const pending = drafts.readPending(deploymentId, userId, threadId);
    expect(pending).toEqual({ ...owed, delivery: "queue" });
    const { dispatch, hostClient } = host();
    if (pending === null) throw new Error("The owed message was not loaded.");
    await sendPendingMessage(hostClient, pending);
    expect(JSON.stringify(dispatch.mock.calls[0]?.[0])).toBe(
      JSON.stringify({
        content: [{ text: "compare these", type: "text" }, ...owed.attachments],
        delivery: "queue",
        idempotencyKey: "message:owed",
        quotedMessageId: owed.quotedMessageId,
        threadId,
        type: "thread.sendMessage",
      }),
    );
  });

  it("replays a stored steering delivery exactly as stored", async () => {
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

    const pending = drafts.readPending(deploymentId, userId, threadId);
    expect(pending).toEqual(owed);
    const { dispatch, hostClient } = host();
    if (pending === null) throw new Error("The owed message was not loaded.");
    await sendPendingMessage(hostClient, pending);
    expect(dispatch).toHaveBeenCalledWith({
      content: [{ text: "change course", type: "text" }],
      delivery: "steer",
      idempotencyKey: "message:steer",
      threadId,
      type: "thread.sendMessage",
    });
  });
});
