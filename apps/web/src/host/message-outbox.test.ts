import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  composerDraftKey,
  createComposerDraftStore,
  type DraftStorage,
} from "../components/composer-drafts.js";
import { restoreComposerDraft } from "./message-outbox.js";

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
    expect(restoreComposerDraft(drafts, scope, entry)).toBe("restored");
    expect(restoreComposerDraft(drafts, scope, entry)).toBe("restored");
    expect(drafts.read(key)).toMatchObject({
      files: [{ part: file }],
      quote: { messageId: quotedMessageId },
      text: "Queued words\n\nNewer draft",
    });
  });
});
