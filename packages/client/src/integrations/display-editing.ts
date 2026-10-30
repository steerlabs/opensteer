import {
  displayPasteTextMaxLength,
  type DisplayInputEvent,
  type DisplayInputRefusal,
} from "@opensteer/protocol";
import { EditingClipboardItemsSchema, type EditingContext } from "@opensteer/protocol/editing";
import type { EditingOperation, EditingTargetAbilities } from "../editing/types.js";
import type { ViewerClipboardResult } from "../host/browser-editing.js";
import { mergeDisplayInput } from "./display-input.js";
import type { DisplayEditingMessage, DisplayLease } from "./phone-display-stream.js";

/** Rich data is forwarded as metadata so the producer explicitly refuses it. */
export const displayEditingAbilities: EditingTargetAbilities = {
  composition: false,
  rangeEdits: true,
  commands: true,
  clipboard: "full",
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
interface Pending {
  readonly copy: boolean;
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
    this.#cancel("The display changed. Try again.");
    this.#set({ context: null, receipt: null });
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
  #sendHeld(): void {
    const held = this.#held;
    if (!held) return;
    this.#held = null;
    void this.#transmit(held.geometry, held.events).then(
      (result) => held.callers.forEach((caller) => caller.resolve(result)),
      (error: Error) => held.callers.forEach((caller) => caller.reject(error)),
    );
  }
  #cancel(reason: string): void {
    const held = this.#held;
    this.#held = null;
    for (const caller of held?.callers ?? []) caller.reject(new Error(reason));
    for (const pending of new Set(this.#pending.values())) this.#finish(pending, new Error(reason));
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
  send = async (operation: EditingOperation): Promise<ViewerClipboardResult | undefined> => {
    // Losing the lease already releases native holds; cleanup must not become a new edit.
    if (!this.#scope && operation.kind === "key" && operation.keystroke.action === "up")
      return undefined;
    let events: DisplayInputEvent[];
    switch (operation.kind) {
      case "key":
        events = [{ kind: "key", ...operation.keystroke }];
        break;
      case "command":
        events = [{ kind: "command", command: operation.command }];
        break;
      case "edit":
        events = [{ kind: "edit", edit: operation.edit }];
        break;
      case "copy":
        events = [{ kind: "copy" }];
        break;
      case "cut":
        if (this.#lease.getSnapshot().display?.displayCut !== 1 || !this.#state.context?.field) {
          this.#count(this.diagnostics.operations, operation.kind);
          throw this.#refuse("unsupported", "Cut isn’t supported by this device.");
        }
        events = [{ kind: "cut", contextId: this.#state.context.contextId }];
        break;
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
        if (operation.items.some((item) => item.type !== "text/plain")) {
          events = [{ kind: "paste", items: metadata.data }];
        } else {
          const text = operation.items
            .map((item) => new TextDecoder("utf-8", { fatal: true }).decode(item.bytes))
            .join("");
          events = [];
          let piece = "";
          for (const character of text) {
            if (piece.length + character.length > displayPasteTextMaxLength) {
              events.push({ kind: "paste", text: piece });
              piece = "";
            }
            piece += character;
          }
          if (piece) events.push({ kind: "paste", text: piece });
          if (!events.length) return undefined;
        }
        break;
      }
    }
    return this.input(
      this.#geometry,
      events,
      operation.kind === "copy" || operation.kind === "cut",
    );
  };
  input(
    geometry: number | null,
    events: readonly DisplayInputEvent[],
    copy = false,
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
    if (this.#pending.size && events.length && events.every(merges)) {
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
    this.#sendHeld();
    return this.#transmit(geometry, events, copy);
  }
  #transmit(
    geometry: number,
    events: readonly DisplayInputEvent[],
    copy = false,
  ): Promise<ViewerClipboardResult | undefined> {
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        copy,
        resolve,
        reject,
        sequences: new Set(),
        timer: setTimeout(
          () =>
            this.#finish(
              pending,
              this.#refuse("timeout", "This device didn’t respond. Try again."),
            ),
          10000,
        ),
      };
      try {
        if (
          !this.#lease.input(geometry, events, (sequence) => {
            pending.sequences.add(sequence);
            this.#pending.set(sequence, pending);
          })
        )
          this.#finish(pending, new Error("Input is unavailable."));
      } catch (error) {
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
