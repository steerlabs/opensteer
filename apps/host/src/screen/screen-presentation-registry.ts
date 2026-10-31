import { randomBytes, randomUUID } from "node:crypto";
import type {
  AuthSessionId,
  CommandId,
  RunId,
  MessageId,
  ScreenPresentationContext,
  ScreenPresentationReceipt,
  ScreenShowTarget,
  ThreadId,
  UserId,
} from "@opensteer/core";
import type { RealtimeSink } from "@opensteer/orchestration";
import {
  screenPresentationDispatchMs,
  screenPresentationEligibilityMs,
  type ScreenDoneMessage,
  type ScreenPresentationInput,
  type ScreenReadyMessage,
} from "@opensteer/protocol";

interface Endpoint {
  readonly ownerId: UserId;
  readonly sessionId: AuthSessionId;
  readonly sink: RealtimeSink;
  readonly ref: string;
}
interface Operation {
  readonly id: string;
  readonly target: string;
  readonly result: Promise<ScreenPresentationReceipt>;
  readonly resolve: (receipt: ScreenPresentationReceipt) => void;
  readonly deadlineAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}
interface Entry {
  readonly endpoint: Endpoint;
  readonly threadId: ThreadId;
  readonly context: ScreenPresentationInput;
  readonly expiresAt: number;
  operation?: Operation;
  admittedAttempt?: {
    readonly runId: RunId;
    readonly bindingGeneration: number;
    readonly commandId?: CommandId;
  };
}
const ended = (): ScreenPresentationReceipt => ({
  outcome: "unavailable",
  reason: "interaction-ended",
});
const expired = (): ScreenPresentationReceipt => ({ outcome: "unavailable", reason: "expired" });

