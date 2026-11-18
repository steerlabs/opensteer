import { KeyedMutationQueue, MutationQueue } from "@opensteer/shared/mutationQueue";
import { messageDraftParts } from "./pending-send.js";
import type { UserId } from "@opensteer/core";
import type { HostClient, MessageEntry, TranscriptEntry } from "./client.js";
import { hostApi } from "@opensteer/protocol";
import type { PendingSendCommand } from "./pending-send.js";
import {
  clientScopeKey,
  type ClientScope,
  type ClientSession,
} from "../connections/connection-controller.js";
import {
  classifyClientFailure,
  ClientOperationError,
  unrefTimer,
} from "../connections/operation-error.js";
import type { ClientIssue } from "../feedback/client-issue.js";

export interface StoredMessage {
  readonly localId: string;
  readonly command: PendingSendCommand;
  readonly createdAt: string;
  readonly order: number;
  readonly attempted: boolean;
  readonly phase: "waiting" | "sending" | "rejected" | "restoring";
  readonly migrated?: true | undefined;
  readonly localAttachmentUris?: readonly (string | null)[] | undefined;
  readonly rejection?: ClientIssue | undefined;
}
export interface MessageOutboxStorage {
  load(scope: ClientScope): Promise<readonly StoredMessage[]>;
  put(
    scope: ClientScope,
    entry: StoredMessage,
    options?: { readonly migrated?: boolean; readonly handoff?: boolean },
  ): Promise<void>;
  replace?(
    scope: ClientScope,
    previous: StoredMessage,
    next: StoredMessage | null,
  ): Promise<boolean>;
  hasHandoff?(scope: ClientScope, id: string): Promise<boolean>;
  forgetHandoff?(scope: ClientScope, id: string): Promise<void>;
  remove(scope: ClientScope, localId: string): Promise<void>;
  delivery?<T>(scope: ClientScope, threadId: string, work: () => Promise<T>): Promise<T>;
  exclusive?<T>(scope: ClientScope, work: () => Promise<T>): Promise<T>;
  subscribe?(listener: () => void): () => void;
}
/**
 * Puts a taken-back message in its thread's durable draft, above any words
 * already there. "occupied" means the draft cannot hold both, so nothing changed.
 */
