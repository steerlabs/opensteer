import {
  displayPasteTextMaxLength,
  type DisplayInputEvent,
  type DisplayInputRefusal,
} from "@opensteer/protocol";
import { EditingClipboardItemsSchema, type EditingContext } from "@opensteer/protocol/editing";
import type { EditingOperation, EditingTargetAbilities } from "../editing/types.js";
import type { ViewerClipboardResult } from "../host/browser-editing.js";
import { mergeDisplayInput } from "./display-input.js";
import {
  DisplayInputTooLargeError,
  maxDisplayInputBytes,
  maxDisplayInputEvents,
  type DisplayEditingMessage,
  type DisplayLease,
} from "./phone-display-stream.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
/** Stated response time for one in-flight wire batch before stopping the burst. */
const batchTimeoutMs = 10_000;
/** Envelope overhead (`{"type":"display.input","geometry":...,"sequence":...,"events":[]}`). */
const batchEnvelopeOverheadBytes = 128;
/** Memory ceiling for queued client-side events waiting on a slow device. */
const maxQueuedEvents = 8_192;
const maxQueuedChars = 2_000_000;

/** Phone and Mac producers insert only literal text. */
export const displayEditingAbilities: EditingTargetAbilities = {
  composition: false,
  rangeEdits: true,
  commands: true,
  clipboard: "text",
};

export interface DisplayEditingSnapshot {
  readonly context: EditingContext | null;
  readonly receipt: string | null;
}
const refusalWords: Record<DisplayInputRefusal, string> = {
  "no-field": "Select a text field first.",
  sensitive: "This field protects its text.",
  stale: "The field changed. Try again.",
  unsupported: "This device doesn’t support this edit.",
  "too-large": "This edit is too large.",
  unavailable: "This device isn’t taking input right now. Try again.",
  contended: "Another viewer is pressing. Try again.",
};
const unknownClipboardWords = {
  paste: "May have been pasted: check before pasting again.",
  cut: "May have been cut: check before cutting again.",
} as const;

interface Caller {
  readonly mutatesClipboard?: "paste" | "cut";
  sent: boolean;
  remainingEvents: number;
  settled: boolean;
  readonly resolve: (result: ViewerClipboardResult | undefined) => void;
  readonly reject: (error: Error) => void;
}
interface BatchCaller {
  readonly caller: Caller;
  readonly eventsTaken: number;
}
interface Queued {
  readonly geometry: number;
  readonly events: DisplayInputEvent[];
  readonly copy: boolean;
  readonly mutatesClipboard?: "paste" | "cut";
  readonly atomic: boolean;
  readonly callers: Caller[];
}
interface Pending {
  readonly copy: boolean;
  readonly mutatesClipboard?: "paste" | "cut";
  readonly onlyMove: boolean;
  readonly chars: number;
  /** True once `lease.input` registered a sequence and handed the batch to the socket. */
  sent: boolean;
  dispatched?: true;
  clipboardRefusal?: { readonly reason: string; readonly message: string };
  readonly sequences: Set<number>;
  readonly callers: readonly BatchCaller[];
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Input this view refused, or that the device refused, before it happened: it never left or
 * was never applied, so it reads in its own words and may be tried again. An outcome that is
 * unknown is never one of these.
 */
export class DisplayEditingRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "DisplayEditingRefusal";
    this.reason = reason;
  }
}

/**
 * A multi-batch burst stopped mid-way because a batch's answer was lost or refused:
 * nothing queued after it left, and any in-flight batch whose answer was lost is unknown
 * (never resent).
 */
export class DisplayEditingStopped extends Error {
  readonly delivered: number;
  readonly uncertain: number;
  readonly unsent: number;
  readonly settled: boolean;
  constructor(
    message: string,
    counts: {
      readonly delivered: number;
      readonly uncertain: number;
      readonly unsent: number;
      readonly settled: boolean;
    },
  ) {
    super(message);
    this.name = "DisplayEditingStopped";
    this.delivered = counts.delivered;
    this.uncertain = counts.uncertain;
    this.unsent = counts.unsent;
    this.settled = counts.settled;
  }
}

