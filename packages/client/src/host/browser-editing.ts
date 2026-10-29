import { BrowserSurfaceIdSchema, type BrowserServerMessage } from "@opensteer/protocol";
import {
  EditingClipboardItemsSchema,
  EditingKeystrokeSchema,
  EditingCompositionSchema,
  EditingTextEditSchema,
  EditingCommandSchema,
  EditingClipboardPartSchema,
  editingClipboardMaxBytes,
  editingClipboardPartMaxBytes,
  type EditingClipboardItem,
  type EditingClipboardOutcome,
  type EditingContext,
} from "@opensteer/protocol/editing";
import { decodeBase64Url, encodeBase64Url } from "@opensteer/shared/base64url";
import type {
  EditingClipboardPayloadItem,
  EditingOperation,
  EditingTargetAbilities,
} from "../editing/types.js";
import type { BrowserCommand } from "./client.js";

export interface ViewerClipboardResult {
  readonly outcome: EditingClipboardOutcome;
  readonly items: readonly EditingClipboardPayloadItem[];
}
export type BrowserContextMenu = Extract<BrowserServerMessage, { type: "browser.contextmenu" }>;
export interface BrowserEditingState {
  readonly negotiated: boolean;
  readonly abilities: EditingTargetAbilities;
  readonly context: EditingContext | null;
  readonly geometryRevision?: number;
  readonly menu: BrowserContextMenu | null;
}
export interface BrowserEditingTarget {
  get(): BrowserEditingState;
  subscribe(listener: () => void): () => void;
  send(operation: EditingOperation): Promise<ViewerClipboardResult | undefined>;
  /** A shown controller is the only recipient of page writes on this client. */
  activate(
    onWritten: (items: readonly EditingClipboardPayloadItem[]) => void,
    onError?: (message: string) => void,
  ): () => void;
  dismissMenu(): void;
}
const full: EditingTargetAbilities = {
  composition: true,
  rangeEdits: true,
  commands: true,
  clipboard: "full",
};
const textClipboard: EditingTargetAbilities = { ...full, clipboard: "text" };
const baseline: EditingTargetAbilities = {
  composition: false,
  rangeEdits: false,
  commands: true,
  clipboard: "text",
};
const empty: BrowserEditingState = {
  negotiated: false,
  abilities: baseline,
  context: null,
  menu: null,
};
interface Target {
  readonly sessionId: string;
  readonly surfaceId: string;
  state: BrowserEditingState;
  readonly listeners: Set<() => void>;
  active: {
    onWritten: (items: readonly EditingClipboardPayloadItem[]) => void;
    onError?: ((message: string) => void) | undefined;
  } | null;
}
interface Pending {
  readonly target: Target;
  readonly resolve: (result: ViewerClipboardResult) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly kind: "copy" | "cut" | "paste" | "written";
  items: readonly EditingClipboardItem[] | null;
  outcome: EditingClipboardOutcome;
  chunks: Uint8Array[];
  received: number;
}