export interface MessageDraftRecovery {
  restore(scope: ClientScope, entry: StoredMessage): Promise<"restored" | "occupied">;
}
/** What Edit came to: back in the draft, no room in the draft, or already on its way. */
export type MessageTakeBack = "restored" | "occupied" | "sent";
export interface MessageOutboxSnapshot {
  readonly loading: boolean;
  readonly issue: ClientIssue | null;
  readonly messages: readonly StoredMessage[];
  readonly acknowledged: ReadonlyMap<string, string>;
}
export interface MessageOutbox {
  getSnapshot(): MessageOutboxSnapshot;
  subscribe(listener: () => void): () => void;
  enqueue(
    command: PendingSendCommand,
    options?: {
      readonly localAttachmentUris?: readonly (string | null)[];
      readonly handoff?: boolean;
    },
  ): Promise<string>;
  observe(messages: readonly { readonly id: string; readonly clientSendKey?: string }[]): void;
  retry(localId: string): Promise<"retried" | "settled">;
  hasHandoff(scope: ClientScope, id: string): Promise<boolean>;
  forgetHandoff(scope: ClientScope, id: string): Promise<void>;
  /** Edit: disable delivery durably before handing the message back to the draft. */
  restoreDraft(localId: string): Promise<MessageTakeBack>;
  discard(localId: string): Promise<void>;
  dispose(): void;
}
export interface MessageOutboxOptions {
  readonly legacy?: {
    load(scope: ClientScope): Promise<
      readonly (
        | StoredMessage
        | {
            readonly command: PendingSendCommand;
            readonly localAttachmentUris?: readonly (string | null)[];
          }
      )[]
    >;
    remove(scope: ClientScope, key: string): Promise<void>;
  };
  /** Housekeeping only: replay must never open permission or consent UI. */
  readonly onConfirmed?: (scope: ClientScope, entry: StoredMessage) => void | Promise<void>;
  readonly onDiscarded?: (scope: ClientScope, entry: StoredMessage) => void | Promise<void>;
  readonly prepare?: (command: PendingSendCommand) => PendingSendCommand;
  readonly session: ClientSession;
  readonly storage: MessageOutboxStorage;
  readonly drafts: MessageDraftRecovery;
  readonly dispatch: (command: PendingSendCommand) => Promise<{ readonly messageId: string }>;
}
/** A refusal, or a message never tried: nothing of it can be on the computer. */
function takeable(entry: StoredMessage): boolean {
  return (
    entry.phase === "restoring" ||
    (entry.phase === "rejected"
      ? entry.rejection?.code !== "unconfirmed"
      : entry.phase === "waiting" && !entry.attempted)
  );
}
export function compareOutboxOrder(a: StoredMessage, b: StoredMessage): number {
  return (
    Number(Boolean(b.migrated)) - Number(Boolean(a.migrated)) ||
    a.order - b.order ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.localId.localeCompare(b.localId)
  );
}
export function sameStoredMessage(a: StoredMessage, b: StoredMessage): boolean {
  return (
    a.localId === b.localId &&
    a.phase === b.phase &&
    a.attempted === b.attempted &&
    a.createdAt === b.createdAt &&
    a.order === b.order &&
    a.migrated === b.migrated &&
    a.rejection?.code === b.rejection?.code &&
    a.rejection?.reason === b.rejection?.reason &&
    JSON.stringify(a.localAttachmentUris) === JSON.stringify(b.localAttachmentUris) &&
    JSON.stringify(a.command) === JSON.stringify(b.command)
  );
}
function storageFailure(): ClientOperationError {
  return new ClientOperationError("The message could not be saved.", "blocked", {
    kind: "local",
    provenance: "local",
    reason: "storage-unavailable",
    retryable: false,
  });
}
export function createMessageOutbox(options: MessageOutboxOptions): MessageOutbox {
  return new SessionMessageOutbox(options);
}
class SessionMessageOutbox implements MessageOutbox {
  readonly #options: MessageOutboxOptions;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  readonly #storageRelease: (() => void) | undefined;
  #state: MessageOutboxSnapshot = {
    loading: false,
    issue: null,
    messages: [],
    acknowledged: new Map(),
  };
  #scope: ClientScope | null = null;
  #generation = 0;
  #disposed = false;
  readonly #writes = new MutationQueue();
  readonly #localDelivery = new KeyedMutationQueue();
  #loaded: Promise<void> = Promise.resolve();
  readonly #sending = new Map<string, string>();
  readonly #cancelled = new Set<string>();
  readonly #confirmed = new Set<string>();
  readonly #unwrittenRefusals = new Map<string, { previous: StoredMessage; next: StoredMessage }>();
  readonly #attempts = new Map<string, number>();
  readonly #retries = new Map<string, ReturnType<typeof setTimeout>>();
  #storageRetry: ReturnType<typeof setTimeout> | null = null;
  #storageAttempt = 0;
  #legacyPending = false;
  constructor(options: MessageOutboxOptions) {
    this.#options = options;
    this.#unsubscribe = options.session.connection.subscribe(() => this.#connection());
    this.#storageRelease = options.storage.subscribe?.(() => {
      void this.#reload();
    });
    this.#connection();
  }
  getSnapshot = (): MessageOutboxSnapshot => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #publish(patch: Partial<MessageOutboxSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    this.#listeners.forEach((fn) => fn());
  }
  #withDelivery<T>(scope: ClientScope, threadId: string, work: () => Promise<T>): Promise<T> {
    return (
      this.#options.storage.delivery?.(scope, threadId, work) ??
      this.#localDelivery.run(JSON.stringify([clientScopeKey(scope), threadId]), work)
    );
  }
  #current(scope: ClientScope, generation: number): boolean {
    return (
      !this.#disposed &&
      generation === this.#generation &&
      clientScopeKey(scope) === clientScopeKey(this.#scope)
    );
  }
  #ready(): boolean {
    const state = this.#options.session.connection.getSnapshot();
    return (
      !this.#disposed &&
      !this.#state.loading &&
      this.#state.issue?.code !== "storage-unavailable" &&
      state.phase === "ready" &&
      state.visibility === "foreground" &&
      state.network !== "offline" &&
      state.scope !== null &&
      clientScopeKey(state.scope) === clientScopeKey(this.#scope)
    );
  }
  #connection(): void {
    const state = this.#options.session.connection.getSnapshot();
    if (clientScopeKey(state.scope) !== clientScopeKey(this.#scope)) {
      this.#generation++;
      this.#scope = state.scope;
      this.#retries.forEach(clearTimeout);
      this.#retries.clear();
      this.#attempts.clear();
      if (this.#storageRetry) clearTimeout(this.#storageRetry);
      this.#storageRetry = null;
      this.#storageAttempt = 0;
      this.#legacyPending = false;
      this.#confirmed.clear();
      this.#unwrittenRefusals.clear();
      this.#cancelled.clear();
      this.#sending.clear();
      this.#publish({
        messages: [],
        acknowledged: new Map(),
        issue: null,
        loading: state.scope !== null,
      });
      this.#loaded = this.#reload();
    }
    if (!this.#ready()) {
      this.#retries.forEach(clearTimeout);
      this.#retries.clear();
      return;
    }
    this.#drain();
  }
  async #reload(): Promise<void> {
    const scope = this.#scope,
      generation = this.#generation;
    if (!scope || this.#disposed) return;
    try {
      let entries = await this.#options.storage.load(scope);
      const legacy = this.#options.legacy;
      let remaining = false;
      if (legacy) {
        const migrate = async () => {
          const held = await legacy.load(scope).catch(() => []);
          if (!held.length || !this.#current(scope, generation)) return;
          entries = await this.#options.storage.load(scope);
          const ordered = [...held].sort((a, b) =>
            "localId" in a && "localId" in b
              ? compareOutboxOrder(a, b)
              : Number("localId" in b) - Number("localId" in a),
          );
          for (const source of ordered) {
            const { command, localAttachmentUris } = source;
            if (!this.#current(scope, generation)) return;
            const localId = command.idempotencyKey;
            try {
              const entry: StoredMessage =
                "localId" in source
                  ? { ...source, migrated: true }
                  : {
                      localId,
                      command,
                      createdAt: new Date().toISOString(),
                      order: 0,
                      attempted: true,
                      phase: "rejected",
                      rejection: { code: "unconfirmed" },
                      migrated: true,
                      ...(localAttachmentUris ? { localAttachmentUris } : {}),
                    };
              await this.#options.storage.put(scope, entry, { migrated: true });
              await legacy.remove(scope, localId);
            } catch {
              // Keep the legacy record until its durable copy can be committed.
              remaining = true;
            }
          }
        };
        await this.#writes.run(
          () => this.#options.storage.exclusive?.(scope, migrate) ?? migrate(),
        );
        entries = await this.#options.storage.load(scope);
      }
      if (!this.#current(scope, generation)) return;
      this.#legacyPending = remaining;
      for (const [id, { previous, next }] of this.#unwrittenRefusals) {
        const index = entries.findIndex((row) => row.localId === id);
        if (index !== -1 && (await this.#replace(scope, previous, next))) {
          entries = entries.map((row, offset) => (offset === index ? next : row));
        }
        if (!this.#current(scope, generation)) return;
        this.#unwrittenRefusals.delete(id);
      }
      const heldRows = new Map(this.#state.messages.map((entry) => [entry.localId, entry]));
      const messages = entries
        .map((entry): StoredMessage => {
          const held = heldRows.get(entry.localId);
          const row: StoredMessage =
            entry.phase === "restoring" || entry.phase === "rejected"
              ? entry
              : {
                  ...entry,
                  phase:
                    this.#sending.get(entry.command.threadId) === entry.localId
                      ? "sending"
                      : "waiting",
                };
          return held && sameStoredMessage(held, row) ? held : row;
        })
        .sort(compareOutboxOrder);
      if (this.#storageRetry) clearTimeout(this.#storageRetry);
      this.#storageRetry = null;
      this.#storageAttempt = 0;
      this.#publish({ loading: false, messages, issue: null });
      this.#drain();
    } catch {
      if (this.#current(scope, generation)) {
        this.#publish({ loading: false, issue: { code: "storage-unavailable" } });
        this.#retryStorage();
      }
    }
  }
  enqueue = async (
    command: PendingSendCommand,
    options?: {
      readonly localAttachmentUris?: readonly (string | null)[];
      readonly handoff?: boolean;
    },
  ): Promise<string> => {
    const scope = this.#scope,
      generation = this.#generation;
    if (!scope) throw storageFailure();
    const parsed = hostApi["commands.dispatch"].payload.parse(
      this.#options.prepare?.(command) ?? command,
    );
    if (parsed.type !== "thread.sendMessage") throw storageFailure();
    await this.#loaded;
    if (this.#state.issue?.code === "storage-unavailable") {
      await this.#reload();
      if (this.#state.issue?.code === "storage-unavailable") throw storageFailure();
    }
    return this.#writes.run(async () => {
      if (!this.#current(scope, generation)) throw storageFailure();
      const save = async () => {
        if (options?.handoff && (await this.hasHandoff(scope, parsed.idempotencyKey))) return null;
        const entries = await this.#options.storage.load(scope);
        const previous = entries.find((entry) => entry.localId === parsed.idempotencyKey);
        if (previous) {
          if (JSON.stringify(previous.command) !== JSON.stringify(parsed)) throw storageFailure();
          if (options?.handoff) await this.#options.storage.put(scope, previous, { handoff: true });
          return previous;
        }
        if (
          entries.filter((entry) => entry.command.threadId === parsed.threadId).length >= 20 ||
          entries.length >= 48
        ) {
          this.#publish({ issue: { code: "queue-full" } });
          throw new ClientOperationError("Too many messages waiting.", "blocked", {
            kind: "local",
            reason: "queue-full",
            retryable: false,
          });
        }
        const entry: StoredMessage = {
          localId: parsed.idempotencyKey,
          command: parsed,
          createdAt: new Date().toISOString(),
          order: Math.max(0, ...entries.map((entry) => entry.order)) + 1,
          attempted: false,
          phase: "waiting",
          ...(options?.localAttachmentUris
            ? { localAttachmentUris: options.localAttachmentUris }
            : {}),
        };
        if (
          new TextEncoder().encode(JSON.stringify([...entries, entry])).byteLength >
          10 * 1024 * 1024
        )
          throw storageFailure();
        await this.#options.storage.put(
          scope,
          entry,
          options?.handoff ? { handoff: true } : undefined,
        );
        return entry;
      };
      let entry: StoredMessage | null;
      try {
        entry = await (this.#options.storage.exclusive?.(scope, save) ?? save());
      } catch (error) {
        if (this.#current(scope, generation))
          this.#publish({
            issue: {
              code:
                classifyClientFailure(error).reason === "queue-full"
                  ? "queue-full"
                  : "storage-unavailable",
            },
          });
        throw error;
      }
      if (entry && this.#current(scope, generation)) {
        this.#publish({
          messages: [
            ...this.#state.messages.filter((value) => value.localId !== entry.localId),
            entry,
          ].sort(compareOutboxOrder),
          issue: null,
        });
        queueMicrotask(() => this.#drain());
      }
      return parsed.idempotencyKey;
    });
  };
  observe = (
    messages: readonly { readonly id: string; readonly clientSendKey?: string }[],
  ): void => {
    const acknowledged = new Map(this.#state.acknowledged);
    let changed = false;
    for (const message of messages) {
      if (
        !message.clientSendKey ||
        this.#confirmed.has(message.clientSendKey) ||
        !this.#state.messages.some((entry) => entry.localId === message.clientSendKey)
      )
        continue;
      this.#confirmed.add(message.clientSendKey);
      acknowledged.set(message.id, message.clientSendKey);
      changed = true;
    }
    if (!changed) return;
    while (acknowledged.size > 256) acknowledged.delete(acknowledged.keys().next().value!);
    this.#publish({ acknowledged });
    this.#drain();
  };
  hasHandoff = (scope: ClientScope, id: string): Promise<boolean> =>
    this.#options.storage.hasHandoff?.(scope, id) ?? Promise.resolve(false);
  forgetHandoff = (scope: ClientScope, id: string): Promise<void> =>
    this.#options.storage.forgetHandoff?.(scope, id) ?? Promise.resolve();

  #replace(
    scope: ClientScope,
    previous: StoredMessage,
    next: StoredMessage | null,
  ): Promise<boolean> {
    return this.#writes.run(async () => {
      if (this.#options.storage.replace)
        return this.#options.storage.replace(scope, previous, next);
      const row = (await this.#options.storage.load(scope)).find(
        (entry) => entry.localId === previous.localId,
      );
      if (!row || !sameStoredMessage(row, previous)) return false;
      if (next) await this.#options.storage.put(scope, next);
      else await this.#options.storage.remove(scope, previous.localId);
      return true;
    });
  }
  retry = async (localId: string): Promise<"retried" | "settled"> => {
    const timer = this.#retries.get(localId);
    if (timer) clearTimeout(timer);
    this.#retries.delete(localId);
    this.#attempts.delete(localId);
    const scope = this.#scope,
      generation = this.#generation,
      entry = this.#state.messages.find((value) => value.localId === localId);
    if (!scope || !entry) return "settled";
    if (entry.phase === "rejected" && entry.rejection?.code === "unconfirmed") {
      const retry = async (): Promise<"retried" | "settled"> => {
        const current = (await this.#options.storage.load(scope)).find(
          (value) => value.localId === localId,
        );
        if (
          !this.#current(scope, generation) ||
          !current ||
          current.phase !== "rejected" ||
          current.rejection?.code !== "unconfirmed"
        )
          return "settled";
        const { rejection: _rejection, ...rest } = current;
        return (await this.#replace(scope, current, { ...rest, phase: "waiting", attempted: true }))
          ? "retried"
          : "settled";
      };
      const result = await this.#withDelivery(scope, entry.command.threadId, retry);
      if (this.#current(scope, generation)) await this.#reload();
      return result;
    }
    if (this.#state.issue?.code === "storage-unavailable") await this.#reload();
    else this.#drain();
    return "retried";
  };
  restoreDraft = async (localId: string): Promise<MessageTakeBack> => {
    const scope = this.#scope,
      generation = this.#generation,
      entry = this.#state.messages.find((value) => value.localId === localId);
    if (!scope || !entry || !takeable(entry)) return "sent";
    // Holds the head back from a dispatch claim while the draft is written.
    this.#cancelled.add(localId);
    const takeBack = async (): Promise<MessageTakeBack> => {
      const held = (await this.#options.storage.load(scope)).find(
        (value) => value.localId === localId,
      );
      if (!this.#current(scope, generation)) return "sent";
      if (!held || !takeable(held)) {
        await this.#reload();
        return "sent";
      }
      const restoring: StoredMessage = { ...held, phase: "restoring" };
      if (held.phase !== "restoring" && !(await this.#replace(scope, held, restoring))) {
        await this.#reload();
        return "sent";
      }
      if (!this.#current(scope, generation)) return "sent";
      this.#publish({
        messages: this.#state.messages.map((row) => (row.localId === localId ? restoring : row)),
      });
      if ((await this.#options.drafts.restore(scope, restoring)) === "occupied") {
        if (held.phase !== "restoring") {
          await this.#replace(scope, restoring, held);
          await this.#reload();
        }
        return "occupied";
      }
      await this.#remove(scope, generation, localId);
      return "restored";
    };
    try {
      return await this.#withDelivery(scope, entry.command.threadId, takeBack);
    } finally {
      this.#cancelled.delete(localId);
      if (this.#current(scope, generation)) this.#drain();
    }
  };
  discard = async (localId: string): Promise<void> => {
    const scope = this.#scope,
      generation = this.#generation,
      entry = this.#state.messages.find((value) => value.localId === localId);
    if (!scope || !entry) return;
    const unconfirmed = () =>
      new ClientOperationError("Delivery is unconfirmed.", "blocked", {
        kind: "local",
        reason: "message-unconfirmed",
        retryable: false,
      });
    if (!takeable(entry) || entry.phase === "restoring") throw unconfirmed();
    this.#cancelled.add(localId);
    const remove = async () => {
      const held = (await this.#options.storage.load(scope)).find(
        (value) => value.localId === localId,
      );
      if (!this.#current(scope, generation)) return;
      if (
        !held ||
        !takeable(held) ||
        held.phase === "restoring" ||
        !(await this.#replace(scope, held, null))
      ) {
        await this.#reload();
        throw unconfirmed();
      }
      await this.#removed(scope, generation, localId);
      this.#housekeeping(this.#options.onDiscarded, scope, held);
    };
    try {
      await this.#withDelivery(scope, entry.command.threadId, remove);
    } finally {
      this.#cancelled.delete(localId);
      if (this.#current(scope, generation)) this.#drain();
    }
  };
  async #remove(scope: ClientScope, generation: number, localId: string): Promise<void> {
    await this.#writes.run(() => this.#options.storage.remove(scope, localId));
    await this.#removed(scope, generation, localId);
  }
  async #removed(scope: ClientScope, generation: number, localId: string): Promise<void> {
    if (this.#current(scope, generation)) {
      this.#cancelled.delete(localId);
      this.#publish({
        messages: this.#state.messages.filter((entry) => entry.localId !== localId),
      });
      if (this.#legacyPending) await this.#reload();
      else this.#drain();
    }
  }
  #drain(): void {
    if (!this.#ready() || !this.#scope) return;
    const heads = new Map<string, StoredMessage>();
    for (const entry of this.#state.messages)
      if (!heads.has(entry.command.threadId)) heads.set(entry.command.threadId, entry);
    for (const [threadId, entry] of heads) {
      if (this.#sending.size >= 4) break;
      if (
        this.#cancelled.has(entry.localId) ||
        entry.phase === "restoring" ||
        (entry.phase === "rejected" && !this.#confirmed.has(entry.localId)) ||
        this.#sending.has(threadId) ||
        this.#retries.has(entry.localId)
      )
        continue;
      this.#sending.set(threadId, entry.localId);
      const scope = this.#scope,
        generation = this.#generation;
      const deliver = async () => {
        if (!this.#current(scope, generation) || !this.#ready()) return;
        const head = (await this.#options.storage.load(scope)).find(
          (row) => row.command.threadId === threadId,
        );
        if (!this.#current(scope, generation) || !this.#ready()) return;
        if (
          head?.localId !== entry.localId ||
          head.phase === "restoring" ||
          (head.phase === "rejected" && !this.#confirmed.has(head.localId))
        ) {
          await this.#reload();
          return;
        }
        await this.#deliver(scope, generation, head);
      };
      void this.#withDelivery(scope, threadId, deliver)
        .catch(() => {
          if (this.#current(scope, generation)) {
            this.#publish({ issue: { code: "storage-unavailable" } });
            this.#pause(entry);
          }
        })
        .finally(() => {
          if (this.#sending.get(threadId) === entry.localId) this.#sending.delete(threadId);
          this.#drain();
        });
    }
  }
  async #deliver(scope: ClientScope, generation: number, entry: StoredMessage): Promise<void> {
    if (this.#confirmed.has(entry.localId)) {
      await this.#remove(scope, generation, entry.localId);
      this.#confirmed.delete(entry.localId);
      this.#housekeeping(this.#options.onConfirmed, scope, entry);
      this.#housekeeping(this.#options.onDiscarded, scope, entry);
      return;
    }
    if (this.#cancelled.has(entry.localId)) return;
    const sending: StoredMessage = { ...entry, phase: "sending", attempted: true };
    try {
      if (!(await this.#replace(scope, entry, sending))) {
        await this.#reload();
        return;
      }
      if (!this.#current(scope, generation)) return;
      if (this.#cancelled.has(entry.localId)) {
        await this.#replace(scope, sending, entry);
        return;
      }
      if (!this.#state.messages.some((value) => value.localId === entry.localId)) return;
      this.#publish({
        messages: this.#state.messages.map((value) =>
          value.localId === entry.localId ? sending : value,
        ),
      });
      if (!this.#ready()) {
        this.#publish({
          messages: this.#state.messages.map((value) =>
            value.localId === entry.localId ? { ...sending, phase: "waiting" } : value,
          ),
        });
        return;
      }
      if (this.#cancelled.has(entry.localId)) {
        await this.#replace(scope, sending, entry);
        await this.#reload();
        return;
      }
      const acknowledgement = await this.#options.dispatch(sending.command);
      if (!this.#current(scope, generation)) return;
      this.#confirmed.add(entry.localId);
      const acknowledged = new Map(this.#state.acknowledged);
      acknowledged.set(acknowledgement.messageId, entry.localId);
      if (acknowledged.size > 256) acknowledged.delete(acknowledged.keys().next().value!);
      this.#publish({ acknowledged });
      await this.#remove(scope, generation, entry.localId);
      this.#attempts.delete(entry.localId);
      this.#confirmed.delete(entry.localId);
      this.#housekeeping(this.#options.onConfirmed, scope, entry);
      this.#housekeeping(this.#options.onDiscarded, scope, entry);
    } catch (error) {
      if (!this.#current(scope, generation)) return;
      const failure = classifyClientFailure(error);
      if (failure.kind === "rejection" && !failure.retryable) {
        const rejected: StoredMessage = {
          ...sending,
          phase: "rejected",
          rejection: { code: "rejected", reason: failure.reason },
        };
        try {
          if (!(await this.#replace(scope, sending, rejected))) {
            await this.#reload();
            return;
          }
        } catch {
          if (!this.#current(scope, generation)) return;
          this.#unwrittenRefusals.set(entry.localId, { previous: sending, next: rejected });
          this.#publish({
            issue: { code: "storage-unavailable" },
            messages: this.#state.messages.map((value) =>
              value.localId === entry.localId ? rejected : value,
            ),
          });
          this.#retryStorage();
          return;
        }
        if (!this.#current(scope, generation)) return;
        this.#publish({
          messages: this.#state.messages.map((value) =>
            value.localId === entry.localId ? rejected : value,
          ),
        });
        // Rejection blocks the thread until the person edits or deletes this head.
      } else {
        this.#publish({
          messages: this.#state.messages.map((value) =>
            value.localId === entry.localId ? { ...sending, phase: "waiting" } : value,
          ),
          ...(failure.provenance === "local"
            ? { issue: { code: "storage-unavailable" as const } }
            : {}),
        });
        this.#pause(entry);
      }
    }
  }
  #housekeeping(
    callback: MessageOutboxOptions["onConfirmed"],
    scope: ClientScope,
    entry: StoredMessage,
  ): void {
    if (callback)
      void Promise.resolve()
        .then(() => callback(scope, entry))
        .catch(() => {});
  }
  #retryStorage(): void {
    if (this.#disposed || this.#storageRetry || !this.#scope) return;
    this.#storageRetry = setTimeout(
      () => {
        this.#storageRetry = null;
        void this.#reload();
      },
      Math.min(12_000, 500 * 2 ** Math.min(this.#storageAttempt++, 5)),
    );
    unrefTimer(this.#storageRetry);
  }
  #pause(entry: StoredMessage): void {
    const attempt = this.#attempts.get(entry.localId) ?? 0;
    this.#attempts.set(entry.localId, attempt + 1);
    const timer = setTimeout(
      () => {
        this.#retries.delete(entry.localId);
        if (this.#state.issue?.code === "storage-unavailable") void this.#reload();
        else this.#drain();
      },
      Math.min(12_000, 500 * 2 ** Math.min(attempt, 10)),
    );
    this.#retries.set(entry.localId, timer);
    unrefTimer(timer);
  }
  dispose = (): void => {
    this.#disposed = true;
    this.#generation++;
    this.#unsubscribe();
    this.#storageRelease?.();
    if (this.#storageRetry) clearTimeout(this.#storageRetry);
    this.#retries.forEach(clearTimeout);
    this.#retries.clear();
    this.#listeners.clear();
  };
}

const hostOutboxes = new WeakMap<HostClient, MessageOutbox>();
export function initializeMessageOutbox(
  client: HostClient,
  ports: Omit<MessageOutboxOptions, "session" | "dispatch"> & { readonly session?: ClientSession },
): MessageOutbox {
  hostOutboxes.get(client)?.dispose();
  const outbox = createMessageOutbox({
    ...ports,
    session: ports.session ?? client,
    prepare: (command) => {
      const origin = client.messageOrigin?.();
      return command.origin || !origin ? command : { ...command, origin };
    },
    dispatch: async (command) => {
      const result = await client.dispatch(command, { preserveOrigin: true });
      if (result.type !== "thread.sendMessage")
        throw new ClientOperationError("Message acknowledgement was invalid.", "blocked", {
          kind: "protocol",
          provenance: "protocol",
          reason: "invalid-response",
          retryable: false,
        });
      return { messageId: result.message.id };
    },
  });
  const observe = () => {
    const scope = (ports.session ?? client).connection.getSnapshot().scope;
    const snapshot = client.getSnapshot();
    if (outbox.getSnapshot().messages.length === 0) return;
    if (
      !scope ||
      scope.viewerId !== snapshot.user?.id ||
      scope.deploymentId !== snapshot.deploymentId ||
      snapshot.session !== "authenticated"
    )
      return;
    outbox.observe(
      Object.values(snapshot.transcripts).flatMap((entries) =>
        entries.flatMap((entry) =>
          entry.kind === "message" &&
          entry.author.kind === "human" &&
          entry.author.userId === scope.viewerId &&
          entry.messageKind === "input"
            ? [entry]
            : [],
        ),
      ),
    );
  };
  const releaseHost = client.subscribe(observe),
    releaseOutbox = outbox.subscribe(observe);
  const dispose = outbox.dispose;
  outbox.dispose = () => {
    releaseHost();
    releaseOutbox();
    dispose();
  };
  hostOutboxes.set(client, outbox);
  return outbox;
}
export function hostMessageOutbox(client: HostClient): MessageOutbox | null {
  return hostOutboxes.get(client) ?? null;
}
export function disposeMessageOutbox(client: HostClient): void {
  hostOutboxes.get(client)?.dispose();
  hostOutboxes.delete(client);
}

export function projectMessageOutbox(
  state: MessageOutboxSnapshot,
  threadId: string,
  entries: readonly TranscriptEntry[],
  viewerId: UserId,
): readonly TranscriptEntry[] {
  const local = state.messages.filter((entry) => entry.command.threadId === threadId);
  const aliased = (entry: TranscriptEntry): string | undefined =>
    entry.kind === "message" ? state.acknowledged.get(entry.id) : undefined;
  // Another task's queue moving changes nothing here: the same array comes back.
  if (
    local.length === 0 &&
    (state.acknowledged.size === 0 || !entries.some((entry) => aliased(entry) !== undefined))
  )
    return entries;
  const confirmed = new Set(
    entries.flatMap((entry) =>
      entry.kind === "message" ? (entry.clientSendKey ?? aliased(entry) ?? []) : [],
    ),
  );
  let changed = false;
  const projected = entries.map((entry) => {
    const key = aliased(entry);
    if (entry.kind !== "message" || key === undefined || entry.clientSendKey === key) return entry;
    changed = true;
    const held = aliasRows.get(entry);
    if (held?.clientSendKey === key) return held;
    const row = { ...entry, clientSendKey: key };
    aliasRows.set(entry, row);
    return row;
  });
  const pending = local
    .filter((entry) => !confirmed.has(entry.localId))
    .map((entry) => localRow(entry, viewerId));
  return pending.length === 0 && !changed ? entries : [...projected, ...pending];
}

// Rows are rebuilt only when what they show changes, so a row that did not change keeps
// its identity and the transcript beneath it declines to redraw.
const aliasRows = new WeakMap<TranscriptEntry, MessageEntry>();
const localRows = new WeakMap<StoredMessage, MessageEntry>();
function localRow(entry: StoredMessage, viewerId: UserId): MessageEntry {
  const held = localRows.get(entry);
  if (held?.author.kind === "human" && held.author.userId === viewerId) return held;
  const parts = messageDraftParts(entry.command.content);
  const row: MessageEntry = {
    kind: "message",
    id: entry.localId,
    clientSendKey: entry.localId,
    createdAt: entry.createdAt,
    messageKind: "input",
    runId: null,
    policy: entry.command.delivery ?? "queue",
    body: parts.body,
    attachments: parts.attachments,
    pages: parts.places.filter((part) => part.type === "browser-page"),
    places: parts.places.filter((part) => part.type === "computer-app" || part.type === "phone"),
    author: { kind: "human", userId: viewerId, principalId: viewerId, displayName: "You" },
    localDelivery: {
      phase: entry.phase,
      attempted: entry.attempted,
      ...(entry.phase !== "restoring" && entry.rejection ? { issue: entry.rejection } : {}),
    },
  };
  localRows.set(entry, row);
  return row;
}

/**
 * The previous projection when every row in the next one is the same object, so a
 * subscriber to the whole outbox redraws only for a change to its own task.
 */
export function sameTranscript(
  previous: readonly TranscriptEntry[] | null,
  next: readonly TranscriptEntry[],
): readonly TranscriptEntry[] {
  return previous !== null &&
    previous.length === next.length &&
    previous.every((entry, index) => entry === next[index])
    ? previous
    : next;
}
