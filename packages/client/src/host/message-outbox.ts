import type { ThreadViewSource } from "./scoped-thread-reader.js";
/*
 * One durable FIFO per task and login. Enqueue appends waiting. Browser drafts
 * record the consumed revision in the same commit, so discard and send have
 * one winner.
 * A dispatcher claims the head with an expiring lease before sending the frozen
 * command. If it never calls dispatch, it releases the lease. Transport loss or a
 * reclaimed lease leaves uncertainty about admission. Reload, reconnect and
 * expiry replay the same key.
 * An ack or matching Host event removes the row. Only the current lease can record a
 * refusal, and an earlier uncertain attempt makes that refusal unconfirmed. The person
 * can retry an unconfirmed refusal with the same key or remove its local copy.
 * The person can discard a never-attempted or definitely refused row, or fence it
 * as restoring before writing its draft. Edit retries that transfer after a crash,
 * or the person can remove the queue entry and keep any draft already saved.
 * Migration copies before retiring the source. Unbound legacy rows wait for a person.
 * A failed write leaves the prior owner in place, and local settlement is retried.
 * Login changes stop new dispatches and hide old rows. API 62 checks a bound
 * browser credential at admission. Late results settle their own scope.
 * Reply handoffs bind the revision to its login and keep a receipt through draft cleanup.
 */
import { MutationQueue } from "@opensteer/shared/mutationQueue";
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
import { threadStartsRunForMessage } from "./thread-activity.js";

export interface StoredMessage {
  readonly localId: string;
  readonly command: PendingSendCommand;
  readonly createdAt: string;
  readonly order: number;
  readonly attempted: boolean;
  readonly phase: "waiting" | "sending" | "rejected" | "restoring";
  readonly migrated?: true | undefined;
  readonly inTranscript?: true | undefined;
  readonly lease?: { readonly id: string; readonly expiresAt: number } | undefined;
  readonly uncertain?: true | undefined;
  readonly localAttachmentUris?: readonly (string | null)[] | undefined;
  readonly rejection?: ClientIssue | undefined;
}
export interface MessageOutboxWrite {
  readonly migrated?: boolean;
  readonly handoff?: boolean | "resume";
  readonly append?: boolean;
  readonly sourceExists?: () => boolean;
  readonly assertCurrent?: () => void;
  readonly consumedDraft?: ConsumedDraftRevision;
}

export interface ConsumedDraftRevision {
  readonly key: string;
  readonly revision: string;
}

export interface MessageOutboxStorage {
  load(scope: ClientScope): Promise<readonly StoredMessage[]>;
  put(
    scope: ClientScope,
    entry: StoredMessage,
    options?: MessageOutboxWrite,
  ): Promise<StoredMessage | null>;
  replace(
    scope: ClientScope,
    previous: StoredMessage,
    next: StoredMessage | null,
    takeBack?: boolean,
  ): Promise<boolean>;
  claim(
    scope: ClientScope,
    entry: StoredMessage,
    id: string,
    leaseMs: number,
    inTranscript: true | undefined,
    canStart: () => boolean,
  ): Promise<{
    readonly row: StoredMessage;
    settle(outcome: "not-started" | "uncertain" | ClientIssue): Promise<void>;
  } | null>;
  forgetMigrations?(scope: ClientScope, sourceExists: (id: string) => boolean): Promise<void>;
  hasHandoff?(
    scope: ClientScope,
    id: string,
    expected?: PendingSendCommand | "legacy",
  ): Promise<boolean>;
  forgetHandoff?(scope: ClientScope, id: string): Promise<void>;
  forgetLegacyHandoffs?(scope: ClientScope, referenced: ReadonlySet<string>): Promise<void>;
  remove(scope: ClientScope, localId: string): Promise<void>;
  exclusive?<T>(scope: ClientScope, work: () => Promise<T>): Promise<T>;
  subscribe?(listener: () => void): () => void;
}
/**
 * Puts a taken-back message in its thread's durable draft, above any words
 * already there. "occupied" means the draft cannot hold both, so nothing changed.
 */