/** The socket owns negotiation and bytes; only a retained viewer owns clipboard effects. */
export class BrowserEditingStore {
  readonly diagnostics = {
    operations: {} as Record<string, number>,
    clipboard: {} as Record<string, number>,
    refusals: {} as Record<string, number>,
    contexts: 0,
  };
  readonly #targets = new Map<string, Target>();
  readonly #versions = new Map<string, EditingTargetAbilities>();
  readonly #pending = new Map<string, Pending>();
  #buffered = 0;
  readonly sendCommand: (sessionId: string, surfaceId: string, command: BrowserCommand) => void;
  readonly legacyPlatform: (sessionId: string) => "mac" | "pc" | null;
  constructor(
    sendCommand: (sessionId: string, surfaceId: string, command: BrowserCommand) => void,
    legacyPlatform: (sessionId: string) => "mac" | "pc" | null = () => null,
  ) {
    this.sendCommand = sendCommand;
    this.legacyPlatform = legacyPlatform;
  }
  #target(sessionId: string, surfaceId: string): Target {
    const key = JSON.stringify([sessionId, surfaceId]);
    let target = this.#targets.get(key);
    if (!target) {
      target = {
        sessionId,
        surfaceId,
        state: this.#versions.get(sessionId)
          ? { ...empty, negotiated: true, abilities: this.#versions.get(sessionId)! }
          : empty,
        listeners: new Set(),
        active: null,
      };
      this.#targets.set(key, target);
    }
    return target;
  }
  #set(target: Target, state: BrowserEditingState): void {
    target.state = state;
    for (const listener of target.listeners) listener();
  }
  target(sessionId: string, surfaceId: string): BrowserEditingTarget {
    const target = this.#target(sessionId, surfaceId);
    return {
      get: () => target.state,
      subscribe: (listener) => {
        target.listeners.add(listener);
        return () => target.listeners.delete(listener);
      },
      send: (operation) =>
        this.#send(target, operation).catch((reason) => {
          this.#count(this.diagnostics.refusals, "operation-refused");
          throw reason;
        }),
      activate: (onWritten, onError) => {
        const active = { onWritten, onError };
        target.active = active;
        return () => {
          if (target.active !== active) return;
          target.active = null;
          this.#cancel(target, "The browser viewer is no longer active.");
        };
      },
      dismissMenu: () => {
        if (target.state.menu) this.#set(target, { ...target.state, menu: null });
      },
    };
  }
  negotiate(
    sessionId: string,
    version: 1 | 2 | undefined,
    surfaceId?: string,
    clipboard?: boolean,
  ): void {
    const abilities =
      version === 1 || (version === 2 && clipboard === true)
        ? full
        : version === 2
          ? textClipboard
          : baseline;
    if (!surfaceId) {
      if (version) this.#versions.set(sessionId, abilities);
      else this.#versions.delete(sessionId);
    }
    for (const target of this.#targets.values()) {
      if (target.sessionId !== sessionId || (surfaceId && target.surfaceId !== surfaceId)) continue;
      this.#set(target, {
        ...empty,
        negotiated: version !== undefined,
        abilities,
      });
    }
    if (surfaceId) {
      const target = this.#target(sessionId, surfaceId);
      this.#set(target, {
        ...empty,
        negotiated: version !== undefined,
        abilities,
      });
    }
  }
  #count(record: Record<string, number>, kind: string): void {
    record[kind] = (record[kind] ?? 0) + 1;
  }
  async #send(
    target: Target,
    operation: EditingOperation,
  ): Promise<ViewerClipboardResult | undefined> {
    const surfaceId = BrowserSurfaceIdSchema.parse(target.surfaceId);
    const send = (command: BrowserCommand) =>
      this.sendCommand(target.sessionId, target.surfaceId, command);
    this.#count(this.diagnostics.operations, operation.kind);
    if (
      !target.state.negotiated ||
      (target.state.abilities.clipboard !== "full" &&
        (operation.kind === "copy" || operation.kind === "cut" || operation.kind === "paste"))
    )
      return this.#legacy(target, operation, send);
    switch (operation.kind) {
      case "key":
        send({
          type: "input.key",
          surfaceId,
          ...EditingKeystrokeSchema.parse(operation.keystroke),
        });
        return;
      case "command":
        send({
          type: "input.command",
          surfaceId,
          command: EditingCommandSchema.parse(operation.command),
        });
        return;
      case "compose":
        send({
          type: "input.compose",
          surfaceId,
          composition: EditingCompositionSchema.parse(operation.composition),
        });
        return;
      case "edit":
        send({ type: "input.text", surfaceId, edit: EditingTextEditSchema.parse(operation.edit) });
        return;
      case "copy":
      case "cut":
      case "paste": {
        const items =
          operation.kind === "paste"
            ? EditingClipboardItemsSchema.parse(
                operation.items.map((item) => ({
                  type: item.type,
                  ...(item.name ? { name: item.name } : {}),
                  size: item.bytes.byteLength,
                })),
              )
            : null;
        const operationId = crypto.randomUUID();
        const result = this.#await(operationId, target, operation.kind);
        try {
          if (operation.kind !== "paste")
            send({
              type: operation.kind === "copy" ? "clipboard.copy" : "clipboard.cut",
              surfaceId,
              operationId,
            });
          else {
            send({ type: "clipboard.paste-data", surfaceId, operationId, items: [...items!] });
            const data = new Uint8Array(
              operation.items.reduce((total, item) => total + item.bytes.byteLength, 0),
            );
            let offset = 0;
            for (const item of operation.items) {
              data.set(item.bytes, offset);
              offset += item.bytes.byteLength;
            }
            for (
              let index = 0;
              index < Math.max(1, Math.ceil(data.length / editingClipboardPartMaxBytes));
              index++
            ) {
              const bytes = data.subarray(
                index * editingClipboardPartMaxBytes,
                (index + 1) * editingClipboardPartMaxBytes,
              );
              const unpadded = encodeBase64Url(bytes).replaceAll("-", "+").replaceAll("_", "/");
              const encoded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
              send({ type: "clipboard.part", part: { operationId, index, data: encoded } });
            }
          }
        } catch (error) {
          this.#fail(
            operationId,
            error instanceof Error ? error : new Error("Clipboard transport failed."),
          );
        }
        return result;
      }
    }
  }
  #await(id: string, target: Target, kind: Pending["kind"]): Promise<ViewerClipboardResult> {
    if (this.#pending.size >= 16) throw new Error("Too many pending clipboard operations.");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail(id, new Error("The remote clipboard operation timed out.")),
        10_000,
      );
      this.#pending.set(id, {
        target,
        kind,
        timer,
        resolve,
        reject,
        items: null,
        outcome: "empty",
        chunks: [],
        received: 0,
      });
    });
  }
  #take(id: string): Pending | undefined {
    const pending = this.#pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.#buffered -= pending.received;
      this.#pending.delete(id);
    }
    return pending;
  }
  #fail(id: string, reason: Error): void {
    const pending = this.#take(id);
    if (!pending) return;
    this.#count(this.diagnostics.refusals, "clipboard-transport");
    pending.reject(reason);
  }
  #finish(id: string): void {
    const pending = this.#take(id);
    if (!pending) return;
    const bytes = new Uint8Array(pending.received);
    let offset = 0;
    for (const chunk of pending.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    offset = 0;
    const items = (pending.items ?? []).map((item) => {
      const payload: EditingClipboardPayloadItem = {
        type: item.type,
        ...(item.name ? { name: item.name } : {}),
        bytes: bytes.slice(offset, offset + item.size),
      };
      offset += item.size;
      return payload;
    });
    this.#count(this.diagnostics.clipboard, pending.outcome);
    pending.resolve({ outcome: pending.outcome, items });
  }
  receive(sessionId: string, message: BrowserServerMessage): void {
    if (message.type === "browser.editing" || message.type === "browser.contextmenu") {
      const target = this.#target(sessionId, message.surfaceId);
      if (!target.state.negotiated) return;
      if (message.type === "browser.editing") {
        this.diagnostics.contexts++;
        this.#set(target, {
          ...target.state,
          context: message.context,
          ...(message.geometryRevision === undefined
            ? {}
            : { geometryRevision: message.geometryRevision }),
        });
      } else if (target.active) this.#set(target, { ...target.state, menu: message });
      return;
    }
    if (message.type === "clipboard.data") {
      const entry = [...this.#pending].find(
        ([, pending]) =>
          pending.target.sessionId === sessionId &&
          pending.target.state.abilities.clipboard !== "full" &&
          (message.surfaceId === undefined || pending.target.surfaceId === message.surfaceId) &&
          (pending.kind === "copy" || pending.kind === "cut"),
      );
      if (!entry) return;
      const [id, pending] = entry;
      const bytes = new TextEncoder().encode(message.text);
      pending.items = [{ type: "text/plain", size: bytes.length }];
      pending.outcome = pending.kind === "cut" ? "cut" : "copied";
      pending.chunks = [bytes];
      pending.received = bytes.length;
      this.#buffered += bytes.length;
      this.#finish(id);
      return;
    }
    if (message.type === "clipboard.result" || message.type === "clipboard.written") {
      let pending = this.#pending.get(message.operationId);
      if (message.type === "clipboard.written") {
        const target = this.#target(sessionId, message.surfaceId);
        if (
          !target.state.negotiated ||
          target.state.abilities.clipboard !== "full" ||
          !target.active ||
          pending
        )
          return;
        const active = target.active;
        if (this.#pending.size >= 16) {
          this.#count(this.diagnostics.refusals, "clipboard-capacity");
          active.onError?.("Too many pending remote clipboard writes.");
          return;
        }
        const result = this.#await(message.operationId, target, "written");
        void result.then(
          (value) => {
            if (target.active === active) active.onWritten(value.items);
          },
          (reason) => {
            this.#count(this.diagnostics.refusals, "page-write-assembly");
            if (target.active === active)
              active.onError?.(
                reason instanceof Error ? reason.message : "The remote clipboard data was invalid.",
              );
          },
        );
        pending = this.#pending.get(message.operationId);
      }
      if (
        !pending ||
        pending.target.sessionId !== sessionId ||
        pending.target.surfaceId !== message.surfaceId
      )
        return;
      if (pending.items) {
        this.#fail(message.operationId, new Error("Duplicate clipboard result."));
        return;
      }
      pending.outcome = message.type === "clipboard.written" ? "copied" : message.outcome;
      pending.items = message.items ? EditingClipboardItemsSchema.parse(message.items) : [];
      if (!message.items || !["copied", "cut"].includes(pending.outcome))
        this.#finish(message.operationId);
      return;
    }
    if (message.type === "clipboard.part") {
      const pending = this.#pending.get(message.part.operationId);
      if (!pending || pending.target.sessionId !== sessionId) return;
      try {
        const part = EditingClipboardPartSchema.parse(message.part);
        if (!pending.items || part.index !== pending.chunks.length)
          throw new Error("Clipboard parts arrived out of order.");
        const bytes = decodeBase64Url(
          part.data.replace(/=+$/u, "").replaceAll("+", "-").replaceAll("/", "_"),
        );
        const expected = pending.items.reduce((total, item) => total + item.size, 0);
        const remaining = expected - pending.received;
        if (
          bytes.length !== Math.min(editingClipboardPartMaxBytes, remaining) ||
          this.#buffered + bytes.length > editingClipboardMaxBytes
        )
          throw new Error("Clipboard parts exceed their declared byte bounds.");
        pending.chunks.push(bytes);
        pending.received += bytes.length;
        this.#buffered += bytes.length;
        if (pending.received === expected) this.#finish(part.operationId);
      } catch (error) {
        this.#fail(
          message.part.operationId,
          error instanceof Error ? error : new Error("Invalid clipboard part."),
        );
      }
    }
  }
  #cancel(target: Target, message: string): void {
    for (const [id, pending] of this.#pending)
      if (pending.target === target) this.#fail(id, new Error(message));
  }
  disconnect(sessionId: string, surfaceId?: string): void {
    if (!surfaceId) this.#versions.delete(sessionId);
    for (const target of this.#targets.values()) {
      if (target.sessionId !== sessionId || (surfaceId && target.surfaceId !== surfaceId)) continue;
      this.#cancel(target, "The browser viewer disconnected.");
      this.#set(target, empty);
    }
  }
  dispose(): void {
    for (const id of this.#pending.keys())
      this.#fail(id, new Error("The browser viewer disconnected."));
    this.#targets.clear();
    this.#versions.clear();
  }
  async #legacy(
    target: Target,
    operation: EditingOperation,
    send: (command: BrowserCommand) => void,
  ): Promise<ViewerClipboardResult | undefined> {
    const surfaceId = BrowserSurfaceIdSchema.parse(target.surfaceId);
    const platform = this.legacyPlatform(target.sessionId);
    const chord = (
      key: string,
      code: string,
      modifiers: ("primary" | "control" | "alt" | "meta" | "shift")[] = [],
    ) => {
      send({ type: "input.key", surfaceId, action: "down", key, code, modifiers });
      send({ type: "input.key", surfaceId, action: "up", key, code, modifiers });
    };
    switch (operation.kind) {
      case "key": {
        const {
          location: _location,
          repeat: _repeat,
          ...key
        } = EditingKeystrokeSchema.parse(operation.keystroke);
        if (!platform && key.modifiers.includes("primary"))
          throw new Error("Update this browser to translate the viewer's primary modifier safely.");
        send({
          type: "input.key",
          surfaceId,
          ...key,
          modifiers: key.modifiers.map((value) =>
            value === "primary" ? (platform === "mac" ? "meta" : "control") : value,
          ),
        });
        return;
      }
      case "edit":
        if (operation.edit.before || operation.edit.after)
          throw new Error("This browser cannot verify range edits.");
        send({ type: "clipboard.paste", surfaceId, text: operation.edit.text });
        return;
      case "compose":
        throw new Error("This browser cannot show live composition.");
      case "paste": {
        if (operation.items.some((item) => item.type !== "text/plain"))
          throw new Error("This browser cannot paste rich clipboard data.");
        send({
          type: "clipboard.paste",
          surfaceId,
          text: operation.items.map((item) => new TextDecoder().decode(item.bytes)).join(""),
        });
        return { outcome: "pasted", items: [] };
      }
      case "copy":
      case "cut": {
        if (!target.state.negotiated && !platform)
          throw new Error("Update this browser to translate clipboard shortcuts safely.");
        if (
          [...this.#pending.values()].some(
            (pending) =>
              pending.target.sessionId === target.sessionId &&
              (pending.kind === "copy" || pending.kind === "cut"),
          )
        )
          throw new Error("Wait for the previous legacy clipboard operation to finish.");
        const id = crypto.randomUUID();
        const result = this.#await(id, target, operation.kind);
        try {
          chord(
            operation.kind === "copy" ? "c" : "x",
            operation.kind === "copy" ? "KeyC" : "KeyX",
            [target.state.negotiated ? "primary" : platform === "mac" ? "meta" : "control"],
          );
        } catch (error) {
          this.#fail(id, error instanceof Error ? error : new Error("Clipboard transport failed."));
        }
        return result;
      }
      case "command": {
        const keys: Partial<
          Record<
            typeof operation.command,
            readonly [string, string, ...("control" | "alt" | "meta" | "shift")[]]
          >
        > = {
          selectAll: ["a", "KeyA", "control"],
          undo: ["z", "KeyZ", "control"],
          redo: ["y", "KeyY", "control"],
          moveBackward: ["ArrowLeft", "ArrowLeft"],
          moveForward: ["ArrowRight", "ArrowRight"],
          moveUp: ["ArrowUp", "ArrowUp"],
          moveDown: ["ArrowDown", "ArrowDown"],
          deleteBackward: ["Backspace", "Backspace"],
          deleteForward: ["Delete", "Delete"],
          moveWordLeft: ["ArrowLeft", "ArrowLeft", "control"],
          moveWordRight: ["ArrowRight", "ArrowRight", "control"],
          moveWordLeftAndModifySelection: ["ArrowLeft", "ArrowLeft", "control", "shift"],
          moveWordRightAndModifySelection: ["ArrowRight", "ArrowRight", "control", "shift"],
          moveToBeginningOfLine: ["Home", "Home"],
          moveToEndOfLine: ["End", "End"],
          moveToBeginningOfLineAndModifySelection: ["Home", "Home", "shift"],
          moveToEndOfLineAndModifySelection: ["End", "End", "shift"],
          moveToBeginningOfDocument: ["Home", "Home", "control"],
          moveToEndOfDocument: ["End", "End", "control"],
          moveToBeginningOfDocumentAndModifySelection: ["Home", "Home", "control", "shift"],
          moveToEndOfDocumentAndModifySelection: ["End", "End", "control", "shift"],
          deleteWordBackward: ["Backspace", "Backspace", "control"],
          deleteWordForward: ["Delete", "Delete", "control"],
        };
        const mac: typeof keys = {
          selectAll: ["a", "KeyA", "meta"],
          undo: ["z", "KeyZ", "meta"],
          redo: ["z", "KeyZ", "meta", "shift"],
          moveBackward: ["ArrowLeft", "ArrowLeft"],
          moveForward: ["ArrowRight", "ArrowRight"],
          moveUp: ["ArrowUp", "ArrowUp"],
          moveDown: ["ArrowDown", "ArrowDown"],
          deleteBackward: ["Backspace", "Backspace"],
          deleteForward: ["Delete", "Delete"],
          moveWordLeft: ["ArrowLeft", "ArrowLeft", "alt"],
          moveWordRight: ["ArrowRight", "ArrowRight", "alt"],
          moveWordLeftAndModifySelection: ["ArrowLeft", "ArrowLeft", "alt", "shift"],
          moveWordRightAndModifySelection: ["ArrowRight", "ArrowRight", "alt", "shift"],
          moveToLeftEndOfLine: ["ArrowLeft", "ArrowLeft", "meta"],
          moveToRightEndOfLine: ["ArrowRight", "ArrowRight", "meta"],
          moveToLeftEndOfLineAndModifySelection: ["ArrowLeft", "ArrowLeft", "meta", "shift"],
          moveToRightEndOfLineAndModifySelection: ["ArrowRight", "ArrowRight", "meta", "shift"],
          moveToBeginningOfLine: ["a", "KeyA", "control"],
          moveToEndOfLine: ["e", "KeyE", "control"],
          moveToBeginningOfLineAndModifySelection: ["a", "KeyA", "control", "shift"],
          moveToEndOfLineAndModifySelection: ["e", "KeyE", "control", "shift"],
          moveToBeginningOfParagraph: ["ArrowUp", "ArrowUp", "alt"],
          moveToEndOfParagraph: ["ArrowDown", "ArrowDown", "alt"],
          moveToBeginningOfParagraphAndModifySelection: ["ArrowUp", "ArrowUp", "alt", "shift"],
          moveToEndOfParagraphAndModifySelection: ["ArrowDown", "ArrowDown", "alt", "shift"],
          moveToBeginningOfDocument: ["ArrowUp", "ArrowUp", "meta"],
          moveToEndOfDocument: ["ArrowDown", "ArrowDown", "meta"],
          moveToBeginningOfDocumentAndModifySelection: ["ArrowUp", "ArrowUp", "meta", "shift"],
          moveToEndOfDocumentAndModifySelection: ["ArrowDown", "ArrowDown", "meta", "shift"],
          deleteWordBackward: ["Backspace", "Backspace", "alt"],
          deleteWordForward: ["Delete", "Delete", "alt"],
          deleteToBeginningOfLine: ["Backspace", "Backspace", "meta"],
          deleteToEndOfParagraph: ["k", "KeyK", "control"],
          transpose: ["t", "KeyT", "control"],
          yank: ["y", "KeyY", "control"],
        };
        const portable = new Set([
          "moveBackward",
          "moveForward",
          "moveUp",
          "moveDown",
          "deleteBackward",
          "deleteForward",
        ]);
        const binding =
          platform === "mac"
            ? mac[operation.command]
            : platform === "pc" || portable.has(operation.command)
              ? keys[operation.command]
              : undefined;
        if (!binding) throw new Error("This command is not exactly representable by this browser.");
        const [key, code, ...modifiers] = binding;
        chord(key, code, modifiers);
        return;
      }
    }
  }
}
