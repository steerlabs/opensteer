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
export async function threadQueueView(
  tx: Tx,
  threadId: ThreadId,
  revision: string,
  /** The task's queued and running Runs, when the caller already read them in this cut. */
  activeRuns?: Awaited<ReturnType<typeof activeRunQueue>>,
) {
  // Read once and handed to the waiting-input read, which then needs neither it nor the owner.
  const thread = await tx
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", threadId)
    .where("removedAt", "is", null)
    .executeTakeFirst();
  if (!thread) return null;
  const runs = activeRuns ?? (await activeRunQueue(tx, threadId));
  const waiting = await readThreadInputQueue(tx, {
    threadId,
    requestedBy: thread.createdBy,
    thread,
  });
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
/** Publishes the task's queue once per commit, after every change this commit makes to it. */
export async function publishThreadQueues(
  tx: Tx,
  threadId: ThreadId,
  left: readonly MessageId[] = [],
) {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (_tx, mutation) => {
    mutation.deferQueue(threadId, left);
  });
}

export async function writeThreadQueues(
  tx: Tx,
  threadId: ThreadId,
  left: readonly MessageId[] = [],
) {
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

/** Who holds each waiting message's edit lease, read in the same cut as the values it decorates. */
export async function readQueueLeaseHolders(
  tx: Kysely<DatabaseSchema>,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, AuthSessionId>> {
  if (!messageIds.length) return new Map();
  const rows = await tx
    .selectFrom("threadInputs")
    .select(["messageId", "editLeaseSessionId"])
    .where("messageId", "in", [...new Set(messageIds)] as MessageId[])
    .where("editLeaseSessionId", "is not", null)
    .execute();
  return new Map(rows.map((row) => [row.messageId, row.editLeaseSessionId!]));
}

/** Lease ownership and send keys are per session, so the feed stores neither and each reader adds its own. */
export function decorateQueueEntries(
  sessionId: AuthSessionId,
  entries: readonly WaitingInputView[],
  sendKeys: ReadonlyMap<string, string>,
  holders: ReadonlyMap<string, AuthSessionId>,
): WaitingInputView[] {
  return entries.map((entry) => {
    const key = sendKeys.get(entry.message.id);
    const { clientSendKey: _discard, ...message } = entry.message;
    return {
      ...entry,
      message: key ? { ...message, clientSendKey: key } : message,
      lease: entry.lease
        ? { ...entry.lease, ownedBySession: holders.get(entry.message.id) === sessionId }
        : null,
    };
  });
}
