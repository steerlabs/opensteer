import { messageDraftParts } from "./pending-send.js";
import type { UserId } from "@opensteer/core";
import type { HostClient, TranscriptEntry } from "./client.js";
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
  readonly phase: "waiting" | "sending" | "rejected";
  readonly localAttachmentUris?: readonly (string | null)[] | undefined;
  readonly rejection?: ClientIssue | undefined;
}
export interface MessageOutboxStorage {
  load(scope: ClientScope): Promise<readonly StoredMessage[]>;
  put(scope: ClientScope, entry: StoredMessage): Promise<void>;
  remove(scope: ClientScope, localId: string): Promise<void>;
  delivery?<T>(scope: ClientScope, threadId: string, work: () => Promise<T>): Promise<T>;
  exclusive?<T>(scope: ClientScope, work: () => Promise<T>): Promise<T>;
  subscribe?(listener: () => void): () => void;
}
export interface MessageDraftRecovery {
  restore(scope: ClientScope, entry: StoredMessage): Promise<"restored" | "occupied">;
}
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
    options?: { readonly localAttachmentUris?: readonly (string | null)[] },
  ): Promise<string>;
  observe(messages: readonly { readonly id: string; readonly clientSendKey?: string }[]): void;
  retry(localId: string): void;
  restoreDraft(localId: string): Promise<void>;
  discard(localId: string): Promise<void>;
  dispose(): void;
}
export interface MessageOutboxOptions {
  readonly legacy?: {
    load(scope: ClientScope): Promise<
      readonly {
        readonly command: PendingSendCommand;
        readonly localAttachmentUris?: readonly (string | null)[];
      }[]
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
  #writes: Promise<void> = Promise.resolve();
  #loaded: Promise<void> = Promise.resolve();
  readonly #sending = new Map<string, string>();
  readonly #cancelled = new Set<string>();
  readonly #confirmed = new Set<string>();
  readonly #attempts = new Map<string, number>();
  readonly #retries = new Map<string, ReturnType<typeof setTimeout>>();
  #storageRetry: ReturnType<typeof setTimeout> | null = null;
  #storageAttempt = 0;
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
  #write<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.#writes.catch(() => {}).then(work);
    this.#writes = pending.then(
      () => {},
      () => {},
    );
    return pending;
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
      this.#confirmed.clear();
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
      if (this.#options.legacy) {
        const legacy = await this.#options.legacy.load(scope);
        for (const held of legacy) {
          if (!this.#current(scope, generation)) return;
          if (!entries.some((entry) => entry.localId === held.command.idempotencyKey)) {
            if (
              entries.length >= 48 ||
              entries.filter((entry) => entry.command.threadId === held.command.threadId).length >=
                20
            )
              throw storageFailure();
            const entry: StoredMessage = {
              localId: held.command.idempotencyKey,
              command: held.command,
              createdAt: new Date().toISOString(),
              order: Math.min(1, ...entries.map((entry) => entry.order)) - 1,
              attempted: true,
              phase: "rejected",
              rejection: { code: "unconfirmed" },
              ...(held.localAttachmentUris
                ? { localAttachmentUris: held.localAttachmentUris }
                : {}),
            };
            await this.#options.storage.put(scope, entry);
            entries = [...entries, entry];
          }
          await this.#options.legacy.remove(scope, held.command.idempotencyKey);
        }
      }
      if (!this.#current(scope, generation)) return;
      for (const entry of entries) {
        const held = this.#state.messages.find((value) => value.localId === entry.localId);
        if (!entry.rejection && held?.rejection)
          await this.#options.storage.put(scope, {
            ...entry,
            phase: "rejected",
            rejection: held.rejection,
          });
        if (!this.#current(scope, generation)) return;
      }
      const messages = entries
        .map((entry) => {
          const held = this.#state.messages.find((value) => value.localId === entry.localId);
          const rejection = entry.rejection ?? held?.rejection;
          return {
            ...entry,
            ...(rejection ? { rejection } : {}),
            phase: rejection
              ? ("rejected" as const)
              : this.#sending.get(entry.command.threadId) === entry.localId
                ? ("sending" as const)
                : ("waiting" as const),
          };
        })
        .sort((a, b) => a.order - b.order);
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
    options?: { readonly localAttachmentUris?: readonly (string | null)[] },
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
    return this.#write(async () => {
      if (!this.#current(scope, generation)) throw storageFailure();
      const save = async () => {
        const entries = await this.#options.storage.load(scope);
        const previous = entries.find((entry) => entry.localId === parsed.idempotencyKey);
        if (previous) {
          if (JSON.stringify(previous.command) !== JSON.stringify(parsed)) throw storageFailure();
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
        await this.#options.storage.put(scope, entry);
        return entry;
      };
      let entry: StoredMessage;
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
      if (this.#current(scope, generation)) {
        this.#publish({
          messages: [
            ...this.#state.messages.filter((value) => value.localId !== entry.localId),
            entry,
          ].sort((a, b) => a.order - b.order),
          issue: null,
        });
        queueMicrotask(() => this.#drain());
      }
      return entry.localId;
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
  retry = (localId: string): void => {
    const timer = this.#retries.get(localId);
    if (timer) clearTimeout(timer);
    this.#retries.delete(localId);
    this.#attempts.delete(localId);
    if (this.#state.issue?.code === "storage-unavailable") void this.#reload();
    else this.#drain();
  };
  restoreDraft = async (localId: string): Promise<void> => {
    const scope = this.#scope,
      generation = this.#generation,
      entry = this.#state.messages.find((value) => value.localId === localId);
    if (!scope || !entry || entry.phase !== "rejected") return;
    const restored = await this.#options.drafts.restore(scope, entry);
    if (restored === "restored") await this.#remove(scope, generation, entry.localId);
  };
  discard = async (localId: string): Promise<void> => {
    const scope = this.#scope,
      generation = this.#generation,
      entry = this.#state.messages.find((value) => value.localId === localId);
    if (!scope || !entry) return;
    const allowed = (value: StoredMessage) =>
      !value.attempted || (value.phase === "rejected" && value.rejection?.code !== "unconfirmed");
    const unconfirmed = () =>
      new ClientOperationError("Delivery is unconfirmed.", "blocked", {
        kind: "local",
        reason: "message-unconfirmed",
        retryable: false,
      });
    if (!allowed(entry)) throw unconfirmed();
    this.#cancelled.add(entry.localId);
    const remove = async () => {
      if (this.#options.storage.delivery) {
        const held = (await this.#options.storage.load(scope)).find(
          (value) => value.localId === localId,
        );
        if (!this.#current(scope, generation)) return;
        if (!held || !allowed(held)) {
          this.#cancelled.delete(localId);
          await this.#reload();
          throw unconfirmed();
        }
      }
      await this.#remove(scope, generation, entry.localId);
      this.#housekeeping(this.#options.onDiscarded, scope, entry);
    };
    await (this.#options.storage.delivery?.(scope, entry.command.threadId, remove) ?? remove());
  };
  async #remove(scope: ClientScope, generation: number, localId: string): Promise<void> {
    await this.#write(() => this.#options.storage.remove(scope, localId));
    if (this.#current(scope, generation)) {
      this.#cancelled.delete(localId);
      this.#publish({
        messages: this.#state.messages.filter((entry) => entry.localId !== localId),
      });
      this.#drain();
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
          (head.phase === "rejected" && !this.#confirmed.has(head.localId))
        ) {
          await this.#reload();
          return;
        }
        await this.#deliver(scope, generation, head);
      };
      void (this.#options.storage.delivery?.(scope, threadId, deliver) ?? deliver())
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
    const sending: StoredMessage = { ...entry, phase: "sending", attempted: true };
    try {
      await this.#write(() => this.#options.storage.put(scope, sending));
      if (!this.#current(scope, generation)) return;
      if (this.#cancelled.has(entry.localId)) {
        if (this.#options.storage.delivery)
          await this.#write(() => this.#options.storage.put(scope, entry));
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
          await this.#write(() => this.#options.storage.put(scope, rejected));
        } catch {
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
  if (state.messages.length === 0 && state.acknowledged.size === 0) return entries;
  const confirmed = new Set(
    entries.flatMap((entry) =>
      entry.kind === "message"
        ? (entry.clientSendKey ?? state.acknowledged.get(entry.id) ?? [])
        : [],
    ),
  );
  const projected = entries.map((entry) =>
    entry.kind === "message" &&
    state.acknowledged.has(entry.id) &&
    entry.clientSendKey !== state.acknowledged.get(entry.id)
      ? { ...entry, clientSendKey: state.acknowledged.get(entry.id)! }
      : entry,
  );
  const pending: TranscriptEntry[] = state.messages
    .filter((entry) => entry.command.threadId === threadId && !confirmed.has(entry.localId))
    .map((entry) => {
      const parts = messageDraftParts(entry.command.content);
      return {
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
        places: parts.places.filter(
          (part) => part.type === "computer-app" || part.type === "phone",
        ),
        author: { kind: "human", userId: viewerId, principalId: viewerId, displayName: "You" },
        localDelivery: {
          phase: entry.phase,
          attempted: entry.attempted,
          ...(entry.rejection ? { issue: entry.rejection } : {}),
        },
      };
    });
  return [...projected, ...pending];
}
