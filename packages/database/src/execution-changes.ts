import { refreshRequestAttention } from "./personal-attention-store.js";
import { describeTranscriptMessage } from "./transcript-store.js";
import { messageFromRow } from "./thread-row-mappers.js";
import {
  deriveThreadStatus,
  nonTerminalRunStatuses,
  utf8Prefix,
  type RequestId,
  type ThreadId,
} from "@opensteer/core";
import { sql, type Insertable, type Selectable } from "kysely";
import {
  commitPersonalMutation,
  type PersonalMutation,
  type PersonalMutationTransaction,
} from "./personal-mutation.js";
import { itemView } from "./personal-sync-store.js";
import type { TranscriptItemTable } from "./personal-state-schema.js";
import { isOfflineSettlement } from "./personal-transaction.js";

export function invalidateExecution(
  mutation: PersonalMutation,
  threadId: ThreadId,
  ...collections: string[]
) {
  for (const entityId of collections) {
    mutation.change(
      {
        scopeKey: `thread:${threadId}`,
        entityKind: "collection",
        entityId,
        operation: "invalidate",
      },
      () => ({ revision: mutation.sequence }),
    );
  }
}

export async function updateExecutionThread(
  tx: PersonalMutationTransaction,
  threadId: ThreadId,
  now: Date,
) {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (tx, mutation) => {
    const thread = await tx
      .selectFrom("threads")
      .select(["status", "inputQueuePaused"])
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow();
    const active = await tx
      .selectFrom("runs")
      .select("status")
      .where("threadId", "=", threadId)
      .where("maintenance", "is", null)
      .where("status", "in", nonTerminalRunStatuses)
      .orderBy("runOrdinal")
      .limit(1)
      .executeTakeFirst();
    const latest = await tx
      .selectFrom("runs")
      .select("status")
      .where("threadId", "=", threadId)
      .where("maintenance", "is", null)
      .orderBy("runOrdinal", "desc")
      .limit(1)
      .executeTakeFirst();
    const status =
      thread.status === "archived"
        ? thread.status
        : deriveThreadStatus({
            earliestActiveRunStatus: active?.status ?? null,
            inputQueuePaused: thread.inputQueuePaused,
            lastRunFailed: latest?.status === "failed",
          });
    await tx
      .updateTable("threads")
      .set({ status, updatedAt: now, revision: mutation.sequence })
      .where("id", "=", threadId)
      .execute();
    await publishExecutionThread(tx, mutation, threadId);
    await publishExecutionQueue(tx, mutation, threadId);
  });
}

export async function recordExecutionRunChange(
  tx: PersonalMutationTransaction,
  mutation: PersonalMutation,
  input: Omit<
    Extract<import("./personal-mutation.js").PersonalCommitReaction, { type: "runChanged" }>,
    "type"
  >,
) {
  await tx
    .updateTable("runs")
    .set({ revision: mutation.sequence })
    .where("id", "=", input.runId)
    .execute();
  const run = await tx
    .selectFrom("runs")
    .select(["status", "createdAt", "maintenance"])
    .where("id", "=", input.runId)
    .executeTakeFirstOrThrow();
  if (!run.maintenance && input.transition !== "usage-limit") {
    const status =
      input.transition === "background" || input.transition === "finishing"
        ? input.transition
        : run.status;
    await writeExecutionItem(tx, mutation, {
      id: `run:${input.runId}`,
      kind: "run",
      runId: input.runId,
      threadId: input.threadId,
      nodeId: null,
      attemptId: null,
      createdAt: run.createdAt,
      visible: true,
      isTurnStart: false,
      view: { status },
    });
  }
  await publishExecutionQueue(tx, mutation, input.threadId);
  mutation.react({ type: "runChanged", ...input });
}

export async function publishExecutionThread(
  tx: PersonalMutationTransaction,
  mutation: PersonalMutation,
  threadId: ThreadId,
) {
  const row = await tx
    .selectFrom("threads")
    .select([
      "id",
      "title",
      "revision",
      "status",
      "purpose",
      "askedAt",
      "doneAt",
      "pendingRequestCount",
      "lastReplyPreview",
      "failurePreview",
      "latestRunCompletedAt",
      "listed",
    ])
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  const { listed, askedAt, doneAt, latestRunCompletedAt, ...fields } = row;
  const view = {
    ...fields,
    askedAt: askedAt.toISOString(),
    doneAt: doneAt?.toISOString() ?? null,
    latestRunCompletedAt: latestRunCompletedAt?.toISOString() ?? null,
  };
  mutation.change(
    {
      scopeKey: `thread:${threadId}`,
      entityKind: "thread",
      entityId: threadId,
      operation: "upsert",
    },
    () => view,
  );
  if (listed)
    mutation.change(
      { scopeKey: "shell", entityKind: "task", entityId: threadId, operation: "upsert" },
      () => view,
    );
}

export async function publishExecutionQueue(
  tx: PersonalMutationTransaction,
  mutation: PersonalMutation,
  threadId: ThreadId,
) {
  const runs = await tx
    .selectFrom("runs")
    .select(["id", "status", "revision"])
    .select(sql<boolean>`finish_intent is not null`.as("finishing"))
    .where("threadId", "=", threadId)
    .where(sql<boolean>`status in ('queued','starting','running','waiting')`)
    .orderBy("runOrdinal")
    .limit(2)
    .execute();
  const thread = await tx
    .selectFrom("threads")
    .select("inputQueuePaused")
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  mutation.change(
    {
      scopeKey: `thread:${threadId}`,
      entityKind: "run-queue",
      entityId: threadId,
      operation: "upsert",
    },
    () => ({ revision: mutation.sequence, paused: thread.inputQueuePaused, runs }),
  );
}

