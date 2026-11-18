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
    migrated: z.literal(true).optional(),
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
  entries: z.array(entrySchema).max(48),
  migrated: z.array(z.string().min(1).max(255)).optional(),
  handoffs: z.array(z.string().min(1).max(255)).optional(),
});

export interface MessageRecordStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  exclusive?<T>(key: string, work: () => Promise<T>): Promise<T>;
  mutate?(key: string, change: (raw: string | null) => string | null): Promise<void>;
  subscribe?(listener: () => void): () => void;
}
export function createMessageOutboxStorage(records: MessageRecordStorage): MessageOutboxStorage {
  const key = (scope: ClientScope) =>
    `message-outbox-v1-${bytesToHex(sha256(new TextEncoder().encode(clientScopeKey(scope)!)))}`;
  let writes: Promise<void> = Promise.resolve();
  type Record = {
    entries: StoredMessage[];
    migrated?: string[] | undefined;
    handoffs?: string[] | undefined;
  };
  const parse = (scope: ClientScope, raw: string | null): Record => {
    if (raw === null) return { entries: [] };
    if (new TextEncoder().encode(raw).byteLength > 10 * 1024 * 1024)
      throw new Error("Message storage exceeds its bound.");
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
    };
  };
  const load = async (scope: ClientScope): Promise<readonly StoredMessage[]> =>
    parse(scope, await records.read(key(scope))).entries;
  const update = (scope: ClientScope, change: (record: Record) => boolean): Promise<void> => {
    const edit = (raw: string | null): string | null => {
      const record = parse(scope, raw);
      if (!change(record)) return raw;
      if (!record.entries.length && !record.migrated?.length && !record.handoffs?.length)
        return null;
      const value = JSON.stringify(
        recordSchema.parse({ ...record, version: 1, scope: clientScopeKey(scope) }),
      );
      if (new TextEncoder().encode(value).byteLength > 10 * 1024 * 1024)
        throw new Error("Message storage exceeds its bound.");
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
  const put = (
    scope: ClientScope,
    entry: StoredMessage,
    options?: { readonly migrated?: boolean; readonly handoff?: boolean },
  ) =>
    update(scope, (record) => {
      const { entries } = record;
      if (options?.migrated && record.migrated?.includes(entry.localId)) return false;
      if (options?.handoff && record.handoffs?.includes(entry.localId)) return false;
      const exists = entries.some((row) => row.localId === entry.localId);
      if (
        !exists &&
        (entries.length >= 48 ||
          entries.filter((row) => row.command.threadId === entry.command.threadId).length >= 20)
      )
        throw new ClientOperationError("Too many messages waiting.", "blocked", {
          kind: "local",
          reason: "queue-full",
          retryable: false,
        });
      if (!exists || !options?.migrated)
        record.entries = [...entries.filter((row) => row.localId !== entry.localId), entry].sort(
          compareOutboxOrder,
        );
      if (options?.migrated) (record.migrated ??= []).push(entry.localId);
      if (options?.handoff) (record.handoffs ??= []).push(entry.localId);
      return true;
    });
  return {
    load,
    put,
    async hasHandoff(scope, id) {
      return parse(scope, await records.read(key(scope))).handoffs?.includes(id) ?? false;
    },
    forgetHandoff: (scope, id) =>
      update(scope, (record) => {
        if (!record.handoffs?.includes(id)) return false;
        record.handoffs = record.handoffs.filter((held) => held !== id);
        return true;
      }),
    async replace(scope, previous, next) {
      let replaced = false;
      await update(scope, (record) => {
        const index = record.entries.findIndex((row) => row.localId === previous.localId);
        if (index === -1 || !sameStoredMessage(record.entries[index]!, previous)) return false;
        if (next) record.entries[index] = next;
        else record.entries.splice(index, 1);
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
