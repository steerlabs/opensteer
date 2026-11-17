import { browserMessageRecords } from "./message-outbox-records.js";
import { hostApi } from "@opensteer/protocol";
import {
  createMessageOutboxStorage,
  initializeMessageOutbox,
  messageDraftParts,
  type HostClient,
  type MessageRecordStorage,
} from "@opensteer/client/host";
import { composerDraftKey, composerDrafts } from "../components/composer-drafts.js";

export function initializeBrowserMessageOutbox(
  client: HostClient,
  records: MessageRecordStorage = browserMessageRecords(),
): void {
  const storage = createMessageOutboxStorage(records);
  initializeMessageOutbox(client, {
    storage,
    legacy: {
      load: async (scope) => {
        const prefix = `opensteer:pending-send:v1:${encodeURIComponent(scope.deploymentId)}:${encodeURIComponent(scope.viewerId)}:`;
        return Object.keys(globalThis.localStorage)
          .filter((key) => key.startsWith(prefix))
          .map((key) => {
            const raw = globalThis.localStorage.getItem(key);
            if (raw === null || new TextEncoder().encode(raw).byteLength > 10 * 1024 * 1024)
              throw new Error("Saved message cannot be read.");
            const command = hostApi["commands.dispatch"].payload.parse(JSON.parse(raw));
            if (
              command.type !== "thread.sendMessage" ||
              command.threadId !== decodeURIComponent(key.slice(prefix.length))
            )
              throw new Error("Saved message scope is invalid.");
            return { command };
          });
      },
      remove: async (scope, id) => {
        const prefix = `opensteer:pending-send:v1:${encodeURIComponent(scope.deploymentId)}:${encodeURIComponent(scope.viewerId)}:`;
        for (const key of Object.keys(globalThis.localStorage).filter((key) =>
          key.startsWith(prefix),
        )) {
          const value = hostApi["commands.dispatch"].payload.parse(
            JSON.parse(globalThis.localStorage.getItem(key)!),
          );
          if ("idempotencyKey" in value && value.idempotencyKey === id)
            globalThis.localStorage.removeItem(key);
        }
      },
    },
    drafts: {
      restore: async (scope, entry) => {
        const key = composerDraftKey(
          { deploymentId: scope.deploymentId, userId: scope.viewerId },
          { kind: "thread", threadId: entry.command.threadId },
        );
        const held = composerDrafts.read(key);
        if (held?.recoveredSendKeys?.includes(entry.localId)) return "restored";
        if (held && (held.text.trim() || held.files.length || held.places?.length || held.quote))
          return "occupied";
        const parts = messageDraftParts(entry.command.content);
        const restored = composerDrafts.restore(key, {
          text: parts.body,
          files: parts.attachments.map((part) => ({
            part,
            mediaType: part.mediaType,
            name: part.name,
            sizeBytes: part.sizeBytes ?? 0,
          })),
          places: parts.places,
          quote: entry.command.quotedMessageId
            ? { messageId: entry.command.quotedMessageId, attribution: "", excerpt: "" }
            : null,
          updatedAt: Date.now(),
          recoveredSendKeys: [...(held?.recoveredSendKeys ?? []), entry.localId].slice(-40),
        });
        if (!restored) throw new Error("The draft could not be saved.");
        return "restored";
      },
    },
  });
}
