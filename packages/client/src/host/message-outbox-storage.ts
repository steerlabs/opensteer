import { ClientOperationError } from "../connections/operation-error.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import { hostApi } from "@opensteer/protocol";
import { clientScopeKey, type ClientScope } from "../connections/connection-controller.js";
import {
  compareOutboxOrder,
  sameStoredMessage,
  type MessageOutboxStorage,
  type MessageOutboxWrite,
  type StoredMessage,
} from "./message-outbox.js";

const entrySchema = z
  .object({
    localId: z.string().min(1).max(255),
    command: hostApi["commands.dispatch"].payload.refine(
      (command): command is Extract<typeof command, { type: "thread.sendMessage" }> =>
        command.type === "thread.sendMessage",
    ),
    createdAt: z.string().min(1).max(40),
    order: z.number().int().safe(),
    attempted: z.boolean(),
    attemptId: z.uuid().optional(),
    migrated: z.literal(true).optional(),
    inTranscript: z.literal(true).optional(),
    phase: z.enum(["waiting", "sending", "rejected", "restoring"]),
    localAttachmentUris: z.array(z.string().min(1).max(2048).nullable()).max(20).optional(),
    rejection: z
      .object({ code: z.enum(["rejected", "unconfirmed"]), reason: z.string().max(255).optional() })
      .optional(),
  })
  .refine(
    (entry) =>
      entry.localId === entry.command.idempotencyKey &&
      (entry.phase !== "rejected" || entry.rejection !== undefined) &&
      (entry.phase !== "sending" || entry.attempted),
  );
const recordSchema = z.object({
  version: z.literal(1),
  scope: z.string(),
  entries: z.array(entrySchema).max(96),
  takenBack: z.array(z.string().length(64)).optional(),
  migrated: z.array(z.string().min(1).max(255)).optional(),
  handoffs: z
    .array(
      z.union([
        z.string().min(1).max(255),
        z.tuple([z.string().min(1).max(255), z.string().length(64)]),
      ]),
    )
    .optional(),
});

export interface MessageRecordStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  exclusive?<T>(key: string, work: () => Promise<T>): Promise<T>;
  mutate?(key: string, change: (raw: string | null) => string | null): Promise<void>;
  subscribe?(listener: () => void): () => void;
}
export function changedTaskDraft(): ClientOperationError {
  return new ClientOperationError("The draft changed while the task was starting.", "blocked", {
    kind: "local",
    reason: "draft-changed",
    retryable: false,
  });
}

