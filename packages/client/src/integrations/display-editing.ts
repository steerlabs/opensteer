import {
  displayPasteTextMaxLength,
  displayInputPatienceMs,
  trackHeldDisplayInput,
  type DisplayInputEvent,
  type DisplayInputRefusal,
} from "@opensteer/protocol";
import { EditingClipboardItemsSchema, type EditingContext } from "@opensteer/protocol/editing";
import type { EditingOperation, EditingTargetAbilities } from "../editing/types.js";
import type { ViewerClipboardResult } from "../host/browser-editing.js";
import { mergeDisplayInput } from "./display-input.js";
import {
  DisplayInputTooLargeError,
  displayInputFrame,
  maxDisplayInputBytes,
  maxDisplayInputEvents,
  type DisplayEditingMessage,
  type DisplayLease,
} from "./phone-display-stream.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const batchEnvelopeOverheadBytes = 128;
const maxQueuedEvents = 8_192;
const maxQueuedBytes = 2 * 1_024 * 1_024;
const stoppedWords = "Typing stopped. Some of it may not have arrived: check the text.";

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
interface Caller {
  readonly mutatesClipboard?: "paste" | "cut";
  remainingEvents: number;
  settled: boolean;
  readonly resolve: (result: ViewerClipboardResult | undefined) => void;
  readonly reject: (error: Error) => void;
}
interface Queued {
  readonly geometry: number;
  readonly events: DisplayInputEvent[];
  readonly eventBytes: number[];
  readonly copy: boolean;
  readonly mutatesClipboard?: "paste" | "cut";
  readonly atomic: boolean;
  caller: Caller;
}
interface Pending {
  readonly copy: boolean;
  readonly atomic: boolean;
  readonly eventCount: number;
  readonly onlyMove: boolean;
  readonly mayHaveEffect: boolean;
  readonly affectsHold: boolean;
  readonly deadline: number;
  readonly mutatesClipboard?: "paste" | "cut";
  /** True once `lease.input` registered a sequence and handed the batch to the socket. */
  sent: boolean;
  dispatched?: true;
  clipboardResult?: ViewerClipboardResult;
  clipboardRefusal?: { readonly reason: string; readonly message: string };
  readonly sequences: Set<number>;
  readonly callers: readonly { readonly caller: Caller; readonly eventsTaken: number }[];
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
 * Input stopped mid-burst: queued input was dropped and never sent, and anything in flight may
 * have landed (never resent).
 */
export class DisplayEditingStopped extends Error {
  constructor(message = stoppedWords) {
    super(message);
    this.name = "DisplayEditingStopped";
  }
}

type StopCause =
  "unknown" | "timeout" | "refused" | "send-failed" | "bound" | "changed" | "reset" | "dispose";

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
  readonly #held = new Set<string>();
  readonly #unsubscribe: readonly (() => void)[];
  #state: DisplayEditingSnapshot = { context: null, receipt: null };
  #scope: string | null = null;
  #geometry: number | null = null;
  #disposed = false;
  #queuedEvents = 0;
  #queuedBytes = 0;

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
    const previous = this.#geometry;
    if (previous === geometry) return;
    this.#geometry = geometry;
    if (previous !== null)
      this.#stop("changed", "The display changed. Try again.", { releaseGeometry: null });
  }
  /** Stops queued input, releases what this view holds down, and resets the lease. */
  resetInput(): void {
    this.#stop("reset", "The display changed. Try again.", { resetLease: true });
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
    const preservedReceipt = this.#stop("changed", "The display changed. Try again.", {
      releaseGeometry: null,
    });
    this.#set({ context: null, ...(preservedReceipt ? {} : { receipt: null }) });
  }
  #set(patch: Partial<DisplayEditingSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #count(record: Record<string, number>, kind: string): void {
    record[kind] = (record[kind] ?? 0) + 1;
  }
  #settle(caller: Caller, error?: Error, result?: ViewerClipboardResult): void {
    if (caller.settled) return;
    caller.settled = true;
    if (error) caller.reject(error);
    else caller.resolve(result);
  }
  #finish(pending: Pending, result?: ViewerClipboardResult): void {
    clearTimeout(pending.timer);
    for (const sequence of pending.sequences) this.#pending.delete(sequence);
    pending.sequences.clear();
    for (const { caller, eventsTaken } of pending.callers) {
      caller.remainingEvents -= eventsTaken;
      if (caller.remainingEvents <= 0) this.#settle(caller, undefined, result);
    }
    if (!this.#pending.size && this.#queue.length) this.#drain();
  }
  /**
   * One stop path for timeout, refusal, send failure, the queue bound, blur, layout/scope change
   * and dispose: clears pending batches so late receipts do nothing, drops queued ordinary input,
   * and releases what this view holds down before settling callers.
   */
  #stop(
    cause: StopCause,
    message: string,
    options: {
      readonly reason?: string;
      readonly settledRefusal?: boolean;
      readonly recordReceipt?: boolean;
      readonly resetLease?: boolean;
      readonly releaseGeometry?: number | null;
      readonly unregistered?: Pending;
    } = {},
  ): boolean {
    const pendingList = [...new Set(this.#pending.values())];
    if (options.unregistered) pendingList.push(options.unregistered);
    for (const pending of pendingList) {
      clearTimeout(pending.timer);
      for (const sequence of pending.sequences) this.#pending.delete(sequence);
      pending.sequences.clear();
    }
    const needsReset = pendingList.some(
      (pending) => pending.sent && !pending.dispatched && pending.affectsHold,
    );
    const unknown = pendingList.some(
      (pending) =>
        pending.sent && pending.mayHaveEffect && (pending.dispatched || !options.settledRefusal),
    );
    // Pure pointer/mouse moves with nothing held recover on a live refusal or timeout.
    if (
      (cause === "timeout" || cause === "refused") &&
      !this.#disposed &&
      this.#scope !== null &&
      this.#geometry !== null &&
      this.#held.size === 0 &&
      pendingList.length > 0 &&
      pendingList.every((pending) => pending.onlyMove) &&
      this.#queue.length > 0 &&
      this.#queue.every((entry) => !entry.atomic && !entry.copy && entry.events.every(isMove))
    ) {
      const error = this.#refuse(
        options.reason ?? "timeout",
        message,
        options.settledRefusal === true,
      );
      for (const pending of pendingList)
        for (const { caller } of pending.callers) this.#settle(caller, error);
      this.#drain();
      return true;
    }

    const dropped = this.#queue.splice(0);
    this.#queuedEvents = 0;
    this.#queuedBytes = 0;
    const wasHeld = this.#held.size > 0;
    const releaseGeometry =
      options.releaseGeometry !== undefined ? options.releaseGeometry : this.#geometry;
    const releases: DisplayInputEvent[] = [];
    if (wasHeld && !this.#disposed && this.#scope !== null && releaseGeometry !== null) {
      for (const entry of dropped)
        if (entry.geometry === releaseGeometry)
          for (const event of entry.events)
            if (releasesHeld(this.#held, event)) {
              releases.push(event);
              trackHeldDisplayInput(this.#held, event);
            }
    }
    if (releases.length > 0 && releaseGeometry !== null) {
      try {
        this.#lease.input(releaseGeometry, releases);
      } catch {
        /* `resetInput` follows whenever this view held anything down. */
      }
    }
    if (needsReset || wasHeld || options.resetLease) {
      this.#held.clear();
      this.#lease.resetInput();
    }

    const packedMulti = pendingList.some((pending) => !pending.atomic && pending.eventCount > 1);
    const nonMove =
      pendingList.some((pending) => !pending.onlyMove) ||
      dropped.some((entry) => entry.copy || entry.atomic || !entry.events.every(isMove));
    const isStoppedBurst =
      unknown ||
      cause === "bound" ||
      (cause !== "reset" &&
        cause !== "dispose" &&
        nonMove &&
        (packedMulti ||
          dropped.length > 0 ||
          (cause === "timeout" && !pendingList.every((pending) => pending.copy))));

    let preservedReceipt = false;
    let error: Error;
    if (isStoppedBurst) {
      const diag =
        options.reason ??
        (cause === "bound" ? "capacity" : cause === "timeout" ? "timeout" : undefined);
      if (diag) this.#count(this.diagnostics.refusals, diag);
      this.#set({ receipt: stoppedWords });
      preservedReceipt = true;
      error = new DisplayEditingStopped(stoppedWords);
    } else if (options.recordReceipt) {
      error = this.#refuse(
        options.reason ?? "unavailable",
        message,
        options.settledRefusal === true,
      );
    } else {
      error = new Error(message);
    }

    for (const pending of pendingList)
      for (const { caller } of pending.callers) {
        if (unknown && caller.mutatesClipboard) this.#count(this.diagnostics.clipboard, "unknown");
        this.#settle(caller, error);
      }
    for (const entry of dropped) this.#settle(entry.caller, error);
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
    if (
      performance.now() >= pending.deadline ||
      (message.type === "display.input.result" && message.outcome === "unknown")
    ) {
      this.#stop("unknown", "This device didn’t respond. Try again.", {
        reason: "unknown",
        recordReceipt: true,
      });
      return;
    }
    if (message.type === "display.clipboard") {
      if (!pending.copy) return;
      this.#count(this.diagnostics.clipboard, message.outcome);
      if (
        message.outcome === "copied" ||
        message.outcome === "cut" ||
        message.outcome === "empty"
      ) {
        const text = message.outcome !== "empty" ? message.text : undefined;
        const result: ViewerClipboardResult = {
          outcome: text ? message.outcome : "empty",
          items: text ? [{ type: "text/plain", bytes: encoder.encode(text) }] : [],
        };
        if (pending.mayHaveEffect && !pending.dispatched) pending.clipboardResult = result;
        else this.#finish(pending, result);
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
          this.#stop("refused", refusal.message, {
            reason: refusal.reason,
            settledRefusal: true,
            recordReceipt: true,
          });
        else pending.clipboardRefusal = refusal;
      }
      return;
    }
    if (message.outcome !== "dispatched") {
      const reason = message.reason ?? (message.outcome === "stale" ? "stale" : "unsupported");
      this.#stop("refused", refusalWords[reason], {
        reason,
        settledRefusal: true,
        recordReceipt: true,
      });
    } else {
      this.#set({ receipt: null });
      if (pending.copy) {
        pending.dispatched = true;
        const refusal = pending.clipboardRefusal;
        if (pending.clipboardResult) this.#finish(pending, pending.clipboardResult);
        else if (refusal)
          this.#stop("refused", refusal.message, {
            reason: refusal.reason,
            settledRefusal: true,
            recordReceipt: true,
          });
        return;
      }
      this.#pending.delete(message.sequence);
      pending.sequences.delete(message.sequence);
      if (!pending.sequences.size) this.#finish(pending);
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
        return splitPasteEvents(text, operation.contextId, this.#geometry ?? 0);
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
    const mutatesClipboard = events.some((event) => event.kind === "paste")
      ? "paste"
      : events.some((event) => event.kind === "cut")
        ? "cut"
        : undefined;
    const tail = this.#queue.at(-1);
    const merged =
      tail &&
      !atomic &&
      !copy &&
      !tail.atomic &&
      !tail.copy &&
      tail.geometry === geometry &&
      tail.mutatesClipboard === mutatesClipboard &&
      tail.events.length === 1 &&
      events.length === 1 &&
      merges(tail.events[0]!) &&
      merges(events[0]!)
        ? mergeDisplayInput(tail.events[0]!, events[0]!)
        : null;
    const eventBytes = merged ? [serializedEventBytes(merged)] : events.map(serializedEventBytes);
    const nextEvents = merged ? this.#queuedEvents : this.#queuedEvents + events.length;
    const nextBytes = merged
      ? this.#queuedBytes - tail!.eventBytes[0]! + eventBytes[0]!
      : this.#queuedBytes + eventBytes.reduce((sum, bytes) => sum + bytes, 0);
    if (nextEvents > maxQueuedEvents || nextBytes > maxQueuedBytes) {
      this.#stop("bound", stoppedWords, { reason: "capacity" });
      return Promise.reject(new DisplayEditingStopped(stoppedWords));
    }
    return new Promise((resolve, reject) => {
      const caller: Caller = {
        ...(mutatesClipboard ? { mutatesClipboard } : {}),
        remainingEvents: merged ? 1 : events.length,
        settled: false,
        resolve,
        reject,
      };
      if (merged && tail) {
        // The older move/scroll is superseded: settle it now so coalescing retains one caller.
        this.#settle(tail.caller);
        tail.events[0] = merged;
        tail.eventBytes[0] = eventBytes[0]!;
        tail.caller = caller;
      } else {
        this.#queue.push({
          geometry,
          events: [...events],
          eventBytes,
          copy,
          ...(mutatesClipboard ? { mutatesClipboard } : {}),
          atomic,
          caller,
        });
      }
      this.#queuedEvents = nextEvents;
      this.#queuedBytes = nextBytes;
      if (!this.#pending.size) this.#drain();
    });
  }
  /** Packs the head of `#queue` into one wire batch and sends it at the device's pace. */
  #drain(): void {
    if (this.#pending.size || !this.#queue.length) return;
    const geometry = this.#queue[0]!.geometry;
    const batchEvents: DisplayInputEvent[] = [];
    const batchCallers: { readonly caller: Caller; readonly eventsTaken: number }[] = [];
    let batchBytes = 0;
    let batchCopy = false;
    let batchAtomic = false;
    let batchMutatesClipboard: "paste" | "cut" | undefined;
    let hasPointerOrMouse = false;
    let hasKeyboardOrEdit = false;

    while (this.#queue.length) {
      const entry = this.#queue[0]!;
      if (entry.geometry !== geometry) break;
      if (entry.copy || entry.atomic) {
        if (batchEvents.length) break;
        this.#queue.shift();
        this.#queuedEvents -= entry.events.length;
        this.#queuedBytes -= entry.eventBytes.reduce((sum, bytes) => sum + bytes, 0);
        batchEvents.push(...entry.events);
        batchCallers.push({ caller: entry.caller, eventsTaken: entry.events.length });
        batchCopy = entry.copy;
        batchAtomic = entry.atomic;
        batchMutatesClipboard = entry.mutatesClipboard;
        break;
      }
      let taken = 0;
      let takenBytes = 0;
      while (taken < entry.events.length && batchEvents.length < maxDisplayInputEvents) {
        const event = entry.events[taken]!;
        // Keep mouse/pointer events out of keyboard/edit batches across the entire batch (even
        // with neutral events such as scroll in between) so click focus settles before per-key
        // Accessibility checks run, leaving the next class at the head of `#queue`.
        if (
          (hasPointerOrMouse && isKeyboardOrEdit(event)) ||
          (hasKeyboardOrEdit && isPointerOrMouse(event))
        )
          break;
        // Keep a key press paired with its immediately following release at the 64-event cap.
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
        const bytes = entry.eventBytes[taken]!;
        if (
          batchEvents.length > 0 &&
          batchEnvelopeOverheadBytes + batchBytes + bytes > maxDisplayInputBytes &&
          serializedBatchBytes(geometry, [...batchEvents, event]) > maxDisplayInputBytes
        )
          break;
        batchEvents.push(event);
        if (isPointerOrMouse(event)) hasPointerOrMouse = true;
        else if (isKeyboardOrEdit(event)) hasKeyboardOrEdit = true;
        batchBytes += bytes;
        takenBytes += bytes;
        taken += 1;
      }
      if (taken === 0) break;
      entry.events.splice(0, taken);
      entry.eventBytes.splice(0, taken);
      this.#queuedEvents -= taken;
      this.#queuedBytes -= takenBytes;
      if (entry.mutatesClipboard) batchMutatesClipboard ??= entry.mutatesClipboard;
      batchCallers.push({ caller: entry.caller, eventsTaken: taken });
      if (!entry.events.length) this.#queue.shift();
      else break;
    }

    if (batchEvents.length)
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
    callers: readonly { readonly caller: Caller; readonly eventsTaken: number }[],
    copy: boolean,
    atomic: boolean,
    mutatesClipboard: "paste" | "cut" | undefined,
  ): void {
    const deadline = performance.now() + displayInputPatienceMs;
    const pending: Pending = {
      deadline,
      copy,
      atomic,
      eventCount: events.length,
      onlyMove: events.length > 0 && events.every(isMove),
      affectsHold:
        this.#held.size > 0 ||
        events.some(
          (event) =>
            event.kind === "key" ||
            ((event.kind === "pointer" || event.kind === "mouse") && event.phase !== "move"),
        ),
      mayHaveEffect: events.some(
        (event) => event.kind !== "copy" && (!isMove(event) || this.#held.size > 0),
      ),
      ...(mutatesClipboard ? { mutatesClipboard } : {}),
      sent: false,
      sequences: new Set(),
      callers,
      timer: setTimeout(
        () =>
          this.#stop("timeout", "This device didn’t respond. Try again.", {
            reason: "timeout",
            recordReceipt: true,
          }),
        displayInputPatienceMs,
      ),
    };
    try {
      if (
        !this.#lease.input(
          geometry,
          events,
          (sequence) => {
            if (!pending.sent) {
              pending.sent = true;
              for (const event of events) trackHeldDisplayInput(this.#held, event);
            }
            pending.sequences.add(sequence);
            this.#pending.set(sequence, pending);
          },
          { atomic, inputDeadline: deadline },
        )
      )
        this.#stop(
          "send-failed",
          "Input is unavailable.",
          pending.sent ? {} : { unregistered: pending },
        );
    } catch (error) {
      const unregistered = pending.sent ? {} : { unregistered: pending };
      if (pending.sent && pending.mutatesClipboard) {
        this.#stop("send-failed", "This edit couldn’t be sent.");
      } else if (error instanceof DisplayInputTooLargeError) {
        this.#stop("refused", refusalWords["too-large"], {
          reason: "too-large",
          settledRefusal: true,
          recordReceipt: true,
          ...unregistered,
        });
      } else {
        this.#stop(
          "send-failed",
          pending.sent ? "This edit couldn’t be sent. Try again." : "This edit couldn’t be sent.",
          { reason: "unavailable", recordReceipt: pending.sent, ...unregistered },
        );
      }
    }
  }
  dispose(): void {
    this.#stop("dispose", "The display changed. Try again.");
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#listeners.clear();
  }
}

