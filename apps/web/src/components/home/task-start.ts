import { z } from "zod";
import { ModelSelectionSchema, ThreadAccessModeSchema } from "@opensteer/core";
import { classifyClientFailure } from "@opensteer/client/connections";
import type { CreateThreadInput } from "@opensteer/client/host";
import type { createComposerDraftStore } from "../composer-drafts.js";

/**
 * A new task being started from one draft: the creation command frozen under
 * its own key, the first message's key, and the task once the Host confirmed
 * it. Kept with the draft, so a retry after a lost answer, a failed local
 * write or a reload repeats the same creation, or skips it, and never makes a
 * second task.
 */
export const TaskStartSchema = z.strictObject({
  creation: z.strictObject({
    accessMode: ThreadAccessModeSchema,
    environmentId: z.string().min(1).max(200),
    generateTitle: z.literal(true),
    harnessInstanceId: z.string().min(1).max(200),
    idempotencyKey: z.string().min(1).max(200),
    modelSelection: ModelSelectionSchema,
    title: z.string().max(240),
  }),
  messageKey: z.string().min(1).max(255),
  threadId: z.string().min(1).max(200).optional(),
});
export type TaskStart = z.infer<typeof TaskStartSchema>;

export interface TaskStartRecords {
  read(): TaskStart | undefined;
  write(start: TaskStart | undefined): void;
}

/** The start kept in a draft: it survives a reload, and goes with the draft. */
export function draftTaskStart(
  drafts: Pick<ReturnType<typeof createComposerDraftStore>, "read" | "update">,
  draftKey: string,
): TaskStartRecords {
  return {
    read: () => drafts.read(draftKey)?.start,
    write: (start) => void drafts.update(draftKey, { start }),
  };
}

/**
 * Makes the task once and hands it its first message. Answers with the task.
 * The record goes when the message is queued, or when the Host definitively
 * refused the creation: then nothing was made, and the next try is a new start.
 */
export async function startTask(input: {
  readonly records: TaskStartRecords;
  /** What this attempt would create, used only when no start is held. */
  readonly creation: Omit<TaskStart["creation"], "idempotencyKey">;
  readonly creationKey: () => string;
  readonly messageKey: string;
  readonly createThread: (creation: CreateThreadInput) => Promise<{ readonly id: string }>;
  /** Whether the outbox already holds this message, so it is not queued twice. */
  readonly queued: (messageKey: string) => boolean;
  readonly enqueue: (threadId: string, messageKey: string) => Promise<unknown>;
}): Promise<{ readonly id: string }> {
  const start: TaskStart = input.records.read() ?? {
    creation: { ...input.creation, idempotencyKey: input.creationKey() },
    messageKey: input.messageKey,
  };
  input.records.write(start);
  let threadId = start.threadId;
  if (threadId === undefined) {
    try {
      threadId = (await input.createThread(start.creation)).id;
    } catch (error) {
      const failure = classifyClientFailure(error);
      if (failure.kind === "rejection" && !failure.retryable) input.records.write(undefined);
      throw error;
    }
    input.records.write({ ...start, threadId });
  }
  if (!input.queued(start.messageKey)) await input.enqueue(threadId, start.messageKey);
  input.records.write(undefined);
  return { id: threadId };
}
