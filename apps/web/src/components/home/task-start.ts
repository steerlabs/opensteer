import { z } from "zod";
import {
  CompactionSendChoiceSchema,
  MessageContentSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import { classifyClientFailure } from "@opensteer/client/connections";
import type { CreateThreadInput, PendingSendCommand } from "@opensteer/client/host";
import { mutateBrowserMessageRecord } from "../../host/message-outbox-records.js";
import { storageUnavailable } from "../../host/message-outbox.js";

const TaskStartSchema = z.strictObject({
  creation: z.strictObject({
    accessMode: ThreadAccessModeSchema,
    environmentId: z.string().min(1).max(200),
    generateTitle: z.literal(true),
    harnessInstanceId: z.string().min(1).max(200),
    idempotencyKey: z.string().min(1).max(200),
    modelSelection: ModelSelectionSchema,
    title: z.string().max(240),
  }),
  message: z.strictObject({
    content: MessageContentSchema,
    compaction: CompactionSendChoiceSchema.optional(),
    quotedMessageId: z.string().min(1).max(200).optional(),
  }),
  messageKey: z.string().min(1).max(255),
  threadId: z.string().min(1).max(200).optional(),
});
type TaskStart = z.infer<typeof TaskStartSchema>;
const TaskStartRecordSchema = z.union([
  z.strictObject({ generation: z.string(), start: TaskStartSchema }),
  z.strictObject({ generation: z.string(), completedThreadId: z.string() }),
]);
type TaskStartRecord = z.infer<typeof TaskStartRecordSchema>;

export function draftTaskStart(
  draftKey: string,
  generation: string,
  mutate: (
    key: string,
    change: (raw: string | null) => string | null,
  ) => Promise<unknown> = mutateBrowserMessageRecord,
) {
  const edit = async <T>(change: (held: TaskStartRecord | null) => [TaskStartRecord | null, T]) => {
    let result!: T;
    try {
      await mutate(`task-start:${draftKey}`, (raw) => {
        const held = raw === null ? null : TaskStartRecordSchema.parse(JSON.parse(raw));
        const [next, value] = change(held);
        result = value;
        return next === held ? raw : next ? JSON.stringify(next) : null;
      });
    } catch {
      throw storageUnavailable();
    }
    return result;
  };
  return {
    claim: (candidate: () => z.input<typeof TaskStartSchema>) =>
      edit((held) => {
        const record =
          held?.generation === generation
            ? held
            : { generation, start: TaskStartSchema.parse(candidate()) };
        return [record, record];
      }),
    created: (expected: TaskStart, threadId: string) =>
      edit((held) => {
        if (
          held?.generation !== generation ||
          !("start" in held) ||
          held.start.creation.idempotencyKey !== expected.creation.idempotencyKey
        )
          return [held, false];
        return [{ generation, start: { ...held.start, threadId } }, true];
      }),
    finish: (expected: TaskStart, threadId?: string) =>
      edit((held) =>
        held?.generation === generation &&
        "start" in held &&
        held.start.creation.idempotencyKey === expected.creation.idempotencyKey
          ? [threadId ? { generation, completedThreadId: threadId } : null, true]
          : [held, false],
      ),
  };
}

export async function startTask(input: {
  readonly records: ReturnType<typeof draftTaskStart>;
  readonly creation: Omit<TaskStart["creation"], "idempotencyKey">;
  readonly creationKey: () => string;
  readonly message: z.input<typeof TaskStartSchema>["message"];
  readonly messageKey: string;
  readonly assertCurrent: () => void;
  readonly createThread: (creation: CreateThreadInput) => Promise<{ readonly id: string }>;
  readonly enqueue: (command: PendingSendCommand) => Promise<unknown>;
}): Promise<{ readonly id: string }> {
  const record = await input.records.claim(() => ({
    creation: { ...input.creation, idempotencyKey: input.creationKey() },
    message: input.message,
    messageKey: input.messageKey,
  }));
  input.assertCurrent();
  if ("completedThreadId" in record) return { id: record.completedThreadId };
  const { start } = record;
  let threadId = start.threadId;
  if (threadId === undefined) {
    try {
      threadId = (await input.createThread(start.creation)).id;
    } catch (error) {
      const failure = classifyClientFailure(error);
      if (failure.kind === "rejection" && !failure.retryable) await input.records.finish(start);
      throw error;
    }
    // Another window may have finished the handoff while this answer was in transit.
    if (!(await input.records.created(start, threadId))) return { id: threadId };
  }
  input.assertCurrent();
  const { content, compaction, quotedMessageId } = start.message;
  await input.enqueue({
    content,
    ...(compaction ? { compaction } : {}),
    ...(quotedMessageId ? { quotedMessageId } : {}),
    type: "thread.sendMessage",
    delivery: "queue",
    threadId,
    idempotencyKey: start.messageKey,
  });
  await input.records.finish(start, threadId);
  return { id: threadId };
}