/** Private, transient associations. A committed input can be registered only by its first commit. */
export class ScreenPresentationRegistry {
  readonly #now: () => number;
  readonly #endpoints = new Map<string, Endpoint>();
  readonly #entries = new Map<MessageId, Entry>();
  readonly #operations = new Map<string, Entry>();
  readonly #maximumEndpoints: number;
  readonly #maximumEntries: number;
  #closed = false;
  constructor(
    options: {
      readonly now?: () => number;
      readonly maximumEndpoints?: number;
      readonly maximumEntries?: number;
    } = {},
  ) {
    this.#now = options.now ?? (() => performance.now());
    this.#maximumEndpoints = options.maximumEndpoints ?? 512;
    this.#maximumEntries = options.maximumEntries ?? 4096;
  }
  open(input: Omit<Endpoint, "ref">): {
    readonly ready: ScreenReadyMessage;
    readonly close: () => void;
  } {
    if (this.#closed || this.#endpoints.size >= this.#maximumEndpoints)
      throw new Error("Screen endpoint capacity reached");
    const endpoint = { ...input, ref: randomBytes(32).toString("hex") };
    this.#endpoints.set(endpoint.ref, endpoint);
    return {
      ready: { type: "host.screen.ready", endpointRef: endpoint.ref, serverTime: this.#now() },
      close: () => this.#revoke(endpoint),
    };
  }
  hasEndpoint(ref: string, ownerId: UserId, sessionId: AuthSessionId): boolean {
    const endpoint = this.#endpoints.get(ref);
    return !this.#closed && endpoint?.ownerId === ownerId && endpoint.sessionId === sessionId;
  }
  register(input: {
    readonly ownerId: UserId;
    readonly sessionId: AuthSessionId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly context: ScreenPresentationInput;
  }): void {
    this.#sweep();
    if (
      this.#entries.has(input.messageId) ||
      this.#entries.size >= this.#maximumEntries ||
      !this.hasEndpoint(input.context.endpointRef, input.ownerId, input.sessionId)
    )
      return;
    const endpoint = this.#endpoints.get(input.context.endpointRef)!;
    this.#entries.set(input.messageId, {
      endpoint,
      threadId: input.threadId,
      context: { ...input.context },
      expiresAt: this.#now() + screenPresentationEligibilityMs,
    });
  }
  contextFor(messageId: MessageId): ScreenPresentationContext | undefined {
    const entry = this.#entries.get(messageId);
    if (!entry || this.#unavailable(entry)) return undefined;
    return entry.context.currentThreadId ? { currentThreadId: entry.context.currentThreadId } : {};
  }
  noteInputsSending(
    messageIds: readonly MessageId[],
    runId: RunId,
    bindingGeneration: number,
    commandId?: CommandId,
  ): void {
    for (const messageId of messageIds) {
      const entry = this.#entries.get(messageId);
      if (entry && !this.#unavailable(entry))
        entry.admittedAttempt = { runId, bindingGeneration, ...(commandId ? { commandId } : {}) };
    }
  }
  inputWasSent(
    messageId: MessageId,
    runId: RunId,
    bindingGeneration: number,
    steerCommandId: CommandId | null = null,
  ): boolean {
    const attempt = this.#entries.get(messageId)?.admittedAttempt;
    return (
      !!attempt &&
      attempt.runId === runId &&
      attempt.bindingGeneration === bindingGeneration &&
      (!steerCommandId || attempt.commandId === steerCommandId)
    );
  }
  matches(messageId: MessageId, ownerId: UserId, threadId: ThreadId): boolean {
    const entry = this.#entries.get(messageId);
    return !!entry && entry.endpoint.ownerId === ownerId && entry.threadId === threadId;
  }
  replay(
    messageId: MessageId,
    target: ScreenShowTarget,
  ): Promise<ScreenPresentationReceipt> | undefined {
    const operation = this.#entries.get(messageId)?.operation;
    if (!operation) return undefined;
    return operation.target === JSON.stringify(target)
      ? operation.result
      : Promise.resolve({ outcome: "unavailable", reason: "already-requested" });
  }
  /** Call only after asynchronous target and execution checks; reservation and send share this turn. */
  show(messageId: MessageId, target: ScreenShowTarget): Promise<ScreenPresentationReceipt> {
    const entry = this.#entries.get(messageId);
    if (!entry) return Promise.resolve(this.#closed ? ended() : expired());
    const fingerprint = JSON.stringify(target);
    const previous = this.replay(messageId, target);
    if (previous) return previous;
    const refusal = this.#unavailable(entry);
    if (refusal) return Promise.resolve(refusal);
    let resolve!: (receipt: ScreenPresentationReceipt) => void;
    const result = new Promise<ScreenPresentationReceipt>((settle) => {
      resolve = settle;
    });
    const operation: Operation = {
      id: randomUUID(),
      target: fingerprint,
      result,
      resolve,
      deadlineAt: this.#now() + screenPresentationDispatchMs,
      settled: false,
      timer: null,
    };
    entry.operation = operation;
    this.#operations.set(operation.id, entry);
    operation.timer = setTimeout(
      () => this.#settle(entry, { outcome: "unconfirmed" }),
      screenPresentationDispatchMs,
    );
    operation.timer.unref();
    // A failed write may already have reached the client. It spends the operation too.
    try {
      void entry.endpoint.sink
        .send({
          type: "host.screen.show",
          endpointRef: entry.endpoint.ref,
          operationId: operation.id,
          messageId,
          voiceSessionId: entry.context.voiceSessionId,
          utteranceSequence: entry.context.utteranceSequence,
          interactionRevision: entry.context.interactionRevision,
          deadlineAt: operation.deadlineAt,
          target,
        })
        .catch(() => this.#settle(entry, { outcome: "unconfirmed" }));
    } catch {
      this.#settle(entry, { outcome: "unconfirmed" });
    }
    return result;
  }
  acknowledge(sink: RealtimeSink, message: ScreenDoneMessage): void {
    const entry = this.#operations.get(message.operationId);
    if (
      !entry ||
      entry.endpoint.sink !== sink ||
      this.#endpoints.get(entry.endpoint.ref) !== entry.endpoint
    )
      return;
    this.#settle(
      entry,
      this.#now() >= entry.operation!.deadlineAt ? { outcome: "unconfirmed" } : message.receipt,
    );
  }
  get pendingCount(): number {
    return this.#operations.size;
  }
  close(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) this.#settle(entry, { outcome: "unconfirmed" });
    this.#endpoints.clear();
    this.#entries.clear();
  }
  #unavailable(entry: Entry): ScreenPresentationReceipt | null {
    if (this.#closed || this.#endpoints.get(entry.endpoint.ref) !== entry.endpoint) return ended();
    if (this.#now() >= entry.expiresAt) return expired();
    return null;
  }
  #settle(entry: Entry, receipt: ScreenPresentationReceipt): void {
    const operation = entry.operation;
    if (!operation || operation.settled) return;
    operation.settled = true;
    if (operation.timer) clearTimeout(operation.timer);
    operation.timer = null;
    this.#operations.delete(operation.id);
    operation.resolve(receipt);
  }
  #revoke(endpoint: Endpoint): void {
    this.#endpoints.delete(endpoint.ref);
    for (const entry of this.#entries.values())
      if (entry.endpoint === endpoint) this.#settle(entry, { outcome: "unconfirmed" });
  }
  #sweep(): void {
    const now = this.#now();
    for (const [messageId, entry] of this.#entries)
      if (now >= entry.expiresAt) {
        this.#settle(entry, { outcome: "unconfirmed" });
        this.#entries.delete(messageId);
      }
  }
}