export async function writeExecutionItem(
  tx: PersonalMutationTransaction,
  mutation: PersonalMutation,
  item: Omit<Insertable<TranscriptItemTable>, "position" | "revision">,
) {
  const old = await tx
    .selectFrom("transcriptItems")
    .select(["position", "nodeId", "visible"])
    .where("id", "=", item.id)
    .executeTakeFirst();
  let position = old?.position ?? null;
  if (item.visible && position === null) {
    const thread = await tx
      .updateTable("threads")
      .set({
        nextTranscriptPosition: sql<string>`next_transcript_position + 1`,
        revision: mutation.sequence,
      })
      .where("id", "=", item.threadId)
      .returning("nextTranscriptPosition")
      .executeTakeFirstOrThrow();
    position = thread.nextTranscriptPosition;
  }
  const { body, ...fields } = item;
  const ownedBody =
    body === undefined
      ? {}
      : {
          body: sql<
            string | import("./personal-state-schema.js").PlaceView | null
          >`${JSON.stringify(body)}::jsonb`,
        };
  const card = await tx
    .insertInto("transcriptItems")
    .values({ ...fields, ...ownedBody, position, revision: mutation.sequence })
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({
        nodeId: item.nodeId,
        runId: item.runId,
        isTurnStart: item.isTurnStart,
        view: item.view,
        visible: item.visible,
        position,
        ...ownedBody,
        revision: mutation.sequence,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  const scopeKey = card.nodeId
    ? (`node:${card.nodeId}` as const)
    : (`thread:${card.threadId}` as const);
  if (old?.visible && (!card.visible || old.nodeId !== card.nodeId)) {
    await tx
      .updateTable("threads")
      .set({ transcriptOrderRevision: mutation.sequence })
      .where("id", "=", card.threadId)
      .execute();
    mutation.change({
      scopeKey: old.nodeId ? `node:${old.nodeId}` : `thread:${card.threadId}`,
      entityKind: "item",
      entityId: card.id,
      operation: "remove",
    });
  }
  if (card.visible)
    mutation.change({ scopeKey, entityKind: "item", entityId: card.id, operation: "upsert" }, () =>
      itemView(card),
    );
}

export async function publishExecutionInput(
  tx: PersonalMutationTransaction,
  input: Pick<
    Selectable<import("./schema.js").DatabaseSchema["threadInputs"]>,
    "threadId" | "messageId" | "policy" | "state" | "runId"
  >,
) {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (tx, mutation) => {
    const row = await tx
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", input.messageId)
      .executeTakeFirstOrThrow();
    const message = messageFromRow(row);
    const run = input.runId
      ? await tx
          .selectFrom("runs")
          .select(["seedInputId", "assignmentId"])
          .where("id", "=", input.runId)
          .executeTakeFirst()
      : undefined;
    const seedInRun = run?.seedInputId === row.id;
    const { published, visible, isTurnStart, view } = describeTranscriptMessage({
      ...message,
      policy: input.policy,
      state: input.state,
      edited: row.editedAt !== null,
      admittedSeed: seedInRun && (input.state === "pending" || input.state === "claimed"),
      seedInRun,
      assigned: run?.assignmentId != null,
    });
    await tx.updateTable("messages").set({ published }).where("id", "=", row.id).execute();
    const item = await tx
      .selectFrom("transcriptItems")
      .select("id")
      .where("id", "=", row.id)
      .executeTakeFirst();
    if (visible || item)
      await writeExecutionItem(tx, mutation, {
        id: row.id,
        kind: "message",
        messageId: row.id,
        threadId: row.threadId,
        runId: input.runId ?? row.runId,
        attemptId: null,
        nodeId: null,
        createdAt: row.createdAt,
        isTurnStart,
        visible,
        view,
      });
    await tx
      .updateTable("threads")
      .set({ inputQueueRevision: mutation.sequence, revision: mutation.sequence })
      .where("id", "=", input.threadId)
      .execute();
    invalidateExecution(mutation, input.threadId, "input-queue");
  });
}

export async function publishExecutionRequest(
  tx: PersonalMutationTransaction,
  input: { id: RequestId },
) {
  await commitPersonalMutation(tx, async (tx, mutation) => {
    const request = await tx
      .updateTable("requests")
      .set({ revision: mutation.sequence })
      .where("id", "=", input.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await refreshRequestAttention(tx, mutation, request.id);
    const scopeKey = request.originatingNodeId
      ? (`node:${request.originatingNodeId}` as const)
      : (`thread:${request.originatingThreadId}` as const);
    const title =
      typeof request.presentation === "object" &&
      request.presentation &&
      "title" in request.presentation &&
      typeof request.presentation.title === "string"
        ? utf8Prefix(request.presentation.title, 192)
        : "Request";
    mutation.change(
      { scopeKey, entityKind: "request", entityId: request.id, operation: "upsert" },
      () => ({
        id: request.id,
        kind: request.kind,
        status: request.status,
        revision: mutation.sequence,
        threadId: request.originatingThreadId,
        title,
      }),
    );
    const node = request.originatingNodeId
      ? await tx
          .selectFrom("executionNodes")
          .select("attemptId")
          .where("id", "=", request.originatingNodeId)
          .where("runId", "=", request.originatingRunId)
          .executeTakeFirstOrThrow()
      : null;
    await writeExecutionItem(tx, mutation, {
      id: `request:${request.id}`,
      kind: "request",
      requestId: request.id,
      threadId: request.originatingThreadId,
      runId: request.originatingRunId,
      attemptId: node?.attemptId ?? null,
      nodeId: request.originatingNodeId,
      createdAt: request.createdAt,
      isTurnStart: false,
      visible: true,
      view: { title, status: request.status },
    });
  });
}
