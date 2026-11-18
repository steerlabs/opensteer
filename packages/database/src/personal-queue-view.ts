import type { AuthSessionId, MessageId, ThreadId } from "@opensteer/core";
import type { WaitingInputView } from "@opensteer/protocol";
import type { Kysely } from "kysely";
import { commitPersonalMutation, type PersonalMutationTransaction } from "./personal-mutation.js";
import { activeRunQueue } from "./personal-overlay-store.js";
import { isOfflineSettlement } from "./personal-transaction.js";
import type { DatabaseSchema } from "./schema.js";
import { readThreadInputQueue } from "./thread-inbox.js";

type Tx = PersonalMutationTransaction;

/** The owner's view of a task's Run queue and waiting messages, shared by the feed and snapshots. */
export async function threadQueueView(tx: Tx, threadId: ThreadId, revision: string) {
  const thread = await tx
    .selectFrom("threads")
    .select(["createdBy", "inputQueuePaused"])
    .where("id", "=", threadId)
    .where("removedAt", "is", null)
    .executeTakeFirst();
  if (!thread) return null;
  const runs = await activeRunQueue(tx, threadId);
  const waiting = await readThreadInputQueue(tx, { threadId, requestedBy: thread.createdBy });
  return {
    queue: {
      revision,
      runs,
      paused: thread.inputQueuePaused,
      steerRunId: waiting.steerRunId,
      inputs: waiting.items.map(({ message }) => message.id),
    },
    entries: waiting.items,
  };
}

/** Publishes the Run queue and every waiting message; `left` names messages that may have gone. */
export async function publishThreadQueues(
  tx: Tx,
  threadId: ThreadId,
  left: readonly MessageId[] = [],
) {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (tx, mutation) => {
    const view = await threadQueueView(tx, threadId, mutation.sequence);
    if (!view) return;
    const scopeKey = `thread:${threadId}` as const;
    mutation.change(
      { scopeKey, entityKind: "run-queue", entityId: threadId, operation: "upsert" },
      () => view.queue,
    );
    for (const entry of view.entries)
      mutation.change(
        { scopeKey, entityKind: "queue-entry", entityId: entry.message.id, operation: "upsert" },
        () => entry,
      );
    const waiting = new Set<string>(view.queue.inputs);
    for (const id of new Set(left))
      if (!waiting.has(id))
        mutation.change({ scopeKey, entityKind: "queue-entry", entityId: id, operation: "remove" });
  });
}

/** Lease ownership is per session, so the feed stores none and each reader adds its own. */
export async function decorateQueueEntries(
  database: Kysely<DatabaseSchema>,
  sessionId: AuthSessionId,
  entries: readonly WaitingInputView[],
  sendKeys: ReadonlyMap<string, string>,
): Promise<WaitingInputView[]> {
  const leased = entries.filter((entry) => entry.lease).map(({ message }) => message.id);
  const owned = leased.length
    ? new Set(
        (
          await database
            .selectFrom("threadInputs")
            .select("messageId")
            .where("messageId", "in", leased)
            .where("editLeaseSessionId", "=", sessionId)
            .execute()
        ).map(({ messageId }) => messageId),
      )
    : new Set<string>();
  return entries.map((entry) => {
    const key = sendKeys.get(entry.message.id);
    const { clientSendKey: _discard, ...message } = entry.message;
    return {
      ...entry,
      message: key ? { ...message, clientSendKey: key } : message,
      lease: entry.lease ? { ...entry.lease, ownedBySession: owned.has(entry.message.id) } : null,
    };
  });
}
