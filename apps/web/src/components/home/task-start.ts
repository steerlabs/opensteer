import { z } from "zod";
import {
  CompactionSendChoiceSchema,
  MessageContentSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import { classifyClientFailure, type ClientScope } from "@opensteer/client/connections";
import {
  changedTaskDraft,
  createMessageOutboxStorage,
  messageStorageFingerprint,
  type CreateThreadInput,
  type PendingSendCommand,
} from "@opensteer/client/host";
import {
  browserMessageRecords,
  browserTaskStartKeys,
  mutateBrowserMessageRecord,
  storageUnavailable,
} from "../../host/message-outbox-records.js";

const TaskStartMessageSchema = z.strictObject({
  content: MessageContentSchema,
  compaction: CompactionSendChoiceSchema.optional(),
  quotedMessageId: z.string().min(1).max(200).optional(),
});
export const SavedTaskStartSchema = z.strictObject({
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
type TaskStart = z.infer<typeof SavedTaskStartSchema>;
const TaskStartRecordSchema = z.union([
  z.strictObject({
    generation: z.string(),
    start: SavedTaskStartSchema.extend({ message: TaskStartMessageSchema.optional() }),
  }),
  z.strictObject({
    generation: z.string(),
    completedThreadId: z.string(),
    messageKey: z.string().optional(),
    fingerprint: z.string().optional(),
  }),
  z.strictObject({ generation: z.string(), retiredMessageKey: z.string() }),
]);
type TaskStartRecord = z.infer<typeof TaskStartRecordSchema>;
type ActiveStart = Extract<TaskStartRecord, { start: TaskStart }>;
type CompletedStart = Extract<TaskStartRecord, { completedThreadId: string }>;

function readStart(raw: string | null): TaskStartRecord | null {
  return raw === null ? null : TaskStartRecordSchema.parse(JSON.parse(raw));
}

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
        const held = readStart(raw);
        const [next, value] = change(held);
        result = value;
        return next === held ? raw : next ? JSON.stringify(next) : null;
      });
    } catch (error) {
      if (classifyClientFailure(error).reason === "draft-changed") throw error;
      throw storageUnavailable();
    }
    return result;
  };
  return {
    claim: (candidate: () => TaskStart, assertCurrent: () => void) =>
      edit<ActiveStart | CompletedStart>((held) => {
        assertCurrent();
        if (held?.generation === generation) {
          if ("retiredMessageKey" in held) throw changedTaskDraft();
          return [held, held];
        }
        const record = { generation, start: SavedTaskStartSchema.parse(candidate()) };
        return [record, record];
      }),
    created: (expected: TaskStart, threadId: string, assertCurrent: () => void) =>
      edit<ActiveStart | CompletedStart>((held) => {
        assertCurrent();
        if (held?.generation !== generation || "retiredMessageKey" in held)
          throw changedTaskDraft();
        if ("completedThreadId" in held) return [held, held];
        if (held.start.creation.idempotencyKey !== expected.creation.idempotencyKey)
          throw changedTaskDraft();
        const record = { generation, start: { ...held.start, threadId } };
        return [record, record];
      }),
    finish: (expected: TaskStart, completion?: { threadId: string; fingerprint: string }) =>
      edit((held) => {
        if (held?.generation !== generation || "retiredMessageKey" in held)
          throw changedTaskDraft();
        if ("completedThreadId" in held) return [held, held];
        if (held.start.creation.idempotencyKey !== expected.creation.idempotencyKey)
          throw changedTaskDraft();
        const completed = completion
          ? {
              generation,
              completedThreadId: completion.threadId,
              messageKey: expected.messageKey,
              fingerprint: completion.fingerprint,
            }
          : null;
        return [completed, completed];
      }),
  };
}