function isPointerOrMouse(event: DisplayInputEvent): boolean {
  return event.kind === "mouse" || event.kind === "pointer";
}
function isKeyboardOrEdit(event: DisplayInputEvent): boolean {
  return (
    event.kind === "key" ||
    event.kind === "command" ||
    event.kind === "edit" ||
    event.kind === "paste"
  );
}
function isMove(event: DisplayInputEvent): boolean {
  return (event.kind === "mouse" || event.kind === "pointer") && event.phase === "move";
}
function merges(event: DisplayInputEvent): boolean {
  return event.kind === "scroll" || isMove(event);
}
function releasesHeld(held: ReadonlySet<string>, event: DisplayInputEvent): boolean {
  if (event.kind === "pointer")
    return (event.phase === "up" || event.phase === "cancel") && held.has("pointer");
  if (event.kind === "mouse") {
    if (event.phase === "up") return held.has(`mouse:${event.button}`);
    return event.phase === "cancel" && [...held].some((item) => item.startsWith("mouse:"));
  }
  return event.kind === "key" && event.action === "up" && held.has(`key:${event.code}`);
}
function serializedEventBytes(event: DisplayInputEvent): number {
  return encoder.encode(JSON.stringify(event)).byteLength + 1;
}
function serializedBatchBytes(geometry: number, events: readonly DisplayInputEvent[]): number {
  return encoder.encode(
    JSON.stringify(displayInputFrame(geometry, Number.MAX_SAFE_INTEGER, events)),
  ).byteLength;
}
function jsonStringCharBytes(ch: string): number {
  const code = ch.charCodeAt(0);
  if (ch.length === 1 && code >= 0x20 && code <= 0x7e)
    return code === 0x22 || code === 0x5c ? 2 : 1;
  return encoder.encode(JSON.stringify(ch)).byteLength - 2;
}
function splitPasteEvents(text: string, contextId: string, geometry: number): DisplayInputEvent[] {
  const maxPieceBytes =
    maxDisplayInputBytes - serializedBatchBytes(geometry, [{ kind: "paste", text: "", contextId }]);
  const events: DisplayInputEvent[] = [];
  let piece = "";
  let pieceBytes = 0;
  for (const character of text) {
    const charBytes = jsonStringCharBytes(character);
    if (
      piece.length + character.length > displayPasteTextMaxLength ||
      pieceBytes + charBytes > maxPieceBytes
    ) {
      events.push({ kind: "paste", text: piece, contextId });
      piece = "";
      pieceBytes = 0;
    }
    piece += character;
    pieceBytes += charBytes;
  }
  if (piece) events.push({ kind: "paste", text: piece, contextId });
  return events;
}
