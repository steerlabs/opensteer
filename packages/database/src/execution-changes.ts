import { projectThreadState, publishRunQueue } from "./thread-status.js";
import { refreshInputQueue } from "./waiting-inputs.js";
import type { ThreadId } from "@opensteer/core";
import { sql, type Insertable, type Selectable } from "kysely";
import { type PersonalMutation, type PersonalMutationTransaction } from "./personal-mutation.js";
import { itemView } from "./personal-sync-store.js";
import type { TranscriptItemTable } from "./personal-state-schema.js";

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
  await projectThreadState(tx, threadId, now);
  await publishRunQueue(tx, threadId);
}

export async function recordExecutionRunChange(
  tx: PersonalMutationTransaction,
  mutation: PersonalMutation,
  input: Omit<
    Extract<import("./personal-mutation.js").PersonalCommitReaction, { type: "runChanged" }>,
    "type" | "environmentId"
  >,
) {
  await tx
    .updateTable("runs")
    .set({ revision: mutation.sequence })
    .where("id", "=", input.runId)
    .execute();
  const run = await tx
    .selectFrom("runs")
    .select(["status", "createdAt", "maintenance", "environmentId"])
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
  await publishRunQueue(tx, input.threadId);
  mutation.react({ type: "runChanged", environmentId: run.environmentId, ...input });
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
    "threadId" | "messageId"
  >,
) {
  await refreshInputQueue(tx, input.threadId, input.messageId);
}