export async function startTask(input: {
  readonly records: ReturnType<typeof draftTaskStart>;
  readonly creation: Omit<TaskStart["creation"], "idempotencyKey">;
  readonly creationKey: () => string;
  readonly message: z.input<typeof TaskStartMessageSchema>;
  readonly messageKey: string;
  readonly legacyStart?: TaskStart | undefined;
  readonly confirmLegacy?: boolean;
  readonly assertCurrent: () => void;
  readonly createThread: (creation: CreateThreadInput) => Promise<{ readonly id: string }>;
  readonly enqueue: (command: PendingSendCommand) => Promise<unknown>;
  readonly hasLegacyHandoff?: (key: string) => Promise<boolean>;
}): Promise<{ readonly id: string }> {
  const message = TaskStartMessageSchema.parse(input.message);
  const serialized = JSON.stringify(message);
  const fingerprint = messageStorageFingerprint(serialized);
  const completed = (record: CompletedStart) => {
    if (record.fingerprint !== fingerprint) throw changedTaskDraft();
    return { id: record.completedThreadId };
  };
  const record = await input.records.claim(() => {
    if (input.legacyStart) {
      if (!input.confirmLegacy) throw changedTaskDraft();
      return input.legacyStart;
    }
    return {
      creation: { ...input.creation, idempotencyKey: input.creationKey() },
      messageKey: input.messageKey,
    };
  }, input.assertCurrent);
  input.assertCurrent();
  if ("completedThreadId" in record) return completed(record);
  if (!("start" in record)) throw changedTaskDraft();
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
    const created = await input.records.created(start, threadId, input.assertCurrent);
    if ("completedThreadId" in created) return completed(created);
  }
  input.assertCurrent();
  const { content, compaction, quotedMessageId } = message;
  if (start.message && (await input.hasLegacyHandoff?.(start.messageKey))) {
    if (JSON.stringify(start.message) !== serialized) throw changedTaskDraft();
  } else {
    await input.enqueue({
      content,
      ...(compaction ? { compaction } : {}),
      ...(quotedMessageId ? { quotedMessageId } : {}),
      type: "thread.sendMessage",
      delivery: "queue",
      threadId,
      idempotencyKey: start.messageKey,
    });
  }
  const result = await input.records.finish(start, { threadId, fingerprint });
  if (result === null) throw changedTaskDraft();
  return completed(result);
}

const JournalKeySchema = z.tuple([
  z.string().transform((key, ctx) => {
    try {
      return ScopeKeySchema.parse(JSON.parse(key));
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid task journal scope." });
      return z.NEVER;
    }
  }),
  z.string(),
]);
const ScopeKeySchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string().nullable(),
]);

/** Once the source generation is gone, even a paused window can no longer enqueue it. */
export async function retireTaskStarts(
  activeGeneration: (draftKey: string) => string | undefined,
  onlyDraft?: string,
  discardedGeneration?: string,
): Promise<TaskStart | undefined> {
  if (typeof indexedDB === "undefined") return;
  let undo: TaskStart | undefined;
  let sweepLegacy = false;
  const legacyByScope = new Map<
    string,
    {
      scope: ClientScope;
      active: Set<string>;
      hasUnkeyedStart: boolean;
    }
  >();
  const storage = createMessageOutboxStorage(browserMessageRecords({ notify: false }));
  for (const key of await browserTaskStartKeys()) {
    const [scopeParts, draftKey] = JournalKeySchema.parse(
      JSON.parse(key.slice("task-start:".length)),
    );
    if (onlyDraft !== undefined && onlyDraft !== draftKey) continue;
    const [authorityKey, deploymentId, viewerId, loginId, accountLoginId] = scopeParts;
    const scope: ClientScope = {
      authorityKey,
      deploymentId,
      viewerId,
      loginId,
      ...(accountLoginId === null ? {} : { accountLoginId }),
    };
    const scopeKey = JSON.stringify(scopeParts);
    const legacy = legacyByScope.get(scopeKey) ?? {
      scope,
      active: new Set<string>(),
      hasUnkeyedStart: false,
    };
    legacyByScope.set(scopeKey, legacy);
    let retired: { generation: string; messageKey: string } | undefined;
    await mutateBrowserMessageRecord(key, (raw) => {
      const record = readStart(raw);
      if (!record) return raw;
      const messageKey =
        "start" in record
          ? record.start.messageKey
          : "retiredMessageKey" in record
            ? record.retiredMessageKey
            : record.messageKey;
      if (activeGeneration(draftKey) === record.generation) {
        if (messageKey) legacy.active.add(messageKey);
        else legacy.hasUnkeyedStart = true;
        return raw;
      }
      if ("start" in record && record.generation === discardedGeneration) {
        const { message: _message, ...identity } = record.start;
        undo = identity;
      }
      if (!messageKey) {
        // Old finished journals omitted the key. Sweep their scope with all live journals in view.
        if (onlyDraft === undefined) return null;
        sweepLegacy = true;
        return raw;
      }
      retired = { generation: record.generation, messageKey };
      return JSON.stringify({ generation: record.generation, retiredMessageKey: messageKey });
    });
    if (!retired) continue;
    const { generation, messageKey } = retired;
    await storage.forgetHandoff?.(scope, messageKey);
    await mutateBrowserMessageRecord(key, (raw) => {
      const held = readStart(raw);
      return held?.generation === generation && "retiredMessageKey" in held ? null : raw;
    });
  }
  if (sweepLegacy) await retireTaskStarts(activeGeneration);
  if (onlyDraft === undefined) {
    for (const { scope, active, hasUnkeyedStart } of legacyByScope.values())
      if (!hasUnkeyedStart) await storage.forgetLegacyHandoffs?.(scope, active);
  }
  return undo;
}