/** The lease owns input; this adapter fences its private context and receipt lifetimes. */
export class DisplayEditingSession {
  readonly diagnostics = {
    operations: {} as Record<string, number>,
    refusals: {} as Record<string, number>,
    clipboard: {} as Record<string, number>,
    contexts: 0,
  };
  readonly #lease: DisplayLease;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<number, Pending>();
  readonly #queue: Queued[] = [];
  readonly #unsubscribe: readonly (() => void)[];
  #state: DisplayEditingSnapshot = { context: null, receipt: null };
  #scope: string | null = null;
  #geometry: number | null = null;
  #disposed = false;
  #queuedEvents = 0;
  #queuedChars = 0;
  #burstDeliveredChars = 0;

  constructor(lease: DisplayLease) {
    this.#lease = lease;
    this.#scope = this.#currentScope();
    this.#unsubscribe = [
      lease.subscribe(() => this.#changed()),
      lease.onEditingMessage((message) => this.#message(message)),
    ];
  }
  getSnapshot = (): DisplayEditingSnapshot => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  setGeometry(geometry: number | null): void {
    if (this.#geometry === geometry) return;
    this.#geometry = geometry;
    if (geometry === null) this.#cancel("The display changed. Try again.", "changed");
  }
  #currentScope(): string | null {
    const { input, connection, display } = this.#lease.getSnapshot();
    return connection === "open" && input === "available" && display?.editingVersion === 1
      ? `${connection}:${display.generation}`
      : null;
  }
  #changed(): void {
    const scope = this.#currentScope();
    if (scope === this.#scope) return;
    this.#scope = scope;
    const preservedReceipt = this.#cancel("The display changed. Try again.", "changed");
    this.#set({ context: null, ...(preservedReceipt ? {} : { receipt: null }) });
  }
  #set(patch: Partial<DisplayEditingSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #count(record: Record<string, number>, kind: string): void {
    record[kind] = (record[kind] ?? 0) + 1;
  }
  #settleCaller(caller: Caller, error?: Error, result?: ViewerClipboardResult): void {
    if (caller.settled) return;
    caller.settled = true;
    if (error) caller.reject(error);
    else caller.resolve(result);
  }
  #dropQueue(error: Error): void {
    const dropped = this.#queue.splice(0);
    this.#queuedEvents = 0;
    this.#queuedChars = 0;
    for (const entry of dropped)
      for (const caller of entry.callers) this.#settleCaller(caller, error);
  }
  #finish(
    pending: Pending,
    error?: Error,
    result?: ViewerClipboardResult,
    allowMoveDrain = false,
  ): void {
    clearTimeout(pending.timer);
    for (const sequence of pending.sequences) this.#pending.delete(sequence);
    pending.sequences.clear();
    if (error) {
      const keepMoveQueue =
        allowMoveDrain &&
        !this.#disposed &&
        this.#scope !== null &&
        this.#geometry !== null &&
        pending.onlyMove &&
        this.#queue.length > 0 &&
        this.#queue.every((entry) => !entry.atomic && !entry.copy && entry.events.every(isMove));
      for (const { caller } of pending.callers) this.#settleCaller(caller, error);
      if (!keepMoveQueue) {
        this.#burstDeliveredChars = 0;
        this.#dropQueue(error);
      } else if (!this.#pending.size) {
        this.#burstDeliveredChars = 0;
        this.#drain();
      }
      return;
    }
    for (const { caller, eventsTaken } of pending.callers) {
      caller.remainingEvents -= eventsTaken;
      if (caller.remainingEvents <= 0) this.#settleCaller(caller, undefined, result);
    }
    if (!this.#pending.size) {
      if (this.#queue.length) this.#drain();
      else this.#burstDeliveredChars = 0;
    }
  }
  /** Stops a burst cleanly when a batch's answer is lost or refused mid-way. */
  #stopBurst(
    pending: Pending,
    cause: "timeout" | "changed" | "send-failed" | "refused",
    options: {
      readonly fallbackText: string;
      readonly recordReceipt: boolean;
      readonly refusalReason?: string;
      readonly refusalMessage?: string;
    },
  ): boolean {
    const delivered = this.#burstDeliveredChars;
    const queuedChars = this.#queuedChars;
    const settled = cause === "refused" || !pending.sent;
    const uncertain = settled ? 0 : pending.chars;
    const unsent = settled ? pending.chars + queuedChars : queuedChars;
    const isBurst = delivered > 0 || queuedChars > 0;
    if (isBurst) {
      const message = stoppedBurstWords({
        delivered,
        uncertain,
        unsent,
        cause,
        ...(options.refusalMessage ? { detail: options.refusalMessage } : {}),
      });
      const stopped = new DisplayEditingStopped(message, {
        delivered,
        uncertain,
        unsent,
        settled,
      });
      if (options.refusalReason) this.#count(this.diagnostics.refusals, options.refusalReason);
      else if (cause === "timeout") this.#count(this.diagnostics.refusals, "timeout");
      this.#set({ receipt: message });
      clearTimeout(pending.timer);
      for (const sequence of pending.sequences) this.#pending.delete(sequence);
      pending.sequences.clear();
      this.#burstDeliveredChars = 0;
      for (const { caller } of pending.callers) {
        if (caller.sent && caller.mutatesClipboard && !settled) {
          this.#count(this.diagnostics.clipboard, "unknown");
          this.#settleCaller(caller, undefined, { outcome: "unknown", items: [] });
        } else {
          this.#settleCaller(caller, stopped);
        }
      }
      this.#dropQueue(stopped);
      return true;
    }
    if (cause === "refused" && options.refusalReason && options.refusalMessage) {
      this.#finish(
        pending,
        this.#refuse(options.refusalReason, options.refusalMessage),
        undefined,
        true,
      );
      return true;
    }
    return this.#carrierEnded(
      pending,
      options.fallbackText,
      options.recordReceipt,
      cause === "timeout",
    );
  }
  #carrierEnded(
    pending: Pending,
    text: string,
    recordTimeoutReceipt: boolean,
    allowMoveDrain = false,
  ): boolean {
    // Q1 (AGENTS.md rule 4): once a paste or cut batch has left this client onto the carrier,
    // never report it as failed or invite a blind retry on timeout or display/carrier change.
    if (pending.sent && pending.mutatesClipboard) {
      this.#count(this.diagnostics.clipboard, "unknown");
      this.#set({ receipt: unknownClipboardWords[pending.mutatesClipboard] });
      clearTimeout(pending.timer);
      for (const sequence of pending.sequences) this.#pending.delete(sequence);
      pending.sequences.clear();
      this.#burstDeliveredChars = 0;
      for (const { caller } of pending.callers) {
        if (caller.sent && caller.mutatesClipboard)
          this.#settleCaller(caller, undefined, { outcome: "unknown", items: [] });
        else this.#settleCaller(caller, new Error(text));
      }
      this.#dropQueue(new Error(text));
      return true;
    }
    // A batch that left and never answered may have happened: never a refusal (rule 4).
    this.#finish(
      pending,
      recordTimeoutReceipt ? this.#refuse("timeout", text, false) : new Error(text),
      undefined,
      allowMoveDrain,
    );
    return false;
  }
  #cancel(reason: string, cause: "changed" | "send-failed" = "changed"): boolean {
    let preservedReceipt = false;
    const pendingList = [...new Set(this.#pending.values())];
    if (pendingList.length) {
      for (const pending of pendingList)
        if (
          this.#stopBurst(pending, cause, {
            fallbackText: reason,
            recordReceipt: false,
          })
        )
          preservedReceipt = true;
    } else {
      this.#burstDeliveredChars = 0;
      this.#dropQueue(new Error(reason));
    }
    return preservedReceipt;
  }
  /** A refusal of input that never happened says so in its own words; `settled` false is unknown. */
  #refuse(reason: string, message: string, settled = true): Error {
    this.#count(this.diagnostics.refusals, reason);
    this.#set({ receipt: message });
    return settled ? new DisplayEditingRefusal(reason, message) : new Error(message);
  }
  #message(message: DisplayEditingMessage): void {
    if (this.#disposed || !this.#scope) return;
    if (message.type === "display.editing") {
      if (message.generation !== this.#lease.getSnapshot().display?.generation) return;
      this.diagnostics.contexts++;
      this.#set({ context: message.context });
      return;
    }
    const pending = this.#pending.get(message.sequence);
    if (!pending) return;
    if (message.type === "display.clipboard") {
      if (!pending.copy) return;
      this.#count(this.diagnostics.clipboard, message.outcome);
      if (
        message.outcome === "copied" ||
        message.outcome === "cut" ||
        message.outcome === "empty"
      ) {
        const text = message.outcome !== "empty" ? message.text : undefined;
        this.#finish(pending, undefined, {
          outcome: text ? message.outcome : "empty",
          items: text ? [{ type: "text/plain", bytes: encoder.encode(text) }] : [],
        });
      } else {
        const refusal = {
          reason: message.outcome,
          message:
            message.outcome === "too-large"
              ? refusalWords["too-large"]
              : "This device couldn’t copy the selection.",
        };
        // The batch receipt supplies the native reason even when the clipboard arrives first.
        if (pending.dispatched)
          this.#stopBurst(pending, "refused", {
            fallbackText: refusal.message,
            recordReceipt: true,
            refusalReason: refusal.reason,
            refusalMessage: refusal.message,
          });
        else pending.clipboardRefusal = refusal;
      }
      return;
    }
    if (message.outcome !== "dispatched") {
      const reason = message.reason ?? (message.outcome === "stale" ? "stale" : "unsupported");
      this.#stopBurst(pending, "refused", {
        fallbackText: refusalWords[reason],
        recordReceipt: true,
        refusalReason: reason,
        refusalMessage: refusalWords[reason],
      });
    } else {
      this.#set({ receipt: null });
      if (pending.copy) {
        pending.dispatched = true;
        const refusal = pending.clipboardRefusal;
        if (refusal)
          this.#stopBurst(pending, "refused", {
            fallbackText: refusal.message,
            recordReceipt: true,
            refusalReason: refusal.reason,
            refusalMessage: refusal.message,
          });
        return;
      }
      this.#pending.delete(message.sequence);
      pending.sequences.delete(message.sequence);
      if (!pending.sequences.size) {
        this.#burstDeliveredChars += pending.chars;
        this.#finish(pending);
      }
    }
  }
  #mapOperation(operation: EditingOperation): DisplayInputEvent[] {
    switch (operation.kind) {
      case "key":
        return [{ kind: "key", ...operation.keystroke }];
      case "command":
        if (!operation.contextId) {
          this.#count(this.diagnostics.operations, operation.kind);
          throw this.#refuse("stale", refusalWords.stale);
        }
        return [{ kind: "command", command: operation.command, contextId: operation.contextId }];
      case "edit":
        return [{ kind: "edit", edit: operation.edit }];
      case "copy":
        if (!operation.contextId) {
          this.#count(this.diagnostics.operations, operation.kind);
          throw this.#refuse("stale", refusalWords.stale);
        }
        return [{ kind: "copy", contextId: operation.contextId }];
      case "cut":
        if (this.#lease.getSnapshot().display?.displayCut !== 1 || !this.#state.context?.field) {
          this.#count(this.diagnostics.operations, operation.kind);
          throw this.#refuse("unsupported", "Cut isn’t supported by this device.");
        }
        if (!operation.contextId) {
          this.#count(this.diagnostics.operations, operation.kind);
          throw this.#refuse("stale", refusalWords.stale);
        }
        return [{ kind: "cut", contextId: operation.contextId }];
      case "compose":
        this.#count(this.diagnostics.operations, operation.kind);
        throw this.#refuse("unsupported", "Live composition isn’t supported by this device.");
      case "paste": {
        const metadata = EditingClipboardItemsSchema.safeParse(
          operation.items.map(({ type, name, bytes }) => ({
            type,
            ...(name ? { name } : {}),
            size: bytes.byteLength,
          })),
        );
        if (!metadata.success) throw this.#refuse("too-large", refusalWords["too-large"]);
        if (operation.items.some((item) => item.type !== "text/plain" || item.name)) {
          this.#count(this.diagnostics.operations, operation.kind);
          throw this.#refuse("unsupported", refusalWords.unsupported);
        }
        const text = operation.items.map((item) => decoder.decode(item.bytes)).join("");
        if (!operation.contextId) {
          this.#count(this.diagnostics.operations, operation.kind);
          throw this.#refuse("stale", refusalWords.stale);
        }
        const events: DisplayInputEvent[] = [];
        let piece = "";
        for (const character of text) {
          if (piece.length + character.length > displayPasteTextMaxLength) {
            events.push({ kind: "paste", text: piece, contextId: operation.contextId });
            piece = "";
          }
          piece += character;
        }
        if (piece) events.push({ kind: "paste", text: piece, contextId: operation.contextId });
        return events;
      }
    }
  }
  send = async (operation: EditingOperation): Promise<ViewerClipboardResult | undefined> => {
    // Losing the lease already releases native holds; cleanup must not become a new edit.
    if (!this.#scope && operation.kind === "key" && operation.keystroke.action === "up")
      return undefined;
    const events = this.#mapOperation(operation);
    if (!events.length) return undefined;
    return this.input(
      this.#geometry,
      events,
      operation.kind === "copy" || operation.kind === "cut",
    );
  };
  /**
   * P2 (M2 & S2) + O1: sends a group of dependent operations (e.g. selection removal, compensating
   * moves, replacement paste/edit) in ONE atomic `display.input` batch so the receiver stops at
   * the first refusal and never applies follow-up operations alone. If a group exceeds one batch ONLY
   * because its trailing paste is larger than one frame, sends the prefix atomically first and
   * chunks the paste only after the prefix dispatches; any other over-large group is refused whole.
   */
  sendBatch = async (
    operations: readonly EditingOperation[],
  ): Promise<ViewerClipboardResult | undefined> => {
    if (operations.length === 0) return undefined;
    if (operations.length === 1) return this.send(operations[0]!);
    const groups = operations.map((operation) =>
      !this.#scope && operation.kind === "key" && operation.keystroke.action === "up"
        ? []
        : this.#mapOperation(operation),
    );
    const events = groups.flat();
    if (!events.length) return undefined;
    const copy = operations.some((op) => op.kind === "copy" || op.kind === "cut");
    const geometry = this.#geometry;
    const fitsOneBatch = (items: readonly DisplayInputEvent[]) =>
      items.length <= maxDisplayInputEvents &&
      serializedBatchBytes(geometry ?? 0, items) <= maxDisplayInputBytes;
    if (fitsOneBatch(events)) return this.input(geometry, events, copy, true);
    const last = operations.at(-1)!;
    const prefix = groups.slice(0, -1).flat();
    if (last.kind === "paste" && prefix.length > 0 && fitsOneBatch(prefix)) {
      await this.input(geometry, prefix, copy, true);
      return this.send(last);
    }
    throw this.#refuse("too-large", refusalWords["too-large"]);
  };
  input(
    geometry: number | null,
    events: readonly DisplayInputEvent[],
    copy = false,
    atomic = false,
  ): Promise<ViewerClipboardResult | undefined> {
    for (const event of events) this.#count(this.diagnostics.operations, event.kind);
    const snapshot = this.#lease.getSnapshot();
    if (
      this.#disposed ||
      !this.#scope ||
      geometry === null ||
      snapshot.display?.state !== "live" ||
      geometry !== snapshot.display.generation
    )
      return Promise.reject(this.#refuse("stale", "The display changed. Try again."));
    const incomingChars = countEventsCharacters(events);
    if (
      this.#pending.size > 0 &&
      (this.#queuedEvents + events.length > maxQueuedEvents ||
        this.#queuedChars + incomingChars > maxQueuedChars)
    )
      return Promise.reject(
        this.#refuse("capacity", "This device is still catching up. Try again."),
      );
    const mutatesClipboard = clipboardMutation(events);
    return new Promise((resolve, reject) => {
      const caller: Caller = {
        ...(mutatesClipboard ? { mutatesClipboard } : {}),
        sent: false,
        remainingEvents: events.length,
        settled: false,
        resolve,
        reject,
      };
      this.#enqueue(geometry, events, copy, atomic, caller, mutatesClipboard, incomingChars);
      if (!this.#pending.size) this.#drain();
    });
  }
  #enqueue(
    geometry: number,
    events: readonly DisplayInputEvent[],
    copy: boolean,
    atomic: boolean,
    caller: Caller,
    mutatesClipboard: "paste" | "cut" | undefined,
    incomingChars: number,
  ): void {
    const tail = this.#queue.at(-1);
    if (
      tail &&
      !atomic &&
      !copy &&
      !tail.atomic &&
      !tail.copy &&
      tail.geometry === geometry &&
      tail.mutatesClipboard === mutatesClipboard &&
      tail.events.length === 1 &&
      events.length === 1
    ) {
      const merged = mergeDisplayInput(tail.events[0]!, events[0]!);
      if (merged) {
        const beforeChars = eventCharacters(tail.events[0]!);
        const afterChars = eventCharacters(merged);
        tail.events[0] = merged;
        tail.callers.push(caller);
        this.#queuedChars += afterChars - beforeChars;
        return;
      }
    }
    this.#queue.push({
      geometry,
      events: [...events],
      copy,
      ...(mutatesClipboard ? { mutatesClipboard } : {}),
      atomic,
      callers: [caller],
    });
    this.#queuedEvents += events.length;
    this.#queuedChars += incomingChars;
  }
  /** Packs the head of `#queue` into one wire batch and sends it at the device's pace. */
  #drain(): void {
    if (this.#pending.size || !this.#queue.length) return;
    const head = this.#queue[0]!;
    const geometry = head.geometry;
    const batchEvents: DisplayInputEvent[] = [];
    const batchCallers: BatchCaller[] = [];
    let batchBytes = 0;
    let batchCopy = false;
    let batchAtomic = false;
    let batchMutatesClipboard: "paste" | "cut" | undefined;

    while (this.#queue.length) {
      const entry = this.#queue[0]!;
      if (entry.geometry !== geometry) break;
      if (entry.copy || entry.atomic) {
        if (batchEvents.length) break;
        this.#queue.shift();
        this.#queuedEvents -= entry.events.length;
        this.#queuedChars -= countEventsCharacters(entry.events);
        batchEvents.push(...entry.events);
        for (const caller of entry.callers)
          batchCallers.push({ caller, eventsTaken: entry.events.length });
        batchCopy = entry.copy;
        batchAtomic = entry.atomic;
        batchMutatesClipboard = entry.mutatesClipboard;
        break;
      }
      let taken = 0;
      while (taken < entry.events.length) {
        if (batchEvents.length >= maxDisplayInputEvents) break;
        const event = entry.events[taken]!;
        // Keep a key press paired with its immediately following release when at the 64-event cap.
        if (
          batchEvents.length === maxDisplayInputEvents - 1 &&
          event.kind === "key" &&
          event.action === "down"
        ) {
          const following =
            taken + 1 < entry.events.length ? entry.events[taken + 1] : this.#queue[1]?.events[0];
          if (
            following?.kind === "key" &&
            following.action === "up" &&
            following.code === event.code
          )
            break;
        }
        const eventBytes = encoder.encode(JSON.stringify(event)).byteLength + 1;
        if (batchEvents.length > 0) {
          const estimate = batchEnvelopeOverheadBytes + batchBytes + eventBytes;
          if (
            estimate > maxDisplayInputBytes &&
            serializedBatchBytes(geometry, [...batchEvents, event]) > maxDisplayInputBytes
          )
            break;
        }
        batchEvents.push(event);
        batchBytes += eventBytes;
        taken += 1;
      }
      if (taken === 0) break;
      const consumed = entry.events.splice(0, taken);
      this.#queuedEvents -= taken;
      this.#queuedChars -= countEventsCharacters(consumed);
      if (entry.mutatesClipboard) batchMutatesClipboard ??= entry.mutatesClipboard;
      for (const caller of entry.callers) batchCallers.push({ caller, eventsTaken: taken });
      if (!entry.events.length) this.#queue.shift();
      else break;
    }

    if (!batchEvents.length) return;
    this.#transmit(
      geometry,
      batchEvents,
      batchCallers,
      batchCopy,
      batchAtomic,
      batchMutatesClipboard,
    );
  }
  #transmit(
    geometry: number,
    events: readonly DisplayInputEvent[],
    callers: readonly BatchCaller[],
    copy: boolean,
    atomic: boolean,
    mutatesClipboard: "paste" | "cut" | undefined,
  ): void {
    const chars = countEventsCharacters(events);
    const pending: Pending = {
      copy,
      ...(mutatesClipboard ? { mutatesClipboard } : {}),
      onlyMove: events.length > 0 && events.every(isMove),
      chars,
      sent: false,
      sequences: new Set(),
      callers,
      timer: setTimeout(
        () =>
          this.#stopBurst(pending, "timeout", {
            fallbackText: "This device didn’t respond. Try again.",
            recordReceipt: true,
          }),
        batchTimeoutMs,
      ),
    };
    try {
      if (
        !this.#lease.input(
          geometry,
          events,
          (sequence) => {
            pending.sent = true;
            for (const { caller } of pending.callers) caller.sent = true;
            pending.sequences.add(sequence);
            this.#pending.set(sequence, pending);
          },
          atomic ? { atomic: true } : undefined,
        )
      )
        this.#stopBurst(pending, "send-failed", {
          fallbackText: "Input is unavailable.",
          recordReceipt: false,
        });
    } catch (error) {
      if (pending.sent && pending.mutatesClipboard) {
        this.#stopBurst(pending, "send-failed", {
          fallbackText: "This edit couldn’t be sent.",
          recordReceipt: false,
        });
        return;
      }
      if (error instanceof DisplayInputTooLargeError) {
        this.#stopBurst(pending, "refused", {
          fallbackText: refusalWords["too-large"],
          recordReceipt: true,
          refusalReason: "too-large",
          refusalMessage: refusalWords["too-large"],
        });
        return;
      }
      if (pending.sent) {
        this.#stopBurst(pending, "send-failed", {
          fallbackText: "This edit couldn’t be sent. Try again.",
          recordReceipt: true,
          refusalReason: "unavailable",
          refusalMessage: "This edit couldn’t be sent. Try again.",
        });
        return;
      }
      this.#finish(
        pending,
        error instanceof Error ? error : new Error("This edit couldn’t be sent."),
      );
    }
  }
  dispose(): void {
    // Flush leading queued release-only events (key up / mouse cancel for already-sent presses)
    // before teardown drops the rest of the queue.
    if (this.#scope !== null && this.#geometry !== null) {
      const releases: DisplayInputEvent[] = [];
      for (const entry of this.#queue) {
        if (entry.atomic || entry.copy || !entry.events.every(isRelease)) break;
        releases.push(...entry.events);
      }
      if (releases.length) {
        try {
          this.#lease.input(this.#geometry, releases);
        } catch {
          /* Teardown follows with display.input-reset. */
        }
      }
    }
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#cancel("The display changed. Try again.", "changed");
    this.#listeners.clear();
  }
}