export interface MessageDraftRecovery {
  restore(
    scope: ClientScope,
    entry: StoredMessage,
    isCurrent: () => boolean,
  ): Promise<"restored" | "occupied">;
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
      readonly handoff?: boolean | "resume";
      readonly expectedLogin?: ClientScope;
      readonly assertCurrent?: () => void;
      readonly consumedDraft?: ConsumedDraftRevision;
      /** Native draft ownership is committed in enqueue order, before the outbox write. */
      readonly bindDraft?: () => Promise<void>;
    },
  ): Promise<string>;
  observe(
    messages: readonly { readonly id: string; readonly clientSendKey?: string | undefined }[],
  ): void;
  retry(localId: string): Promise<"retried" | "settled">;
  hasHandoff(
    scope: ClientScope,
    id: string,
    expected?: PendingSendCommand | "legacy",
  ): Promise<boolean>;
  forgetHandoff(scope: ClientScope, id: string): Promise<void>;
  /** Edit: disable delivery durably before handing the message back to the draft. */
  restoreDraft(localId: string): Promise<MessageTakeBack>;
  discard(localId: string): Promise<void>;
  removeLocalCopy(localId: string): Promise<void>;
  dispose(): void;
}

export function assertMessageLogin(expected: ClientScope, current: ClientScope | null): void {
  if (clientScopeKey(expected) !== clientScopeKey(current))
    throw new ClientOperationError("This message belongs to another sign-in.", "blocked", {
      kind: "session",
      reason: "session-changed",
      retryable: false,
    });
}

