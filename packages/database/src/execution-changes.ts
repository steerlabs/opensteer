import { projectThreadState, publishRunQueue } from "./thread-status.js";
import { refreshInputQueue } from "./waiting-inputs.js";
import { utf8ByteLength, utf8Prefix, type RunId, type ThreadId } from "@opensteer/core";
import { sql, type Insertable, type Selectable, type Kysely, type InferResult } from "kysely";
import { type PersonalMutation, type PersonalMutationTransaction } from "./personal-mutation.js";
import { itemColumns, itemView } from "./personal-sync-store.js";
import { runDeliverySelection, runUsageFromRow } from "./thread-row-mappers.js";
import type { DatabaseSchema } from "./schema.js";
import type { TranscriptPreview, TranscriptItemTable } from "./personal-state-schema.js";
import type { TranscriptMessageRefs } from "@opensteer/protocol/transcript";

export async function updateExecutionThread(
  tx: PersonalMutationTransaction,
  threadId: ThreadId,
  now: Date,
) {
  await projectThreadState(tx, threadId, now);
  await publishRunQueue(tx, threadId);
}

export function transcriptRuns(database: Kysely<DatabaseSchema>) {
  return database
    .selectFrom("runs")
    .select([
      "id",
      "threadId",
      "status",
      "createdAt",
      "completedAt",
      "terminalReplyMessageId",
      "failure",
      "maintenance",
      "phase",
      "finishIntent",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "cacheWriteTokens",
      "reasoningTokens",
      "costUsd",
    ])
    .select(runDeliverySelection);
}

export function describeTranscriptRun(
  run: InferResult<ReturnType<typeof transcriptRuns>>[number],
): TranscriptPreview {
  const active = run.completedAt === null;
  const status =
    active && run.finishIntent
      ? "finishing"
      : active && run.phase === "background"
        ? "background"
        : run.status;
  const usage = runUsageFromRow(run);
  const view = {
    status,
    ...(run.completedAt ? { endedAt: run.completedAt.toISOString() } : {}),
    ...(run.terminalReplyMessageId ? { replyMessageId: run.terminalReplyMessageId } : {}),
    ...(usage ? { usage } : {}),
    ...(run.failure
      ? { failure: { ...run.failure, message: utf8Prefix(run.failure.message, 512) } }
      : {}),
    ...(run.delivery ? { runDelivery: { ...run.delivery } } : {}),
  };
  while (utf8ByteLength(JSON.stringify(view)) > 1_920) {
    if (view.failure?.message) {
      view.failure.message = utf8Prefix(
        view.failure.message,
        Math.floor(utf8ByteLength(view.failure.message) / 2),
      );
    } else if (view.runDelivery?.reason) {
      view.runDelivery.reason =
        utf8Prefix(
          view.runDelivery.reason,
          Math.floor(utf8ByteLength(view.runDelivery.reason) / 2),
        ).trim() || null;
    } else {
      if (view.failure) view.failure.code = utf8Prefix(view.failure.code, 128);
      break;
    }
  }
  return view;
}

export async function publishTranscriptRun(
  tx: PersonalMutationTransaction,
  mutation: PersonalMutation,
  runId: RunId,
) {
  const run = await transcriptRuns(tx).where("id", "=", runId).executeTakeFirstOrThrow();
  if (run.maintenance) return;
  await writeExecutionItem(tx, mutation, {
    id: `run:${run.id}`,
    kind: "run",
    runId: run.id,
    threadId: run.threadId,
    nodeId: null,
    attemptId: null,
    createdAt: run.createdAt,
    visible: true,
    isTurnStart: false,
    view: describeTranscriptRun(run),
  });
}

export async function recordExecutionRunChange(
  tx: PersonalMutationTransaction,
  mutation: PersonalMutation,
  input: Omit<
    Extract<import("./personal-mutation.js").PersonalCommitReaction, { type: "runChanged" }>,
    "type" | "environmentId"
  >,
) {
  const run = await tx
    .updateTable("runs")
    .set({ revision: mutation.sequence })
    .where("id", "=", input.runId)
    .returning("environmentId")
    .executeTakeFirstOrThrow();
  if (input.transition !== "usage-limit") await publishTranscriptRun(tx, mutation, input.runId);
  await publishRunQueue(tx, input.threadId);
  mutation.react({ type: "runChanged", environmentId: run.environmentId, ...input });
}

/** `fresh` carries the position a caller reserved for an item whose source row it just inserted. */
export async function writeExecutionItem(
  tx: PersonalMutationTransaction,
  mutation: PersonalMutation,
  item: Omit<Insertable<TranscriptItemTable>, "position" | "revision">,
  fresh?: { readonly position: string | null },
) {
  const old = fresh
    ? undefined
    : (mutation.transcriptPlacement(item.id) ??
      (await tx
        .selectFrom("transcriptItems")
        .select(["position", "nodeId", "visible"])
        .where("id", "=", item.id)
        .executeTakeFirst()));
  let position = fresh?.position ?? old?.position ?? null;
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
  const { body, refs, ...fields } = item;
  const ownedRefs =
    refs === undefined
      ? {}
      : { refs: refs === null ? null : sql<TranscriptMessageRefs>`${JSON.stringify(refs)}::jsonb` };
  const ownedBody =
    body === undefined
      ? {}
      : {
          body: sql<
            string | import("./personal-state-schema.js").PlaceView | null
          >`${JSON.stringify(body)}::jsonb`,
        };
  if (old?.visible && (!item.visible || old.nodeId !== item.nodeId)) {
    await tx
      .updateTable("threads")
      .set({ transcriptOrderRevision: mutation.sequence })
      .where("id", "=", item.threadId)
      .execute();
    mutation.change({
      scopeKey: old.nodeId ? `node:${old.nodeId}` : `thread:${item.threadId}`,
      entityKind: "item",
      entityId: item.id,
      operation: "remove",
    });
  }
  mutation.stageTranscript(
    item.id,
    {
      position,
      nodeId: item.nodeId ?? null,
      visible: item.visible,
      isTurnStart: item.isTurnStart,
    },
    async () => {
      const card = await tx
        .insertInto("transcriptItems")
        .values({ ...fields, ...ownedBody, ...ownedRefs, position, revision: mutation.sequence })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            nodeId: item.nodeId,
            runId: item.runId,
            isTurnStart: item.isTurnStart,
            view: item.view,
            visible: item.visible,
            position,
            ...ownedBody,
            ...ownedRefs,
            revision: mutation.sequence,
          }),
        )
        // A card draws from its view; only a place also draws from its bounded body.
        .returning([
          ...itemColumns,
          "visible",
          sql<TranscriptItemTable["body"]>`case when kind = 'place' then body end`.as("body"),
        ])
        .executeTakeFirstOrThrow();
      const scopeKey = card.nodeId
        ? (`node:${card.nodeId}` as const)
        : (`thread:${card.threadId}` as const);
      if (card.visible)
        mutation.change(
          { scopeKey, entityKind: "item", entityId: card.id, operation: "upsert" },
          () => itemView(card),
        );
    },
  );
}

export async function publishExecutionInput(
  tx: PersonalMutationTransaction,
  input: Pick<
    Selectable<import("./schema.js").DatabaseSchema["threadInputs"]>,
    "threadId" | "messageId"
  >,
) {
  await refreshInputQueue(tx, input.threadId, input.messageId);
}
