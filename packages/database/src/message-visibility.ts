import {
  MessageContentSchema,
  nonTerminalRunStatuses,
  utf8Prefix,
  type MessageId,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import {
  commitPersonalMutation,
  type PersonalMutation,
  type PersonalMutationTransaction,
} from "./personal-mutation.js";
import { isOfflineSettlement } from "./personal-transaction.js";
import { itemView } from "./personal-sync-store.js";
import { invalidateThreadCollection, publishThreadSummary } from "./thread-status.js";
import { messageEditFromRow } from "./thread-row-mappers.js";
import { describeTranscriptMessage } from "./transcript-store.js";
import type { TranscriptItemTable } from "./personal-state-schema.js";
import { sql, type Insertable, type RawBuilder } from "kysely";

/** A published report is visible before consumption; waiting work is not. */
export function publishedMessagePredicate(inputAlias: string): RawBuilder<boolean> {
  const field = (name: string) => sql.ref(`${inputAlias}.${name}`);
  return sql<boolean>`(${field("messageId")} is null
    or ${field("state")} = 'delivered'
    or (${field("policy")} = 'report' and ${field("state")} <> 'cancelled'))`;
}

export async function allocateTranscriptPosition(
  tx: PersonalMutationTransaction,
  threadId: ThreadId,
) {
  const thread = await tx
    .updateTable("threads")
    .set({ nextTranscriptPosition: sql<string>`next_transcript_position + 1` })
    .where("id", "=", threadId)
    .returning("nextTranscriptPosition")
    .executeTakeFirstOrThrow();
  return thread.nextTranscriptPosition;
}

export async function syncTranscriptMessage(
  tx: PersonalMutationTransaction,
  messageId: MessageId,
  placement?: { readonly runId: RunId; readonly move: boolean },
): Promise<void> {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (tx, mutation) => {
    const message = await tx
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", messageId)
      .executeTakeFirstOrThrow();
    const input = await tx
      .selectFrom("threadInputs")
      .select(["policy", "state", "runId", "cancelReason", "teamSource"])
      .where("messageId", "=", messageId)
      .executeTakeFirst();
    const seed =
      input && input.state !== "cancelled"
        ? await tx
            .selectFrom("runs")
            .select(["id", "status", "assignmentId"])
            .where("seedInputId", "=", messageId)
            .orderBy("runOrdinal", "desc")
            .limit(1)
            .executeTakeFirst()
        : undefined;
    const prior =
      mutation.transcriptPlacement(messageId) ??
      (await tx
        .selectFrom("transcriptItems")
        .select(["visible", "position", "nodeId", "isTurnStart"])
        .where("id", "=", messageId)
        .executeTakeFirst());
    const runId = placement?.runId ?? message.runId ?? input?.runId ?? seed?.id ?? null;
    const assigned =
      runId && runId !== seed?.id
        ? await tx
            .selectFrom("runs")
            .select("assignmentId")
            .where("id", "=", runId)
            .executeTakeFirst()
        : seed;
    const edit = messageEditFromRow(message);
    const { published, visible, isTurnStart, view } = describeTranscriptMessage({
      kind: message.kind,
      content: MessageContentSchema.parse(message.content),
      author: message.author,
      ...(input
        ? { policy: input.policy, state: input.state, cancelReason: input.cancelReason }
        : {}),
      ...(edit ? { edit } : {}),
      ...(input?.teamSource ? { teamSource: input.teamSource } : {}),
      edited: message.revision > 0,
      admittedSeed: Boolean(
        seed && nonTerminalRunStatuses.some((status) => status === seed.status),
      ),
      seedInRun: runId !== null && runId === seed?.id,
      assigned: assigned?.assignmentId != null,
    });
    if (published !== message.published)
      await tx.updateTable("messages").set({ published }).where("id", "=", messageId).execute();

    const move = Boolean(visible && prior?.visible && placement?.move);
    const position = visible
      ? !prior?.visible || move
        ? await allocateTranscriptPosition(tx, message.threadId)
        : prior.position
      : null;
    const orderChanged = Boolean(prior?.visible && (!visible || move));
    const fields = {
      position,
      revision: mutation.sequence,
      visible,
      isTurnStart: visible && prior?.visible && !move ? prior.isTurnStart : isTurnStart,
      runId,
      view,
    };
    const scopeKey = `thread:${message.threadId}` as const;
    mutation.stageTranscript(messageId, { ...fields, nodeId: null }, async () => {
      const item = await tx
        .insertInto("transcriptItems")
        .values({
          id: messageId,
          messageId,
          threadId: message.threadId,
          attemptId: null,
          nodeId: null,
          kind: "message",
          createdAt: message.createdAt,
          ...fields,
        })
        .onConflict((conflict) => conflict.column("id").doUpdateSet(fields))
        .returningAll()
        .executeTakeFirstOrThrow();
      if (visible)
        mutation.change(
          { scopeKey, entityKind: "item", entityId: messageId, operation: "upsert" },
          () => itemView(item),
        );
      else if (prior?.visible)
        mutation.change({ scopeKey, entityKind: "item", entityId: messageId, operation: "remove" });
    });
    if (!visible && !prior?.visible)
      await invalidateThreadCollection(tx, message.threadId, "messages");
    if (orderChanged) {
      await tx
        .updateTable("threads")
        .set({ transcriptOrderRevision: mutation.sequence })
        .where("id", "=", message.threadId)
        .execute();
      mutation.change(
        {
          scopeKey,
          entityKind: "collection",
          entityId: "transcript-order",
          operation: "invalidate",
        },
        () => ({ revision: mutation.sequence }),
      );
    }
    if (visible && message.kind === "assistant") {
      const updated = await tx
        .updateTable("threads")
        .set({
          lastReplyMessageId: messageId,
          lastReplyPreview: utf8Prefix(view.preview ?? "", 1120),
        })
        .where("id", "=", message.threadId)
        .where(
          sql<boolean>`last_reply_message_id is null or last_reply_message_id = ${messageId}
          or not exists (select 1 from messages where id = last_reply_message_id and sequence > ${message.sequence}::bigint)`,
        )
        .executeTakeFirst();
      if (updated.numUpdatedRows) await publishThreadSummary(tx, message.threadId);
    }
  });
}

