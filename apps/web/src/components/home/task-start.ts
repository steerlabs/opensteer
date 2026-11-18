/*
 * A Home draft keeps its generation through edits, even when empty. Start binds that
 * generation to the login and durably reserves one creation key and one send key.
 * Reopen or a lost creation reply replays the same creation. The Host's reply binds
 * the task ID. Until enqueue commits, Start can use revised words with that binding.
 * The outbox atomically appends the first message and records its receipt. A later
 * Start seeing that receipt finishes the handoff even if the window that sent it closed.
 * Matching words open the task. Revised words and files stay under a fresh generation.
 * Explicit discard or completion retires the binding and then its receipt. A replacement
 * login cannot resume a bound start. An unbound old draft requires explicit Resume.
 */
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
    replayed: z.literal(true).optional(),
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
          if ("completedThreadId" in held || held.start.threadId || held.replayed)
            return [held, held];
          const replay = { ...held, replayed: true as const };
          return [replay, replay];
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
        if (held.start.threadId !== undefined) return [held, held];
        const record = { generation, start: { ...held.start, threadId } };
        return [record, record];
      }),
    refuse: (expected: TaskStart) =>
      edit((held) => {
        if (
          held?.generation === generation &&
          "start" in held &&
          !held.start.threadId &&
          !held.replayed &&
          held.start.creation.idempotencyKey === expected.creation.idempotencyKey
        )
          return [null, undefined];
        return [held, undefined];
      }),
  };
}

export async function startTask(input: {
  readonly records: ReturnType<typeof draftTaskStart>;
  readonly creation: Omit<TaskStart["creation"], "idempotencyKey"> | null;
  readonly creationKey: () => string;
  readonly message: z.input<typeof TaskStartMessageSchema>;
  readonly messageKey: string;
  readonly legacyStart?: TaskStart | undefined;
  readonly confirmLegacy?: boolean;
  readonly assertCurrent: () => void;
  readonly createThread: (creation: CreateThreadInput) => Promise<{ readonly id: string }>;
  readonly enqueue: (command: PendingSendCommand) => Promise<unknown>;
  readonly hasLegacyHandoff?: (key: string) => Promise<boolean>;
}): Promise<{ readonly id: string; readonly preserveDraft?: true }> {
  const message = TaskStartMessageSchema.parse(input.message);
  const serialized = JSON.stringify(message);
  const completed = (record: CompletedStart) => ({
    id: record.completedThreadId,
    ...(record.fingerprint !== messageStorageFingerprint(serialized)
      ? { preserveDraft: true as const }
      : {}),
  });
  const record = await input.records.claim(() => {
    if (input.legacyStart) {
      if (!input.confirmLegacy) throw changedTaskDraft();
      return input.legacyStart;
    }
    if (input.creation === null) throw changedTaskDraft();
    return {
      creation: { ...input.creation, idempotencyKey: input.creationKey() },
      messageKey: input.messageKey,
    };
  }, input.assertCurrent);
  input.assertCurrent();
  if ("completedThreadId" in record) return completed(record);
  const { start } = record;
  let threadId = start.threadId;
  if (threadId === undefined) {
    try {
      threadId = (await input.createThread(start.creation)).id;
    } catch (error) {
      const failure = classifyClientFailure(error);
      if (failure.kind === "rejection" && !failure.retryable) await input.records.refuse(start);
      throw error;
    }
    const created = await input.records.created(start, threadId, input.assertCurrent);
    if ("completedThreadId" in created) return completed(created);
    threadId = created.start.threadId!;
  }
  input.assertCurrent();
  const { content, compaction, quotedMessageId } = message;
  // String receipts from the older journal format used the saved payload.
  if (start.message && (await input.hasLegacyHandoff?.(start.messageKey))) {
    input.assertCurrent();
    return {
      id: threadId,
      ...(JSON.stringify(start.message) !== serialized ? { preserveDraft: true as const } : {}),
    };
  }
  try {
    await input.enqueue({
      content,
      ...(compaction ? { compaction } : {}),
      ...(quotedMessageId ? { quotedMessageId } : {}),
      type: "thread.sendMessage",
      delivery: "queue",
      threadId,
      idempotencyKey: start.messageKey,
    });
    return { id: threadId };
  } catch (error) {
    // The receipt lives in the same transaction as the first message, so a
    // mismatch is evidence of a completed handoff for an earlier revision.
    if (classifyClientFailure(error).reason === "draft-changed")
      return { id: threadId, preserveDraft: true };
    throw error;
  }
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

export async function heldTaskStart(scopeKey: string, draftKey: string, generation: string) {
  const records = browserMessageRecords({ notify: false });
  const key = `task-start:${JSON.stringify([scopeKey, draftKey])}`;
  const record = readStart(await records.read(key));
  return record?.generation === generation && !("retiredMessageKey" in record);
}

export async function belongsToPreviousLogin(
  scopeKey: string,
  draftKey: string,
  generation: string,
) {
  const records = browserMessageRecords({ notify: false });
  for (const key of await browserTaskStartKeys()) {
    const [owner, draft] = JournalKeySchema.parse(JSON.parse(key.slice("task-start:".length)));
    if (draft !== draftKey || JSON.stringify(owner) === scopeKey) continue;
    if (readStart(await records.read(key))?.generation === generation) return true;
  }
  return false;
}

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
      retiredUnkeyed: Map<string, string>;
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
      retiredUnkeyed: new Map<string, string>(),
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
        if (onlyDraft === undefined) legacy.retiredUnkeyed.set(key, record.generation);
        else sweepLegacy = true;
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
    for (const { scope, active, hasUnkeyedStart, retiredUnkeyed } of legacyByScope.values()) {
      if (!hasUnkeyedStart) await storage.forgetLegacyHandoffs?.(scope, active);
      for (const [key, generation] of retiredUnkeyed) {
        await mutateBrowserMessageRecord(key, (raw) => {
          const held = readStart(raw);
          return held?.generation === generation && "completedThreadId" in held && !held.messageKey
            ? null
            : raw;
        });
      }
    }
  }
  return undo;
}