function isMove(event: DisplayInputEvent): boolean {
  return (event.kind === "mouse" || event.kind === "pointer") && event.phase === "move";
}

function isRelease(event: DisplayInputEvent): boolean {
  return event.kind === "pointer" || event.kind === "mouse"
    ? event.phase === "up" || event.phase === "cancel"
    : event.kind === "key" && event.action === "up";
}

function clipboardMutation(events: readonly DisplayInputEvent[]): "paste" | "cut" | undefined {
  if (events.some((event) => event.kind === "paste")) return "paste";
  if (events.some((event) => event.kind === "cut")) return "cut";
  return undefined;
}

function eventCharacters(event: DisplayInputEvent): number {
  switch (event.kind) {
    case "key":
      return event.action === "down" && event.text !== undefined ? [...event.text].length : 0;
    case "edit":
      return [...event.edit.text].length;
    case "paste":
      return "text" in event ? [...event.text].length : 0;
    case "text":
      return "insert" in event ? [...event.insert].length : 0;
    default:
      return 0;
  }
}

function countEventsCharacters(events: readonly DisplayInputEvent[]): number {
  let total = 0;
  for (const event of events) total += eventCharacters(event);
  return total;
}

function serializedBatchBytes(geometry: number, events: readonly DisplayInputEvent[]): number {
  return encoder.encode(
    JSON.stringify({
      type: "display.input",
      geometry,
      sequence: Number.MAX_SAFE_INTEGER,
      events,
    }),
  ).byteLength;
}

