import { ClientOperationError } from "../connections/operation-error.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import { hostApi } from "@opensteer/protocol";
import { clientScopeKey, type ClientScope } from "../connections/connection-controller.js";
import type { MessageOutboxStorage, StoredMessage } from "./message-outbox.js";

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
    phase: z.enum(["waiting", "sending", "rejected"]),
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
  const parse = (scope: ClientScope, raw: string | null): readonly StoredMessage[] => {
    if (raw === null) return [];
    if (new TextEncoder().encode(raw).byteLength > 10 * 1024 * 1024)
      throw new Error("Message storage exceeds its bound.");
    const record = recordSchema.parse(JSON.parse(raw));
    if (record.scope !== clientScopeKey(scope))
      throw new Error("Message storage belongs to another login.");
    return record.entries.map(({ rejection, ...entry }) => ({
      ...entry,
      ...(rejection
        ? {
            rejection: {
              code: rejection.code,
              ...(rejection.reason ? { reason: rejection.reason } : {}),
            },
          }
        : {}),
    }));
  };
  const load = async (scope: ClientScope): Promise<readonly StoredMessage[]> =>
    parse(scope, await records.read(key(scope)));
  const update = (
    scope: ClientScope,
    change: (entries: readonly StoredMessage[]) => readonly StoredMessage[],
  ): Promise<void> => {
    const edit = (raw: string | null): string | null => {
      const entries = change(parse(scope, raw));
      if (!entries.length) return null;
      const value = JSON.stringify(
        recordSchema.parse({ version: 1, scope: clientScopeKey(scope), entries }),
      );
      if (new TextEncoder().encode(value).byteLength > 10 * 1024 * 1024)
        throw new Error("Message storage exceeds its bound.");
      return value;
    };
    const work = async () => {
      if (records.mutate) return records.mutate(key(scope), edit);
      const write = async () => {
        const value = edit(await records.read(key(scope)));
        if (value === null) await records.remove(key(scope));
        else await records.write(key(scope), value);
      };
      await (records.exclusive?.(`${key(scope)}:write`, write) ?? write());
    };
    const pending = writes.catch(() => {}).then(work);
    writes = pending;
    return pending;
  };
  return {
    load,
    put: (scope, entry) =>
      update(scope, (entries) => {
        if (
          !entries.some((row) => row.localId === entry.localId) &&
          (entries.length >= 48 ||
            entries.filter((row) => row.command.threadId === entry.command.threadId).length >= 20)
        )
          throw new ClientOperationError("Too many messages waiting.", "blocked", {
            kind: "local",
            reason: "queue-full",
            retryable: false,
          });
        return [...entries.filter((row) => row.localId !== entry.localId), entry].sort(
          (a, b) => a.order - b.order,
        );
      }),
    remove: (scope, id) => update(scope, (entries) => entries.filter((row) => row.localId !== id)),
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