function draftChanged(reason: string): boolean {
  return (
    reason === "draft-changed" ||
    reason === "draft-superseded" ||
    reason === "draft-previous-login" ||
    reason === "session-changed"
  );
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
    has?(scope: ClientScope, key: string): boolean;
  };
  /** Housekeeping only: replay must never open permission or consent UI. */
  readonly onConfirmed?: (scope: ClientScope, entry: StoredMessage) => void | Promise<void>;
  readonly onDiscarded?: (scope: ClientScope, entry: StoredMessage) => void | Promise<void>;
  readonly prepare?: (command: PendingSendCommand) => PendingSendCommand;
  readonly startsRun?: (threadId: string) => boolean;
  readonly session: ClientSession;
  readonly storage: MessageOutboxStorage;
  readonly drafts: MessageDraftRecovery;
  readonly dispatch: (
    command: PendingSendCommand,
    login: ClientScope,
  ) => Promise<{ readonly messageId: string }>;
}
/** A refusal, or a message never tried: nothing of it can be on the computer. */
function takeable(entry: StoredMessage): boolean {
  return (
    !entry.lease &&
    (entry.phase === "restoring" ||
      (entry.phase === "rejected"
        ? entry.rejection?.code !== "unconfirmed"
        : entry.phase === "waiting" && !entry.attempted))
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
    a.inTranscript === b.inTranscript &&
    a.rejection?.code === b.rejection?.code &&
    a.rejection?.reason === b.rejection?.reason &&
    a.lease?.id === b.lease?.id &&
    a.lease?.expiresAt === b.lease?.expiresAt &&
    a.uncertain === b.uncertain &&
    a.order === b.order &&
    a.migrated === b.migrated &&
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
const dispatchLeaseMs = 90_000;
type ActiveDelivery = {
  readonly key: string;
  readonly id: string;
  wake?: (() => void) | undefined;
};

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
  #loaded: Promise<void> = Promise.resolve();
  readonly #sending = new Map<string, ActiveDelivery>();
  readonly #confirmed = new Set<string>();
  readonly #takingBack = new Set<string>();
  readonly #pendingSettlements = new Map<string, () => Promise<unknown>>();
  readonly #attempts = new Map<string, number>();
  readonly #retries = new Map<string, ReturnType<typeof setTimeout>>();
  #storageRetry: ReturnType<typeof setTimeout> | null = null;
  #leaseWake: ReturnType<typeof setTimeout> | null = null;
  #storageAttempt = 0;
  #legacyPending = false;
  #legacyBlocked = new Map<string, StoredMessage>();
  #lastConnection: ReturnType<ClientSession["connection"]["getSnapshot"]> | undefined;
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
    const previous = this.#lastConnection;
    this.#lastConnection = state;
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
      this.#legacyBlocked.clear();
      this.#confirmed.clear();
      this.#takingBack.clear();
      this.#pendingSettlements.clear();
      this.#releaseDeliveries();
      this.#publish({
        messages: [],
        acknowledged: new Map(),
        issue: null,
        loading: state.scope !== null,
      });
      this.#loaded = this.#reload();
    } else if (
      state.scope &&
      ((state.visibility === "foreground" && previous?.visibility === "background") ||
        (state.phase === "ready" && state.readyRevision !== previous?.readyRevision))
    ) {
      this.#loaded = this.#reload();
      return;
    }
    if (!this.#ready()) {
      this.#clearLeaseWake();
      this.#retries.forEach(clearTimeout);
      this.#retries.clear();
      return;
    }
    this.#drain();
  }
  #reload(): Promise<void> {
    const scope = this.#scope;
    const generation = this.#generation;
    if (!scope || this.#disposed) return Promise.resolve();
    return this.#writes.run(() => this.#load(scope, generation));
  }

  async #load(scope: ClientScope, generation: number, migrate = true): Promise<void> {
    if (!this.#current(scope, generation)) return;
    try {
      const legacy = this.#options.legacy;
      let remaining = this.#legacyPending;
      const legacyBlocked = new Map(this.#legacyBlocked);
      if (legacy && migrate) {
        const importLegacy = async () => {
          const held = await legacy.load(scope);
          if (!this.#current(scope, generation)) return;
          remaining = false;
          legacyBlocked.clear();
          const present = new Set(held.map(({ command }) => command.idempotencyKey));
          const ordered = [...held].sort((a, b) =>
            "localId" in a && "localId" in b
              ? compareOutboxOrder(a, b)
              : Number("localId" in b) - Number("localId" in a),
          );
          for (const source of ordered) {
            const { command, localAttachmentUris } = source;
            if (!this.#current(scope, generation)) return;
            const localId = command.idempotencyKey;
            if (legacyBlocked.has(command.threadId)) continue;
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
            try {
              await this.#options.storage.put(scope, entry, {
                migrated: true,
                ...(legacy.has ? { sourceExists: () => legacy.has!(scope, localId) } : {}),
              });
            } catch {
              legacyBlocked.set(command.threadId, entry);
              remaining = true;
              continue;
            }
            try {
              await legacy.remove(scope, localId);
              present.delete(localId);
            } catch {
              remaining = true;
            }
          }
          await this.#options.storage.forgetMigrations?.(scope, (id) =>
            legacy.has ? legacy.has(scope, id) : present.has(id),
          );
        };
        await (this.#options.storage.exclusive?.(scope, importLegacy) ?? importLegacy());
      }
      if (!this.#current(scope, generation)) return;
      this.#legacyPending = remaining;
      this.#legacyBlocked = legacyBlocked;
      for (const [id, settle] of this.#pendingSettlements) {
        await settle();
        if (!this.#current(scope, generation)) return;
        this.#pendingSettlements.delete(id);
      }
      const entries = await this.#options.storage.load(scope);
      if (!this.#current(scope, generation)) return;
      if (remaining) this.#retryStorage();
      else {
        if (this.#storageRetry) clearTimeout(this.#storageRetry);
        this.#storageRetry = null;
        this.#storageAttempt = 0;
      }
      this.#publishRows(entries, { loading: false, issue: null });
      this.#drain();
    } catch {
      if (this.#current(scope, generation)) {
        this.#storageFailed();
      }
    }
  }
  #publishRows(entries: readonly StoredMessage[], patch?: Partial<MessageOutboxSnapshot>): void {
    const previous = new Map(this.#state.messages.map((entry) => [entry.localId, entry]));
    const messages = entries
      .map((entry) => {
        const owned = this.#sending.get(entry.command.threadId)?.id === entry.lease?.id;
        const row =
          entry.phase === "sending" && !owned ? { ...entry, phase: "waiting" as const } : entry;
        const held = previous.get(entry.localId);
        if (held && sameStoredMessage(held, row)) return held;
        return row;
      })
      .sort(compareOutboxOrder);
    this.#publish({ ...patch, messages });
  }

  enqueue: MessageOutbox["enqueue"] = async (command, options) => {
    const scope = this.#scope;
    const generation = this.#generation;
    if (options?.expectedLogin) assertMessageLogin(options.expectedLogin, scope);
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
      const entry: StoredMessage = {
        localId: parsed.idempotencyKey,
        command: parsed,
        createdAt: new Date().toISOString(),
        order: 0,
        attempted: false,
        phase: "waiting",
        ...(this.#options.startsRun?.(parsed.threadId) ? { inTranscript: true } : {}),
        ...(options?.localAttachmentUris
          ? { localAttachmentUris: options.localAttachmentUris }
          : {}),
      };
      const assertCurrent = () => {
        if (options?.expectedLogin) assertMessageLogin(options.expectedLogin, this.#scope);
        if (!this.#current(scope, generation)) throw storageFailure();
        options?.assertCurrent?.();
      };
      try {
        if (options?.bindDraft) {
          assertCurrent();
          await options.bindDraft();
        }
        const storage = this.#options.storage;
        const saved = await storage.put(scope, entry, {
          append: true,
          ...(options?.handoff ? { handoff: options.handoff } : {}),
          ...(options?.consumedDraft ? { consumedDraft: options.consumedDraft } : {}),
          assertCurrent,
        });
        if (saved && this.#current(scope, generation)) {
          this.#publishRows(
            [...this.#state.messages.filter((row) => row.localId !== saved.localId), saved],
            { issue: null },
          );
          this.#drain();
        }
      } catch (error) {
        const { reason } = classifyClientFailure(error);
        if (this.#current(scope, generation) && !draftChanged(reason)) {
          if (reason === "queue-full") this.#publish({ issue: { code: "queue-full" } });
          else this.#storageFailed();
        }
        throw error;
      }
      return parsed.idempotencyKey;
    });
  };
  observe = (
    messages: readonly { readonly id: string; readonly clientSendKey?: string | undefined }[],
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
  hasHandoff = (
    scope: ClientScope,
    id: string,
    expected?: PendingSendCommand | "legacy",
  ): Promise<boolean> =>
    this.#options.storage.hasHandoff?.(scope, id, expected) ?? Promise.resolve(false);
  forgetHandoff = (scope: ClientScope, id: string): Promise<void> =>
    this.#options.storage.forgetHandoff?.(scope, id) ?? Promise.resolve();

  retry = async (localId: string): Promise<"retried" | "settled"> => {
    const scope = this.#scope;
    const generation = this.#generation;
    const entry = this.#state.messages.find((value) => value.localId === localId);
    if (!scope || !entry) return "settled";
    if (entry.phase === "rejected" && entry.rejection?.code === "unconfirmed") {
      const retried = await this.#writes.run(async () => {
        if (!this.#current(scope, generation)) return false;
        const { rejection: _rejection, ...row } = entry;
        return this.#options.storage.replace(scope, entry, {
          ...row,
          phase: "waiting",
          uncertain: true,
        });
      });
      await this.#reload();
      return retried ? "retried" : "settled";
    }
    this.#clearRetry(localId);
    this.#attempts.delete(localId);
    await this.#reload();
    return "retried";
  };

  restoreDraft = async (localId: string): Promise<MessageTakeBack> => {
    const scope = this.#scope;
    const generation = this.#generation;
    const entry = this.#state.messages.find((value) => value.localId === localId);
    if (!scope || !entry || !takeable(entry)) return "sent";
    const storage = this.#options.storage;
    const restoring: StoredMessage = { ...entry, phase: "restoring" };
    this.#takingBack.add(localId);
    try {
      const claimed = await this.#writes.run(async () => {
        if (!this.#current(scope, generation)) return false;
        const claimed = await storage.replace(scope, entry, restoring);
        if (claimed && this.#current(scope, generation))
          this.#publishRows(
            this.#state.messages.map((row) => (row.localId === localId ? restoring : row)),
          );
        return claimed;
      });
      if (!claimed || !this.#current(scope, generation)) {
        await this.#reload();
        if (
          this.#current(scope, generation) &&
          this.#state.messages.some(
            (row) =>
              row.localId !== localId &&
              row.command.threadId === entry.command.threadId &&
              row.phase === "restoring",
          )
        )
          return "occupied";
        return "sent";
      }
      if (
        (await this.#options.drafts.restore(scope, restoring, () =>
          this.#current(scope, generation),
        )) === "occupied"
      )
        return "occupied";
      // A concurrent Edit may have already committed the same transfer.
      await this.#writes.run(() => storage.replace(scope, restoring, null, true));
      await this.#reload();
      return "restored";
    } finally {
      if (this.#current(scope, generation)) {
        this.#takingBack.delete(localId);
        this.#drain();
      }
    }
  };

  discard = (localId: string): Promise<void> => this.#discard(localId, false);
  removeLocalCopy = (localId: string): Promise<void> => this.#discard(localId, true);

  async #discard(localId: string, localCopy: boolean): Promise<void> {
    const scope = this.#scope;
    const generation = this.#generation;
    const entry = this.#state.messages.find((value) => value.localId === localId);
    this.#takingBack.add(localId);
    try {
      const removed =
        scope &&
        entry &&
        (localCopy
          ? entry.phase === "restoring" ||
            (entry.phase === "rejected" && entry.rejection?.code === "unconfirmed")
          : takeable(entry) && entry.phase !== "restoring") &&
        (await this.#writes.run(
          async () =>
            this.#current(scope, generation) &&
            this.#options.storage.replace(scope, entry, null, true),
        ));
      await this.#reload();
      if (!removed || !scope || !entry)
        throw new ClientOperationError("Delivery is unconfirmed.", "blocked", {
          kind: "local",
          reason: "message-unconfirmed",
          retryable: false,
        });
      if (entry.phase !== "restoring") this.#housekeeping(this.#options.onDiscarded, scope, entry);
    } finally {
      if (scope && this.#current(scope, generation)) {
        this.#takingBack.delete(localId);
        this.#drain();
      }
    }
  }

  #drain(): void {
    this.#clearLeaseWake();
    if (!this.#ready() || !this.#scope) return;
    const scope = this.#scope;
    const generation = this.#generation;
    const heads = new Map<string, StoredMessage>();
    for (const entry of this.#state.messages) {
      if (this.#confirmed.has(entry.localId)) {
        void this.#settle(
          scope,
          generation,
          entry,
          () => this.#options.storage.remove(scope, entry.localId),
          true,
        );
      }
      if (!heads.has(entry.command.threadId)) heads.set(entry.command.threadId, entry);
    }
    let wakeAt = Infinity;
    const now = Date.now();
    for (const [threadId, entry] of heads) {
      if (this.#sending.size >= 4) break;
      const predecessor = this.#legacyBlocked.get(threadId);
      if (
        (predecessor && compareOutboxOrder(predecessor, entry) <= 0) ||
        this.#confirmed.has(entry.localId) ||
        this.#takingBack.has(entry.localId) ||
        entry.phase === "restoring" ||
        entry.phase === "rejected" ||
        this.#sending.has(threadId) ||
        this.#retries.has(entry.localId)
      )
        continue;
      const deadline = entry.lease?.expiresAt;
      if (deadline !== undefined && deadline > now) {
        wakeAt = Math.min(wakeAt, deadline);
        continue;
      }
      const delivery = { key: entry.localId, id: globalThis.crypto.randomUUID() };
      this.#sending.set(threadId, delivery);
      void this.#deliver(scope, generation, entry, delivery)
        .catch(() => {
          if (this.#current(scope, generation)) this.#storageFailed();
        })
        .finally(() => {
          if (this.#sending.get(threadId) === delivery) this.#sending.delete(threadId);
          this.#drain();
        });
    }
    if (Number.isFinite(wakeAt)) {
      this.#leaseWake = setTimeout(() => this.#drain(), wakeAt - now);
      unrefTimer(this.#leaseWake);
    }
  }

  async #deliver(
    scope: ClientScope,
    generation: number,
    entry: StoredMessage,
    delivery: ActiveDelivery,
  ): Promise<void> {
    const canStart = () =>
      this.#current(scope, generation) &&
      this.#ready() &&
      !this.#confirmed.has(entry.localId) &&
      !this.#takingBack.has(entry.localId);
    const started = await this.#writes.run(async () => {
      const claim = await this.#options.storage.claim(
        scope,
        entry,
        delivery.id,
        dispatchLeaseMs,
        this.#options.startsRun?.(entry.command.threadId) ? true : undefined,
        canStart,
      );
      if (!claim) return null;
      const { row, settle } = claim;
      const deadline = row.lease!.expiresAt;
      if (canStart() && deadline > Date.now())
        this.#publishRows(
          this.#state.messages.map((value) => (value.localId === row.localId ? row : value)),
        );
      // A local take-back can beat the network call while the lease commits.
      if (!canStart() || deadline <= Date.now()) {
        try {
          await settle("not-started");
        } catch (error) {
          if (this.#current(scope, generation))
            this.#pendingSettlements.set(delivery.id, () => settle("not-started"));
          throw error;
        }
        return null;
      }
      const expired = Promise.withResolvers<void>();
      const timer = setTimeout(expired.resolve, deadline - Date.now());
      unrefTimer(timer);
      delivery.wake = expired.resolve;
      const answer = this.#send(scope, generation, row, settle);
      return { finished: Promise.race([answer, expired.promise]), timer };
    });
    if (!started) {
      if (this.#current(scope, generation)) await this.#reload();
      return;
    }
    try {
      await started.finished;
    } finally {
      clearTimeout(started.timer);
      delivery.wake = undefined;
    }
  }

  async #send(
    scope: ClientScope,
    generation: number,
    entry: StoredMessage,
    settle: NonNullable<Awaited<ReturnType<MessageOutboxStorage["claim"]>>>["settle"],
  ): Promise<void> {
    let acknowledgement: { readonly messageId: string };
    try {
      acknowledgement = await this.#options.dispatch(entry.command, scope);
    } catch (error) {
      const failure = classifyClientFailure(error);
      const notStarted = failure.reason === "session-changed";
      const rejected = !notStarted && failure.kind === "rejection" && !failure.retryable;
      if (!rejected && this.#current(scope, generation) && !this.#confirmed.has(entry.localId))
        this.#pause(entry.localId);
      const rejection: ClientIssue | undefined = rejected
        ? { code: "rejected", reason: failure.reason }
        : undefined;
      await this.#settle(
        scope,
        generation,
        entry,
        () => settle(notStarted ? "not-started" : (rejection ?? "uncertain")),
        false,
        rejection,
      );
      return;
    }
    if (this.#current(scope, generation)) {
      this.#confirmed.add(entry.localId);
      const acknowledged = new Map(this.#state.acknowledged);
      acknowledged.set(acknowledgement.messageId, entry.localId);
      if (acknowledged.size > 256) acknowledged.delete(acknowledged.keys().next().value!);
      this.#publish({ acknowledged });
    }
    await this.#settle(
      scope,
      generation,
      entry,
      () => this.#options.storage.remove(scope, entry.localId),
      true,
    );
  }

  async #settle(
    scope: ClientScope,
    generation: number,
    entry: StoredMessage,
    write: () => Promise<void>,
    confirmed = false,
    refusal?: ClientIssue,
  ): Promise<void> {
    // A late result settles its captured record even after navigation or sign-out.
    let written = false;
    const committed = async () => {
      if (written) return;
      await write();
      written = true;
      if (!confirmed) return;
      this.#housekeeping(this.#options.onConfirmed, scope, entry);
      this.#housekeeping(this.#options.onDiscarded, scope, entry);
      if (this.#current(scope, generation)) {
        this.#clearRetry(entry.localId);
        this.#attempts.delete(entry.localId);
        this.#confirmed.delete(entry.localId);
        const active = this.#sending.get(entry.command.threadId);
        if (active?.key === entry.localId) active.wake?.();
        this.#publishRows(this.#state.messages.filter((row) => row.localId !== entry.localId));
      }
    };
    const settlement = confirmed ? entry.localId : (entry.lease?.id ?? entry.localId);
    if (this.#current(scope, generation) && this.#pendingSettlements.has(settlement)) return;
    if (this.#current(scope, generation)) this.#pendingSettlements.set(settlement, committed);
    await this.#writes.run(async () => {
      try {
        if (
          !this.#current(scope, generation) ||
          this.#pendingSettlements.get(settlement) === committed
        )
          await committed();
        if (!this.#current(scope, generation)) return;
        this.#pendingSettlements.delete(settlement);
        await this.#load(scope, generation, confirmed && this.#legacyPending);
      } catch {
        if (!this.#current(scope, generation)) return;
        if (refusal) {
          this.#publishRows(
            this.#state.messages.map((row) =>
              row.localId === entry.localId && row.lease?.id === entry.lease?.id
                ? {
                    ...row,
                    phase: "rejected",
                    rejection: entry.uncertain ? { code: "unconfirmed" } : refusal,
                  }
                : row,
            ),
          );
        }
        this.#storageFailed();
      }
    });
  }

  #storageFailed(): void {
    this.#publish({ loading: false, issue: { code: "storage-unavailable" } });
    this.#retryStorage();
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
  #clearRetry(id: string): void {
    const timer = this.#retries.get(id);
    if (timer) clearTimeout(timer);
    this.#retries.delete(id);
  }
  #pause(id: string): void {
    const attempt = this.#attempts.get(id) ?? 0;
    this.#attempts.set(id, attempt + 1);
    this.#schedule(id, Math.min(12_000, 500 * 2 ** Math.min(attempt, 10)));
  }
  #schedule(id: string, delay: number): void {
    this.#clearRetry(id);
    const timer = setTimeout(() => {
      this.#retries.delete(id);
      this.#drain();
    }, delay);
    this.#retries.set(id, timer);
    unrefTimer(timer);
  }
  #clearLeaseWake(): void {
    if (this.#leaseWake) clearTimeout(this.#leaseWake);
    this.#leaseWake = null;
  }
  #releaseDeliveries(): void {
    this.#clearLeaseWake();
    for (const delivery of this.#sending.values()) delivery.wake?.();
    this.#sending.clear();
  }
  dispose = (): void => {
    this.#disposed = true;
    this.#generation++;
    this.#unsubscribe();
    this.#storageRelease?.();
    if (this.#storageRetry) clearTimeout(this.#storageRetry);
    this.#retries.forEach(clearTimeout);
    this.#retries.clear();
    this.#releaseDeliveries();
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
    startsRun: (threadId) => {
      const snapshot = client.getSnapshot();
      const detail = client.getThreadTranscript(threadId)?.getSnapshot();
      const thread = snapshot.threads.find(({ id }) => id === threadId);
      return (
        thread !== undefined &&
        threadStartsRunForMessage({ runQueue: detail?.runQueue ?? snapshot.runQueue, thread }) &&
        !detail?.inputQueue?.items.length
      );
    },
    prepare: (command) => {
      const origin = client.messageOrigin?.();
      return command.origin || !origin ? command : { ...command, origin };
    },
    dispatch: async (command, expectedLogin) => {
      const result = await client.dispatch(command, { preserveOrigin: true, expectedLogin });
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
  const watched = new Map<string, { source: ThreadViewSource; release: () => void }>();
  const observe = () => {
    const scope = (ports.session ?? client).connection.getSnapshot().scope;
    const snapshot = client.getSnapshot();
    if (
      !scope ||
      scope.viewerId !== snapshot.user?.id ||
      scope.deploymentId !== snapshot.deploymentId ||
      snapshot.session !== "authenticated"
    )
      return;
    outbox.observe(
      [...watched.values()].flatMap(({ source }) => {
        const { entries, inputQueue } = source.getSnapshot();
        return [
          ...entries.flatMap((entry) =>
            entry.kind === "message" &&
            entry.author.kind === "human" &&
            entry.author.userId === scope.viewerId &&
            entry.messageKind === "input"
              ? [entry]
              : [],
          ),
          ...(inputQueue?.items.map(({ message }) => message) ?? []),
        ];
      }),
    );
  };
  const watch = () => {
    const targets = new Set(outbox.getSnapshot().messages.map(({ command }) => command.threadId));
    for (const [id, { release, source }] of watched) {
      if (targets.has(id) && client.getThreadTranscript(id) === source) continue;
      release();
      watched.delete(id);
    }
    for (const id of targets) {
      const source = client.getThreadTranscript(id);
      if (!source || watched.has(id)) continue;
      watched.set(id, { source, release: source.subscribe(observe) });
    }
    observe();
  };
  const releaseHost = client.subscribe(watch);
  const releaseOutbox = outbox.subscribe(watch);
  const dispose = outbox.dispose;
  outbox.dispose = () => {
    releaseHost();
    releaseOutbox();
    for (const { release } of watched.values()) release();
    watched.clear();
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

// Cache the projection of unchanged durable rows.
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
      ...(entry.inTranscript ? { inTranscript: true } : {}),
      ...(entry.phase !== "restoring" && entry.rejection ? { issue: entry.rejection } : {}),
    },
  };
  localRows.set(entry, row);
  return row;
}

/**
 * The previous projection when every row shows the same thing. Local rows can
 * get a new storage identity when just their dispatch metadata changes.
 */
export function sameTranscript(
  previous: readonly TranscriptEntry[] | null,
  next: readonly TranscriptEntry[],
): readonly TranscriptEntry[] {
  return previous !== null &&
    previous.length === next.length &&
    previous.every((entry, index) => {
      const row = next[index];
      return (
        entry === row ||
        (entry.kind === "message" &&
          entry.localDelivery !== undefined &&
          row?.kind === "message" &&
          row.localDelivery !== undefined &&
          entry.clientSendKey === row.clientSendKey &&
          JSON.stringify(entry) === JSON.stringify(row))
      );
    })
    ? previous
    : next;
}