function characterCountWords(count: number): string {
  return count === 1 ? "1 character" : `${count} characters`;
}

function stoppedBurstWords(options: {
  readonly delivered: number;
  readonly uncertain: number;
  readonly unsent: number;
  readonly cause: "timeout" | "changed" | "send-failed" | "refused";
  readonly detail?: string;
}): string {
  const arrived = `${characterCountWords(options.delivered)} arrived`;
  if (options.cause === "refused") {
    const rest = options.unsent > 0 ? "; the rest was not sent." : ".";
    return options.detail
      ? `Stopped typing: ${arrived}${rest} ${options.detail}`
      : `Stopped typing: ${arrived}${rest}`;
  }
  const why =
    options.cause === "timeout"
      ? "before the device stopped responding"
      : options.cause === "changed"
        ? "before the display changed"
        : "before input stopped";
  const tail: string[] = [];
  if (options.uncertain > 0)
    tail.push(
      options.unsent > 0
        ? `the next ${options.uncertain} may have arrived`
        : `the last ${options.uncertain} may have arrived`,
    );
  if (options.unsent > 0) tail.push("the rest was not sent");
  return tail.length
    ? `Stopped typing: ${arrived} ${why}; ${tail.join(", and ")}.`
    : `Stopped typing: ${arrived} ${why}.`;
}
