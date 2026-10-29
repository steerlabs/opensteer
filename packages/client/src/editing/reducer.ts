import { countGraphemes } from "unicode-segmenter/grapheme";
import {
  editingTextMaxLength,
  type EditingContext,
  type EditingTextEdit,
} from "@opensteer/protocol/editing";
import { deletionEditingCommand, editingModifiers, resolveEditingBinding } from "./bindings.js";
import type {
  EditingOperation,
  EditingKeyState,
  EditingProxyEvent,
  EditingProxyInstruction,
  EditingProxyState,
  EditingStep,
  EditingTargetAbilities,
  EditingViewerPlatform,
} from "./types.js";

const blank: EditingProxyState = { value: "", selectionStart: 0, selectionEnd: 0 };
interface Composition {
  readonly contextId: string | null;
  readonly base: EditingProxyState;
  readonly caret: number;
  readonly text: string;
  readonly nativeText: string;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly echo: EditingProxyState | null;
  readonly before: string;
  readonly after: string;
  readonly start: number;
  readonly end: number;
  readonly sent: boolean;
  readonly detached: boolean;
}
export interface EditingState {
  readonly platform: EditingViewerPlatform;
  readonly abilities: EditingTargetAbilities;
  readonly context: EditingContext | null;
  readonly proxy: EditingProxyState;
  readonly caret: number;
  readonly composition: Composition | null;
  readonly pendingEcho: { readonly expected: EditingProxyState } | null;
  readonly replacement?: string | null;
  readonly nativeKey?: EditingKeyState | "choice" | null;
  readonly compositionTail: "commit" | "discard" | null;
  readonly suppressedInput: string | null;
  readonly down: readonly EditingKeyState[];
  readonly resetPending: boolean;
}
export interface EditingReduction extends EditingStep {
  readonly state: EditingState;
  readonly refusal?: "commands" | "clipboard" | "range-edits" | "too-large";
}
export function createEditingState(
  platform: EditingViewerPlatform,
  abilities: EditingTargetAbilities,
): EditingState {
  return {
    platform,
    abilities,
    context: null,
    proxy: blank,
    caret: 0,
    composition: null,
    pendingEcho: null,
    replacement: null,
    nativeKey: null,
    compositionTail: null,
    suppressedInput: null,
    down: [],
    resetPending: false,
  };
}
function printable(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 64 &&
    countGraphemes(key) === 1 &&
    [...key].every((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0x20 && code !== 0x7f;
    })
  );
}
function insert(proxy: EditingProxyState, text: string): EditingProxyState {
  const value =
    proxy.value.slice(0, proxy.selectionStart) + text + proxy.value.slice(proxy.selectionEnd);
  const selectionStart = proxy.selectionStart + text.length;
  return { value, selectionStart, selectionEnd: selectionStart };
}
function difference(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  // Keep surrogate pairs intact even when a native edit changes their low surrogate.
  if (start > 0 && start < before.length && /[\uDC00-\uDFFF]/u.test(before[start]!)) start--;
  let end = before.length,
    nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  if (end < before.length && /[\uDC00-\uDFFF]/u.test(before[end]!)) {
    end++;
    nextEnd++;
  }
  return { start, end, text: after.slice(start, nextEnd) };
}
/** Native input supplies the final value; range verification stays with the target. */
function textEdit(
  old: EditingProxyState,
  next: EditingProxyState,
  caret: number,
  contextId: string,
  replacement: string | null,
): EditingTextEdit | null | "unverified" {
  let diff = difference(old.value, next.value);
  if (replacement !== null) {
    let range: { start: number; end: number; text: string } | null = null;
    for (const start of new Set([
      next.selectionEnd - replacement.length,
      next.value.lastIndexOf(replacement, next.selectionEnd),
      diff.start,
    ])) {
      const candidate = snapshotCompositionRange(
        old.value,
        next,
        start,
        start + replacement.length,
      );
      if (
        candidate?.text === replacement &&
        (old.value === next.value || (candidate.start <= diff.start && candidate.end >= diff.end))
      ) {
        range = candidate;
        break;
      }
    }
    if (!range) return "unverified";
    diff = range;
  } else if (old.value === next.value) return null;
  const start = Math.min(diff.start, caret),
    end = Math.max(diff.end, caret);
  const text = old.value.slice(start, diff.start) + diff.text + old.value.slice(diff.end, end);
  return {
    contextId,
    text,
    before: old.value.slice(start, caret),
    after: old.value.slice(caret, end),
  };
}
function compositionText(
  transaction: Composition,
  rawStart: number,
  rawEnd: number,
  nativeText: string,
): Composition {
  const start = Math.min(rawStart, transaction.caret),
    end = Math.max(rawEnd, transaction.caret);
  return {
    ...transaction,
    rawStart,
    rawEnd,
    nativeText,
    start,
    end,
    text:
      transaction.base.value.slice(start, rawStart) +
      nativeText +
      transaction.base.value.slice(rawEnd, end),
    before: transaction.base.value.slice(start, transaction.caret),
    after: transaction.base.value.slice(transaction.caret, end),
  };
}
function snapshotCompositionRange(
  base: string,
  proxy: EditingProxyState,
  start: number,
  end: number,
): { start: number; end: number; text: string } | null {
  const oldEnd = end + base.length - proxy.value.length;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > proxy.value.length ||
    oldEnd < start ||
    oldEnd > base.length ||
    base.slice(0, start) !== proxy.value.slice(0, start) ||
    base.slice(oldEnd) !== proxy.value.slice(end)
  )
    return null;
  return { start, end: oldEnd, text: proxy.value.slice(start, end) };
}
function composingValue(
  transaction: Composition,
  proxy: EditingProxyState,
  commitText?: string,
): Composition {
  const marked = proxy.markedRange;
  if (
    marked &&
    (commitText === undefined || proxy.value.slice(marked.start, marked.end) === commitText)
  ) {
    const range = snapshotCompositionRange(transaction.base.value, proxy, marked.start, marked.end);
    if (range) return compositionText(transaction, range.start, range.end, range.text);
  }
  const nativeText = commitText ?? transaction.nativeText;
  if (nativeText) {
    for (const start of new Set([
      proxy.selectionEnd - nativeText.length,
      transaction.rawStart,
      transaction.base.selectionStart,
    ])) {
      const end = start + nativeText.length;
      if (
        proxy.selectionStart < start ||
        proxy.selectionEnd > end ||
        proxy.value.slice(start, end) !== nativeText
      )
        continue;
      const range = snapshotCompositionRange(transaction.base.value, proxy, start, end);
      if (range) return compositionText(transaction, range.start, range.end, nativeText);
    }
  }
  if (commitText !== undefined)
    return compositionText(transaction, transaction.rawStart, transaction.rawEnd, commitText);
  const diff = difference(transaction.base.value, proxy.value);
  const start = Math.min(transaction.base.selectionStart, diff.start),
    end = Math.max(transaction.base.selectionEnd, diff.end);
  return compositionText(
    transaction,
    start,
    end,
    proxy.value.slice(start, proxy.value.length - (transaction.base.value.length - end)),
  );
}

