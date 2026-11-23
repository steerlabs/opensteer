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
  unavailable: "Input is unavailable.",
  contended: "Another viewer is pressing. Try again.",
};
const unknownClipboardWords = {
  paste: "May have been pasted: check before pasting again.",
  cut: "May have been cut: check before cutting again.",
} as const;
interface Pending {
  readonly copy: boolean;
  readonly mutatesClipboard?: "paste" | "cut";
  /** True once `lease.input` registered a sequence and handed the batch to the socket. */
  sent: boolean;
  dispatched?: true;
  clipboardRefusal?: { readonly reason: string; readonly message: string };
  readonly sequences: Set<number>;
  readonly resolve: (result: ViewerClipboardResult | undefined) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
/** Movement waiting for the producer to answer this view's earlier input. */
interface Held {
  readonly geometry: number;
  readonly events: DisplayInputEvent[];
  readonly callers: Pick<Pending, "resolve" | "reject">[];
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
  readonly #unsubscribe: readonly (() => void)[];
  #state: DisplayEditingSnapshot = { context: null, receipt: null };
  #scope: string | null = null;
  #geometry: number | null = null;
  #disposed = false;
  #held: Held | null = null;

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
    if (geometry === null) this.#cancel("The display changed. Try again.");
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
    const preservedReceipt = this.#cancel("The display changed. Try again.");
    this.#set({ context: null, ...(preservedReceipt ? {} : { receipt: null }) });
  }
  #set(patch: Partial<DisplayEditingSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #count(record: Record<string, number>, kind: string): void {
    record[kind] = (record[kind] ?? 0) + 1;
  }
  #finish(pending: Pending, error?: Error, result?: ViewerClipboardResult): void {
    clearTimeout(pending.timer);
    for (const sequence of pending.sequences) this.#pending.delete(sequence);
    pending.sequences.clear();
    if (error) pending.reject(error);
    else pending.resolve(result);
    if (!this.#pending.size) this.#sendHeld();
  }
  /** All held movement goes before other input; otherwise one wire batch per answer. */
  #sendHeld(all = false): void {
    const held = this.#held;
    if (!held) return;
    const events = all ? held.events : held.events.splice(0, maxDisplayInputEvents);
    if (all || !held.events.length) this.#held = null;
    const sent = this.#transmit(held.geometry, events);
    // Callers settle with the last piece; an earlier piece's refusal is its receipt.
    if (this.#held === held) void sent.catch(() => undefined);
    else
      void sent.then(
        (result) => held.callers.forEach((caller) => caller.resolve(result)),
        (error: Error) => held.callers.forEach((caller) => caller.reject(error)),
      );
  }
  #carrierEnded(pending: Pending, reason: Error, recordTimeoutReceipt: boolean): boolean {
    // Q1 (AGENTS.md rule 4): once a paste or cut batch has left this client onto the carrier,
    // never report it as failed or invite a blind retry on timeout or display/carrier change.
    if (pending.sent && pending.mutatesClipboard) {
      this.#count(this.diagnostics.clipboard, "unknown");
      this.#set({ receipt: unknownClipboardWords[pending.mutatesClipboard] });
      this.#finish(pending, undefined, { outcome: "unknown", items: [] });
      return true;
    }
    this.#finish(pending, recordTimeoutReceipt ? this.#refuse("timeout", reason.message) : reason);
    return false;
  }
  #cancel(reason: string): boolean {
    const held = this.#held;
    this.#held = null;
    for (const caller of held?.callers ?? []) caller.reject(new Error(reason));
    let preservedReceipt = false;
    for (const pending of new Set(this.#pending.values()))
      if (this.#carrierEnded(pending, new Error(reason), false)) preservedReceipt = true;
    return preservedReceipt;
  }
  #refuse(reason: string, message: string): Error {
    this.#count(this.diagnostics.refusals, reason);
    this.#set({ receipt: message });
    return new Error(message);
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
          items: text ? [{ type: "text/plain", bytes: new TextEncoder().encode(text) }] : [],
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
          this.#finish(pending, this.#refuse(refusal.reason, refusal.message));
        else pending.clipboardRefusal = refusal;
      }
      return;
    }
    if (message.outcome !== "dispatched") {
      const reason = message.reason ?? (message.outcome === "stale" ? "stale" : "unsupported");
      this.#finish(pending, this.#refuse(reason, refusalWords[reason]));
    } else {
      this.#set({ receipt: null });
      if (pending.copy) {
        pending.dispatched = true;
        const refusal = pending.clipboardRefusal;
        if (refusal) this.#finish(pending, this.#refuse(refusal.reason, refusal.message));
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
        const text = operation.items
          .map((item) => new TextDecoder("utf-8", { fatal: true }).decode(item.bytes))
          .join("");
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
      new TextEncoder().encode(
        JSON.stringify({
          type: "display.input",
          geometry: geometry ?? 0,
          sequence: Number.MAX_SAFE_INTEGER,
          events: items,
        }),
      ).byteLength <= maxDisplayInputBytes;
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
    // The producer's lane is short and a frame is shorter than its answer: movement
    // and wheel turns wait for this view's earlier input to be answered, merged.
    if (!atomic && this.#pending.size && events.length && events.every(merges)) {
      const held = (this.#held ??= { geometry, events: [], callers: [] });
      for (const event of events) {
        const last = held.events.at(-1);
        const merged = last ? mergeDisplayInput(last, event) : null;
        if (merged) held.events[held.events.length - 1] = merged;
        else held.events.push(event);
      }
      return new Promise((resolve, reject) => held.callers.push({ resolve, reject }));
    }
    if (this.#pending.size >= 128)
      return Promise.reject(this.#refuse("capacity", "Waiting for this device to respond."));
    // Presses and edits never wait, and follow the movement before them.
    this.#sendHeld(true);
    return this.#transmit(geometry, events, copy, atomic);
  }
  #transmit(
    geometry: number,
    events: readonly DisplayInputEvent[],
    copy = false,
    atomic = false,
  ): Promise<ViewerClipboardResult | undefined> {
    const mutatesClipboard = events.some((event) => event.kind === "paste")
      ? "paste"
      : events.some((event) => event.kind === "cut")
        ? "cut"
        : undefined;
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        copy,
        ...(mutatesClipboard ? { mutatesClipboard } : {}),
        sent: false,
        resolve,
        reject,
        sequences: new Set(),
        timer: setTimeout(
          () =>
            this.#carrierEnded(pending, new Error("This device didn’t respond. Try again."), true),
          10000,
        ),
      };
      try {
        if (
          !this.#lease.input(
            geometry,
            events,
            (sequence) => {
              pending.sent = true;
              pending.sequences.add(sequence);
              this.#pending.set(sequence, pending);
            },
            atomic ? { atomic: true } : undefined,
          )
        )
          this.#finish(pending, new Error("Input is unavailable."));
      } catch (error) {
        if (pending.sent && pending.mutatesClipboard) {
          this.#carrierEnded(
            pending,
            error instanceof Error ? error : new Error("This edit couldn’t be sent."),
            false,
          );
          return;
        }
        if (error instanceof DisplayInputTooLargeError) {
          this.#finish(pending, this.#refuse("too-large", refusalWords["too-large"]));
          return;
        }
        if (pending.sent) {
          this.#finish(
            pending,
            this.#refuse("unavailable", "This edit couldn’t be sent. Try again."),
          );
          return;
        }
        this.#finish(
          pending,
          error instanceof Error ? error : new Error("This edit couldn’t be sent."),
        );
      }
    });
  }
  dispose(): void {
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#cancel("The display changed. Try again.");
    this.#listeners.clear();
  }
}

function merges(event: DisplayInputEvent): boolean {
  return (
    event.kind === "scroll" ||
    ((event.kind === "mouse" || event.kind === "pointer") && event.phase === "move")
  );
}
