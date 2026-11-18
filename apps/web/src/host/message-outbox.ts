export { storageUnavailable } from "./message-outbox-records.js";
import { browserMessageRecords } from "./message-outbox-records.js";
import { hostApi } from "@opensteer/protocol";
import {
  createMessageOutboxStorage,
  initializeMessageOutbox,
  messageDraftParts,
  type HostClient,
  type MessageRecordStorage,
  type PendingSendCommand,
  type StoredMessage,
} from "@opensteer/client/host";
import type { ClientScope } from "@opensteer/client/connections";
import {
  MessageContentSchema,
  type ArtifactContentPart,
  type CompactionSendChoice,
  type ContentPart,
  type PlaceContentPart,
} from "@opensteer/core";
import {
  composerDraftKey,
  composerDrafts,
  type createComposerDraftStore,
} from "../components/composer-drafts.js";

type ComposerDraftStore = ReturnType<typeof createComposerDraftStore>;

export function initializeBrowserMessageOutbox(
  client: HostClient,
  records: MessageRecordStorage = browserMessageRecords(),
): void {
  const storage = createMessageOutboxStorage(records);
  initializeMessageOutbox(client, {
    storage,
    legacy: {
      load: async (scope) => browserLegacyMessages(scope).map(({ command }) => ({ command })),
      has: (scope, id) =>
        browserLegacyMessages(scope).some(({ command }) => command.idempotencyKey === id),
      remove: async (scope, id) => {
        for (const { key, command } of browserLegacyMessages(scope))
          if (command.idempotencyKey === id) globalThis.localStorage.removeItem(key);
      },
    },
    drafts: { restore: async (scope, entry) => restoreComposerDraft(composerDrafts, scope, entry) },
  });
}

function browserLegacyMessages(scope: ClientScope) {
  const prefix = `opensteer:pending-send:v1:${encodeURIComponent(scope.deploymentId)}:${encodeURIComponent(scope.viewerId)}:`;
  let keys: string[];
  try {
    keys = Object.keys(globalThis.localStorage);
  } catch {
    return [];
  }
  return keys.flatMap((key) => {
    if (!key.startsWith(prefix)) return [];
    try {
      const raw = globalThis.localStorage.getItem(key);
      if (raw === null || new TextEncoder().encode(raw).byteLength > 10 * 1024 * 1024) return [];
      const command = hostApi["commands.dispatch"].payload.parse(JSON.parse(raw));
      return command.type === "thread.sendMessage" &&
        command.threadId === decodeURIComponent(key.slice(prefix.length))
        ? [{ key, command }]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * Edit's hand-back: the message goes above the words already in its thread's
 * draft, with its files, places and quote; nothing of the draft is lost.
 */
export function restoreComposerDraft(
  drafts: ComposerDraftStore,
  scope: ClientScope,
  entry: StoredMessage,
): "restored" | "occupied" {
  const key = composerDraftKey(
    { deploymentId: scope.deploymentId, userId: scope.viewerId },
    { kind: "thread", threadId: entry.command.threadId },
  );
  const held = drafts.read(key);
  if (held?.recoveredSendKeys?.includes(entry.localId)) return "restored";
  if (
    held?.quote &&
    entry.command.quotedMessageId &&
    held.quote.messageId !== entry.command.quotedMessageId
  )
    return "occupied";
  const parts = messageDraftParts(entry.command.content);
  const above = (text: string) => (text.trim() ? `${parts.body}\n\n${text}` : parts.body);
  const files = parts.attachments
    .filter((part) => !held?.files.some((file) => file.part?.artifactId === part.artifactId))
    .map((part) => ({
      part,
      mediaType: part.mediaType,
      name: part.name,
      sizeBytes: part.sizeBytes ?? 0,
    }));
  const quote =
    held?.quote ??
    (entry.command.quotedMessageId
      ? { messageId: entry.command.quotedMessageId, attribution: "", excerpt: "" }
      : null);
  const restored = drafts.restore(
    key,
    {
      text: above(held?.text ?? ""),
      files: [...files, ...(held?.files ?? [])],
      places: [...parts.places, ...(held?.places ?? [])],
      quote,
      updatedAt: Date.now(),
      recoveredSendKeys: [...(held?.recoveredSendKeys ?? []), entry.localId].slice(-40),
    },
    { edit: above, files, places: parts.places, quote: held?.quote ? null : quote },
  );
  if (!restored) throw new Error("The draft could not be saved.");
  return "restored";
}

/**
 * A message ready to be kept and sent: its words, its files and its key,
 * fixed together. Sending it again under that key is the same message.
 */
export interface PendingSubmission {
  readonly compaction?: CompactionSendChoice;
  readonly places?: readonly PlaceContentPart[];
  /** Exact content, where the words were edited as parts rather than typed. */
  readonly content?: readonly ContentPart[];
  readonly attachments: readonly ArtifactContentPart[];
  readonly body: string;
  readonly idempotencyKey: string;
  readonly quotedMessageId?: string;
}

/**
 * The exact command a message is sent as: its words, the places it includes,
 * then its files in the order they were added. An attachments-only message
 * has no text part.
 */
export function sendMessageCommand(
  threadId: string,
  submission: PendingSubmission,
): PendingSendCommand {
  const text = submission.body.trim();
  return {
    content: MessageContentSchema.parse(
      submission.content ?? [
        ...(text ? [{ text, type: "text" as const }] : []),
        ...(submission.places ?? []),
        ...submission.attachments,
      ],
    ),
    ...(submission.compaction ? { compaction: submission.compaction } : {}),
    delivery: "queue",
    idempotencyKey: submission.idempotencyKey,
    // Only the source id travels: the Host looks the quoted message up under
    // this reader's authority rather than trusting an excerpt a client wrote.
    ...(submission.quotedMessageId ? { quotedMessageId: submission.quotedMessageId } : {}),
    threadId,
    type: "thread.sendMessage",
  };
}