/** Pure event-order reduction. The adapter owns when a proxy instruction is applied. */
export function reduceEditing(previous: EditingState, event: EditingProxyEvent): EditingReduction {
  let state = { ...previous };
  if (event.type === "beforeinput")
    state.replacement =
      !state.composition && event.inputType === "insertReplacementText" ? event.data : null;
  const operations: EditingOperation[] = [];
  let instruction: EditingProxyInstruction = {};
  let refusal: EditingReduction["refusal"];
  const prevent = () => {
    instruction = { ...instruction, preventDefault: true };
  };
  const emit = (operation: EditingOperation): boolean => {
    if (operation.kind === "compose" && !state.abilities.composition) return false;
    if (operation.kind === "command" && !state.abilities.commands) {
      refusal = "commands";
      return false;
    }
    if (
      (operation.kind === "copy" || operation.kind === "cut" || operation.kind === "paste") &&
      state.abilities.clipboard === "none"
    ) {
      refusal = "clipboard";
      return false;
    }
    const text =
      operation.kind === "edit"
        ? operation.edit
        : operation.kind === "compose"
          ? operation.composition
          : null;
    if (
      text &&
      [text.text, text.before ?? "", text.after ?? ""].some(
        (value) => value.length > editingTextMaxLength,
      )
    ) {
      refusal = "too-large";
      return false;
    }
    operations.push(operation);
    return true;
  };
  const reset = () => {
    state.pendingEcho = null;
    state.replacement = null;
    state.nativeKey = null;
    if (state.composition) {
      state.resetPending = true;
      return;
    }
    state.proxy = blank;
    state.caret = 0;
    state.resetPending = false;
    instruction = { ...instruction, set: blank };
  };
  const commit = (transaction: Composition, text: string) => {
    if (!transaction.contextId) return;
    if (!text) {
      if (transaction.sent)
        emit({
          kind: "compose",
          composition: {
            contextId: transaction.contextId,
            text: "",
            selectionStart: 0,
            selectionEnd: 0,
          },
        });
      return;
    }
    const range = transaction.sent
      ? { before: "", after: "" }
      : { before: transaction.before, after: transaction.after };
    if (!state.abilities.rangeEdits && (range.before || range.after)) {
      refusal = "range-edits";
      return;
    }
    if (
      !emit({ kind: "edit", edit: { contextId: transaction.contextId, text, ...range } }) &&
      transaction.sent
    )
      commit(transaction, "");
  };
  const interrupt = () => {
    const transaction = state.composition;
    if (transaction && !transaction.detached) {
      commit(transaction, transaction.text);
      state.composition = { ...transaction, detached: true };
    }
    reset();
  };
  const isReturn = (inputType: string) =>
    inputType === "insertLineBreak" || inputType === "insertParagraph";
  const softReturn = (before = false) => {
    if (
      (before || state.suppressedInput !== "return") &&
      !state.down.some((key) => key.key === "Enter")
    ) {
      for (const action of ["down", "up"] as const)
        emit({ kind: "key", keystroke: { action, key: "Enter", code: "Enter", modifiers: [] } });
    }
    reset();
    state.suppressedInput = "return";
  };
  const printableKey = (key: EditingKeyState) => {
    const expected = insert(state.proxy, key.key);
    emit({
      kind: "key",
      keystroke: {
        action: "down",
        key: key.key,
        code: key.code,
        modifiers: editingModifiers(key, state.platform),
        location: key.location,
        repeat: key.repeat,
        text: key.key,
      },
    });
    state.pendingEcho = { expected };
    state.caret = expected.selectionEnd;
    if (!state.down.some((held) => (held.code || held.key) === (key.code || key.key)))
      state.down = [...state.down, key];
  };
  const nativeKeyInput = (inputType: string, data: string | null) => {
    const key = state.nativeKey;
    state.nativeKey = null;
    if (key && typeof key !== "string" && inputType === "insertText" && data === key.key)
      printableKey(key);
  };
  const move = (from: number, to: number, text: string) => {
    const distance = countGraphemes(text.slice(Math.min(from, to), Math.max(from, to)));
    for (let count = 0; count < distance; count++)
      emit({ kind: "command", command: to < from ? "moveBackward" : "moveForward" });
  };
  const publishComposition = (transaction: Composition, proxy: EditingProxyState): Composition => {
    if (!transaction.contextId || !state.abilities.composition) return transaction;
    if (!state.abilities.rangeEdits && (transaction.before || transaction.after)) {
      refusal = "range-edits";
      return { ...transaction, detached: true };
    }
    const selectionStart = Math.max(
      0,
      Math.min(transaction.text.length, proxy.selectionStart - transaction.start),
    );
    const selectionEnd = Math.max(
      selectionStart,
      Math.min(transaction.text.length, proxy.selectionEnd - transaction.start),
    );
    const emitted = emit({
      kind: "compose",
      composition: {
        contextId: transaction.contextId,
        text: transaction.text,
        selectionStart,
        selectionEnd,
        ...(!transaction.sent ? { before: transaction.before, after: transaction.after } : {}),
      },
    });
    if (!emitted) {
      commit(transaction, "");
      state.resetPending = true;
      return { ...transaction, detached: true };
    }
    return { ...transaction, sent: true };
  };
  switch (event.type) {
    case "context": {
      if (state.context?.contextId !== event.context?.contextId) {
        interrupt();
        state.compositionTail = null;
      }
      state.context = event.context;
      break;
    }
    case "pointerdown":
    case "blur":
      interrupt();
      if (event.type === "blur") {
        for (const key of state.down)
          emit({
            kind: "key",
            keystroke: {
              action: "up",
              key: key.key,
              code: key.code,
              modifiers: [],
              location: key.location,
              repeat: false,
            },
          });
        state.down = [];
      }
      break;
    case "compositionstart": {
      if (state.composition?.detached) break;
      const echo = state.pendingEcho?.expected;
      const base = echo ?? state.proxy;
      // A normal key can reach the target before the IME claims its native echo.
      const takeover = echo && event.proxy.value === state.proxy.value;
      const start = Math.min(
          base.value.length,
          takeover ? state.proxy.selectionStart : event.proxy.selectionStart,
        ),
        end = Math.min(base.value.length, takeover ? echo.selectionEnd : event.proxy.selectionEnd);
      state.pendingEcho = null;
      state.replacement = null;
      state.nativeKey = null;
      state.compositionTail = null;
      state.proxy = base;
      state.composition = {
        contextId: state.context?.contextId ?? null,
        base: { ...base, selectionStart: start, selectionEnd: end },
        caret: state.caret,
        text: "",
        nativeText: "",
        rawStart: start,
        rawEnd: end,
        echo: null,
        before: "",
        after: "",
        start,
        end,
        sent: false,
        detached: false,
      };
      break;
    }
    case "compositionupdate": {
      const previous = state.composition;
      if (!previous || previous.detached) break;
      let transaction: Composition = {
        ...compositionText(previous, previous.rawStart, previous.rawEnd, event.data),
        echo: null,
      };
      const marked = event.proxy.markedRange;
      if (marked) {
        const range = snapshotCompositionRange(
          previous.base.value,
          event.proxy,
          marked.start,
          marked.end,
        );
        if (!range) {
          refusal = "range-edits";
          commit(previous, "");
          state.composition = { ...previous, detached: true };
          state.resetPending = true;
          break;
        }
        transaction = compositionText(previous, range.start, range.end, range.text);
        state.proxy = event.proxy;
        transaction = publishComposition(transaction, event.proxy);
        if (transaction.sent) transaction = { ...transaction, echo: event.proxy };
      }
      state.composition = transaction;
      break;
    }
    case "compositionend": {
      const transaction = state.composition;
      if (!transaction) break;
      let proxy = event.proxy,
        remoteCaret = proxy.selectionEnd;
      if (!transaction.detached) {
        if (!event.data) commit(transaction, "");
        else {
          const final = composingValue(transaction, event.proxy, event.data);
          commit(final, final.text);
          const value =
            final.base.value.slice(0, final.rawStart) +
            event.data +
            final.base.value.slice(final.rawEnd);
          if (proxy.value !== value)
            proxy = {
              value,
              selectionStart: final.rawStart + event.data.length,
              selectionEnd: final.rawStart + event.data.length,
            };
          const appliedCaret = final.start + final.text.length;
          if (proxy.selectionStart === proxy.selectionEnd) {
            move(appliedCaret, proxy.selectionEnd, value);
            if (!state.abilities.commands && appliedCaret !== proxy.selectionEnd)
              state.resetPending = true;
          } else remoteCaret = appliedCaret;
        }
      }
      state.composition = null;
      state.pendingEcho = null;
      state.compositionTail = transaction.detached ? "discard" : "commit";
      state.proxy = proxy;
      state.caret = proxy.selectionStart === proxy.selectionEnd ? proxy.selectionEnd : remoteCaret;
      if (transaction.detached || state.resetPending || !state.abilities.rangeEdits) reset();
      break;
    }
    case "keydown":
    case "keyup": {
      const identity = event.code || event.key;
      if (event.type === "keyup") {
        const native = state.nativeKey;
        if (native && typeof native !== "string" && (native.code || native.key) === identity)
          state.nativeKey = "choice";
        if (state.down.some((key) => (key.code || key.key) === identity)) {
          emit({
            kind: "key",
            keystroke: {
              action: "up",
              key: event.key,
              code: event.code,
              modifiers: editingModifiers(event, state.platform),
              location: event.location,
              repeat: event.repeat,
            },
          });
          state.down = state.down.filter((key) => (key.code || key.key) !== identity);
        }
        break;
      }
      if (
        event.composing ||
        state.composition ||
        ["Dead", "Process", "Unidentified"].includes(event.key)
      )
        break;
      // Character Viewer consumes the local keyup; its activation must not hold remote Space.
      if (
        state.platform === "mac" &&
        event.key === " " &&
        event.control &&
        event.meta &&
        !event.alt &&
        !event.shift
      )
        break;
      state.compositionTail = null;
      state.suppressedInput = null;
      state.replacement = null;
      if (
        state.resetPending ||
        (!state.abilities.rangeEdits && state.proxy.value) ||
        state.proxy.value.length >= editingTextMaxLength
      )
        reset();
      if (["Shift", "Control", "Meta", "Alt", "AltGraph", "CapsLock"].includes(event.key)) break;
      const text =
        !event.meta && (!event.control || event.altGraph) && printable(event.key)
          ? event.key
          : undefined;
      if (state.nativeKey) {
        if (text) state.nativeKey = event;
        else if (event.key === "Escape") state.nativeKey = null;
        break;
      }
      const binding = resolveEditingBinding(event, state.platform);
      if (binding) {
        if (binding.kind === "command") {
          reset();
          prevent();
          emit(binding);
        }
        // Native copy/cut events own clipboard gestures; paste supplies its trusted bytes.
        break;
      }
      if (text) {
        // Native repeat downs may navigate an accent picker without inserting text.
        if (event.repeat && state.platform === "mac") state.nativeKey = event;
        else printableKey(event);
      } else {
        prevent();
        reset();
        emit({
          kind: "key",
          keystroke: {
            action: "down",
            key: event.key,
            code: event.code,
            modifiers: editingModifiers(event, state.platform),
            location: event.location,
            repeat: event.repeat,
          },
        });
        if (event.key === "Enter") state.suppressedInput = "return";
        if (!state.down.some((key) => (key.code || key.key) === identity))
          state.down = [...state.down, event];
      }
      break;
    }
    case "beforeinput": {
      if (state.composition) break;
      nativeKeyInput(event.inputType, event.data);
      if (isReturn(event.inputType)) {
        prevent();
        softReturn(true);
        break;
      }
      if (!["insertFromComposition", "insertCompositionText"].includes(event.inputType))
        state.compositionTail = null;
      const deletion = deletionEditingCommand(event.inputType);
      if (deletion && (!state.proxy.value || !state.abilities.rangeEdits)) {
        prevent();
        emit({ kind: "command", command: deletion });
        state.suppressedInput = event.inputType;
        reset();
      }
      break;
    }
    case "input": {
      const native = state.nativeKey;
      if (native && typeof native !== "string" && !state.composition && !event.composing) {
        const expected = insert(state.proxy, native.key);
        const confirmed =
          expected.value === event.proxy.value &&
          expected.selectionStart === event.proxy.selectionStart &&
          expected.selectionEnd === event.proxy.selectionEnd;
        nativeKeyInput(confirmed ? event.inputType : "", native.key);
      } else state.nativeKey = null;
      const replacement = state.replacement ?? null;
      state.replacement = null;
      if (state.composition) {
        const previous = state.composition;
        if (previous.detached) break;
        let transaction: Composition = { ...composingValue(previous, event.proxy), echo: null };
        const echo =
          previous.echo &&
          previous.echo.value === event.proxy.value &&
          previous.echo.selectionStart === event.proxy.selectionStart &&
          previous.echo.selectionEnd === event.proxy.selectionEnd;
        state.proxy = event.proxy;
        if (!echo) transaction = publishComposition(transaction, event.proxy);
        state.composition = transaction;
        break;
      }
      if (event.composing) break;
      if (isReturn(event.inputType)) {
        softReturn();
        state.suppressedInput = null;
        break;
      }
      if (
        state.compositionTail &&
        ["insertFromComposition", "insertCompositionText"].includes(event.inputType)
      ) {
        const discard = state.compositionTail === "discard";
        state.compositionTail = null;
        if (!discard) {
          state.proxy = event.proxy;
          state.caret = event.proxy.selectionEnd;
        }
        if (!state.abilities.rangeEdits) reset();
        break;
      }
      state.compositionTail = null;
      if (state.suppressedInput === event.inputType) {
        state.suppressedInput = null;
        break;
      }
      const echo = state.pendingEcho;
      state.pendingEcho = null;
      const base = echo?.expected ?? state.proxy;
      const caret = echo?.expected.selectionEnd ?? state.caret;
      const edit = state.context
        ? textEdit(base, event.proxy, caret, state.context.contextId, replacement)
        : null;
      if (edit === "unverified") {
        refusal = "range-edits";
        reset();
        break;
      }
      let remoteCaret = event.proxy.selectionEnd;
      if (edit) {
        if (state.abilities.rangeEdits || (!edit.before && !edit.after)) {
          const emitted = emit({ kind: "edit", edit });
          if (!emitted) {
            reset();
            break;
          }
          const appliedCaret = caret - edit.before.length + edit.text.length;
          if (event.proxy.selectionStart === event.proxy.selectionEnd) {
            move(appliedCaret, event.proxy.selectionEnd, event.proxy.value);
            if (!state.abilities.commands && appliedCaret !== event.proxy.selectionEnd)
              state.resetPending = true;
          } else remoteCaret = appliedCaret;
        } else {
          refusal = "range-edits";
          state.resetPending = true;
        }
      } else if (
        !echo &&
        event.proxy.value === state.proxy.value &&
        event.proxy.selectionStart === event.proxy.selectionEnd
      ) {
        move(state.caret, event.proxy.selectionEnd, event.proxy.value);
        if (!state.abilities.commands && state.caret !== event.proxy.selectionEnd)
          state.resetPending = true;
      }
      state.proxy = event.proxy;
      state.caret = remoteCaret;
      if (!state.abilities.rangeEdits || state.resetPending) reset();
      break;
    }
    case "selection":
      if (!state.composition && !state.pendingEcho && event.proxy.value === state.proxy.value) {
        if (event.proxy.selectionStart === event.proxy.selectionEnd) {
          move(state.caret, event.proxy.selectionEnd, state.proxy.value);
          state.caret = event.proxy.selectionEnd;
        }
        state.proxy = event.proxy;
      }
      break;
    case "copy":
    case "cut": {
      prevent();
      interrupt();
      emit({ kind: event.type });
      break;
    }
    case "paste": {
      prevent();
      interrupt();
      if (
        state.abilities.clipboard === "text" &&
        event.items.some((item) => item.type !== "text/plain")
      ) {
        refusal = "clipboard";
        break;
      }
      if (event.items.length) emit({ kind: "paste", items: event.items });
      break;
    }
  }
  return { state, operations, instruction, ...(refusal ? { refusal } : {}) };
}