export async function publishThreadCard(
  tx: PersonalMutationTransaction,
  mutation: PersonalMutation,
  card: Pick<
    Insertable<TranscriptItemTable>,
    "id" | "threadId" | "runId" | "kind" | "delegationId" | "appId" | "createdAt" | "view"
  >,
  move = false,
) {
  const old =
    mutation.transcriptPlacement(card.id) ??
    (await tx
      .selectFrom("transcriptItems")
      .select("position")
      .where("id", "=", card.id)
      .executeTakeFirst());
  const position =
    !move && old?.position ? old.position : await allocateTranscriptPosition(tx, card.threadId);
  if (move && old?.position) {
    await tx
      .updateTable("threads")
      .set({ transcriptOrderRevision: mutation.sequence })
      .where("id", "=", card.threadId)
      .execute();
    await invalidateThreadCollection(tx, card.threadId, "transcript-order");
  }
  mutation.stageTranscript(
    card.id,
    { position, visible: true, nodeId: null, isTurnStart: false },
    async () => {
      const item = await tx
        .insertInto("transcriptItems")
        .values({
          ...card,
          position,
          visible: true,
          revision: mutation.sequence,
          isTurnStart: false,
          attemptId: null,
          nodeId: null,
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            view: card.view,
            runId: card.runId,
            revision: mutation.sequence,
            position,
            ...(move ? { createdAt: card.createdAt } : {}),
            visible: true,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      mutation.change(
        {
          scopeKey: `thread:${card.threadId}`,
          entityKind: "item",
          entityId: card.id,
          operation: "upsert",
        },
        () => itemView(item),
      );
    },
  );
}