export function messageStorageFingerprint(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

export function createMessageOutboxStorage(records: MessageRecordStorage): MessageOutboxStorage {
  const key = (scope: ClientScope) =>
    `message-outbox-v1-${messageStorageFingerprint(clientScopeKey(scope)!)}`;
  const handoffId = (held: NonNullable<z.infer<typeof recordSchema>["handoffs"]>[number]) =>
    typeof held === "string" ? held : held[0];
  const payloadHash = ({
    content,
    threadId,
    delivery,
    quotedMessageId,
    compaction,
  }: StoredMessage["command"]) =>
    messageStorageFingerprint(
      JSON.stringify([content, threadId, delivery, quotedMessageId, compaction]),
    );
  const maxBytes = 10 * 1024 * 1024;
  const exceeds = (value: string, limit: number) =>
    new TextEncoder().encode(value).byteLength > limit;
  let writes: Promise<void> = Promise.resolve();
  type Record = {
    entries: StoredMessage[];
    migrated?: string[] | undefined;
    handoffs?: z.infer<typeof recordSchema>["handoffs"];
    takenBack?: string[] | undefined;
  };
  const checkHandoff = (
    record: Record,
    id: string,
    expected?: StoredMessage["command"] | "legacy",
  ): boolean => {
    const held = record.handoffs?.find((receipt) => handoffId(receipt) === id);
    if (expected === "legacy") return typeof held === "string";
    if (!held) return false;
    if (expected && (typeof held === "string" || held[1] !== payloadHash(expected)))
      throw changedTaskDraft();
    return true;
  };
  const parse = (scope: ClientScope, raw: string | null): Record => {
    if (raw === null) return { entries: [] };
    if (exceeds(raw, 2 * maxBytes)) throw new Error("Message storage exceeds its bound.");
    const record = recordSchema.parse(JSON.parse(raw));
    if (record.scope !== clientScopeKey(scope))
      throw new Error("Message storage belongs to another login.");
    return {
      entries: record.entries.map(({ rejection, ...entry }) => ({
        ...entry,
        ...(rejection
          ? {
              rejection: {
                code: rejection.code,
                ...(rejection.reason ? { reason: rejection.reason } : {}),
              },
            }
          : {}),
      })),
      migrated: record.migrated,
      handoffs: record.handoffs,
      takenBack: record.takenBack,
    };
  };
  const load = async (scope: ClientScope): Promise<readonly StoredMessage[]> =>
    parse(scope, await records.read(key(scope))).entries;
  const update = (scope: ClientScope, change: (record: Record) => boolean): Promise<void> => {
    const edit = (raw: string | null): string | null => {
      const record = parse(scope, raw);
      if (!change(record)) return raw;
      if (
        !record.entries.length &&
        !record.migrated?.length &&
        !record.handoffs?.length &&
        !record.takenBack?.length
      )
        return null;
      const value = JSON.stringify(
        recordSchema.parse({ ...record, version: 1, scope: clientScopeKey(scope) }),
      );
      if (exceeds(value, 2 * maxBytes)) throw new Error("Message storage exceeds its bound.");
      return value;
    };
    const work = async () => {
      if (records.mutate) return records.mutate(key(scope), edit);
      const write = async () => {
        const previous = await records.read(key(scope));
        const value = edit(previous);
        if (value === previous) return;
        if (value === null) await records.remove(key(scope));
        else await records.write(key(scope), value);
      };
      await (records.exclusive?.(`${key(scope)}:write`, write) ?? write());
    };
    const pending = writes.catch(() => {}).then(work);
    writes = pending;
    return pending;
  };
  const put = async (
    scope: ClientScope,
    entry: StoredMessage,
    options?: MessageOutboxWrite,
  ): Promise<StoredMessage | null> => {
    let saved: StoredMessage | null = null;
    await update(scope, (record) => {
      const { entries } = record;
      options?.assertCurrent?.();
      if (options?.sourceExists?.() === false) return false;
      if (options?.migrated && record.migrated?.includes(entry.localId)) return false;
      if (
        options?.handoff &&
        checkHandoff(record, entry.localId, options.assertCurrent ? entry.command : undefined)
      )
        return false;
      if (record.takenBack?.includes(messageStorageFingerprint(entry.localId))) return false;
      const existing = entries.find((row) => row.localId === entry.localId);
      const lane = options?.migrated ? entries.filter((row) => row.migrated) : entries;
      if (
        !existing &&
        (lane.length >= 48 ||
          lane.filter((row) => row.command.threadId === entry.command.threadId).length >= 20)
      )
        throw new ClientOperationError("Too many messages waiting.", "blocked", {
          kind: "local",
          reason: "queue-full",
          retryable: false,
        });
      if (
        existing &&
        options?.append &&
        JSON.stringify(existing.command) !== JSON.stringify(entry.command)
      )
        throw new Error("The message key is already in use.");
      saved = options?.append
        ? (existing ?? { ...entry, order: Math.max(0, ...entries.map((row) => row.order)) + 1 })
        : options?.migrated && existing
          ? existing
          : entry;
      if (saved !== existing)
        record.entries = [...entries.filter((row) => row.localId !== entry.localId), saved].sort(
          compareOutboxOrder,
        );
      if (options?.append || options?.migrated) {
        const partition = record.entries.filter(
          (row) => Boolean(row.migrated) === Boolean(options.migrated),
        );
        if (exceeds(JSON.stringify(partition), maxBytes))
          throw new Error("Message storage exceeds its bound.");
      }
      if (options?.migrated) (record.migrated ??= []).push(entry.localId);
      if (options?.handoff)
        (record.handoffs ??= []).push([entry.localId, payloadHash(entry.command)]);
      return saved !== existing || options?.migrated === true || options?.handoff === true;
    });
    return saved;
  };
  return {
    load,
    put,
    async hasHandoff(scope, id, expected) {
      return checkHandoff(parse(scope, await records.read(key(scope))), id, expected);
    },
    forgetHandoff: (scope, id) =>
      update(scope, (record) => {
        if (!record.handoffs?.some((held) => handoffId(held) === id)) return false;
        record.handoffs = record.handoffs.filter((held) => handoffId(held) !== id);
        return true;
      }),
    forgetLegacyHandoffs: (scope, referenced) =>
      update(scope, (record) => {
        const receipts = record.handoffs ?? [];
        const kept = receipts.filter(
          (receipt) => typeof receipt !== "string" || referenced.has(receipt),
        );
        if (kept.length === receipts.length) return false;
        record.handoffs = kept;
        return true;
      }),
    forgetMigrations: (scope, sourceExists) =>
      update(scope, (record) => {
        const existing = record.migrated ?? [];
        const pending = existing.filter(sourceExists);
        if (pending.length === existing.length) return false;
        record.migrated = pending;
        return true;
      }),
    async dispatchIfPending(scope, entry, claim, start) {
      let dispatch = null;
      await update(scope, (record) => {
        const index = record.entries.findIndex(
          (row) => row.command.threadId === entry.command.threadId,
        );
        if (
          index === -1 ||
          !sameStoredMessage(record.entries[index]!, entry) ||
          record.takenBack?.includes(messageStorageFingerprint(entry.localId))
        )
          return false;
        const answer = start();
        if (!answer) return false;
        // The dispatch starts at the transaction's fence, before another window can take back.
        void answer.catch(() => {});
        dispatch = { answer };
        record.entries[index] = claim;
        return true;
      });
      return dispatch;
    },
    async replace(scope, previous, next, takeBack) {
      let replaced = false;
      await update(scope, (record) => {
        const index = record.entries.findIndex((row) => row.localId === previous.localId);
        if (index === -1 || !sameStoredMessage(record.entries[index]!, previous)) return false;
        if (next) record.entries[index] = next;
        else record.entries.splice(index, 1);
        if (takeBack) (record.takenBack ??= []).push(messageStorageFingerprint(previous.localId));
        replaced = true;
        return true;
      });
      return replaced;
    },
    remove: (scope, id) =>
      update(scope, (record) => {
        const index = record.entries.findIndex((row) => row.localId === id);
        if (index === -1) return false;
        record.entries.splice(index, 1);
        return true;
      }),
    ...(records.exclusive
      ? {
          delivery: <T>(scope: ClientScope, threadId: string, work: () => Promise<T>) =>
            records.exclusive!(`${key(scope)}:delivery:${threadId}`, work),
          exclusive: <T>(scope: ClientScope, work: () => Promise<T>) =>
            records.exclusive!(key(scope), work),
        }
      : {}),
    ...(records.subscribe ? { subscribe: records.subscribe } : {}),
  };
}
