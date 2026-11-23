import { countGraphemes } from "unicode-segmenter/grapheme";
import {
  committedRemainder,
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
  /**
   * CY4: detached by the change of its context, its text committed to the far side then: what was
   * committed. The input method's own commit that follows, in that context's own reducer, still
   * goes as far as it differs from it. An interruption (a click, a blur) sets none: focus may have
   * moved, and what the input method commits after it belongs to no field.
   */
  readonly committed?: string;
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
export const editingRefusalMessages: Record<NonNullable<EditingReduction["refusal"]>, string> = {
  commands: "This target does not support that editing command.",
  clipboard: "This target does not support that clipboard format or operation.",
  "range-edits": "This target cannot verify a text replacement.",
  "too-large": "This native edit exceeds the editing size limit.",
};
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
    // A candidate the text around it matches exactly explains the whole change. One that also
    // holds the plain diff is preferred; with a repeated neighbour the plain diff can sit one
    // character past the replacement, and the exact one is then the replacement.
    let exact: { start: number; end: number; text: string } | null = null;
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
      if (candidate?.text !== replacement) continue;
      exact ??= candidate;
      if (
        old.value === next.value ||
        (candidate.start <= diff.start && candidate.end >= diff.end)
      ) {
        range = candidate;
        break;
      }
    }
    range ??= old.value === next.value ? null : exact;
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
/**
 * Text the person typed at their selection: `next` is `base` with the selection (collapsed or
 * not) replaced by `text`, the caret after it. Anything else (an autocorrect, a deletion) is not.
 */
function typedInsertion(
  base: EditingProxyState,
  next: EditingProxyState,
  inputType: string,
): { start: number; end: number; text: string } | null {
  if (!["insertText", "insertReplacementText", "insertFromComposition"].includes(inputType))
    return null;
  const { selectionStart: start, selectionEnd: end } = base;
  if (next.selectionStart !== next.selectionEnd || start > end) return null;
  const length = next.value.length - (base.value.length - (end - start));
  if (length <= 0 || next.selectionEnd !== start + length) return null;
  const text = next.value.slice(start, start + length);
  if (next.value !== base.value.slice(0, start) + text + base.value.slice(end)) return null;
  return { start, end, text };
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
  // An emptied composition is still its own range when the text outside it is unchanged (a
  // browser cancels with compositionupdate("") and an input, or Safari with deleteCompositionText,
  // before compositionend): a plain diff would widen it over a neighbour that repeats the
  // selection's first character.
  if (commitText === undefined) {
    const range = snapshotCompositionRange(
      transaction.base.value,
      proxy,
      transaction.rawStart,
      transaction.rawStart,
    );
    if (
      range?.end === transaction.rawEnd &&
      proxy.selectionStart === transaction.rawStart &&
      proxy.selectionEnd === transaction.rawStart
    )
      return compositionText(transaction, range.start, range.end, "");
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
  const emit = (computed: EditingOperation): boolean => {
    // CZ3: a command carries the context it was computed for, as an edit does: this reducer's.
    const operation =
      computed.kind === "command" && computed.contextId === undefined && state.context
        ? { ...computed, contextId: state.context.contextId }
        : computed;
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
      if (!transaction.sent) return;
      // A composition sent with the text around it restated (it began over a selection away
      // from the far caret) keeps that text when it is cancelled, as the native field does.
      const restated =
        transaction.base.value.slice(transaction.start, transaction.rawStart) +
        transaction.base.value.slice(transaction.rawEnd, transaction.end);
      if (restated)
        emit({
          kind: "edit",
          edit: { contextId: transaction.contextId, text: restated, before: "", after: "" },
        });
      else
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
    } else if (transaction?.committed !== undefined) {
      // CZ2: a tap or a blur after a change of context ends what that change committed: the
      // input method's commit after it adds nothing.
      const { committed: _committed, ...ended } = transaction;
      state.composition = ended;
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
    case "refused": {
      // CU5: a composition the transport refused never reached the target, and the field is the
      // same one (a change of context ends the composition, and nothing is sent again across it:
      // the reducer cannot know where the person is then). Its next send is a fresh start,
      // restating what it replaces.
      const transaction = state.composition;
      const operation = event.operation;
      if (
        operation.kind === "compose" &&
        transaction &&
        !transaction.detached &&
        transaction.sent &&
        transaction.contextId === operation.composition.contextId &&
        transaction.contextId === state.context?.contextId
      )
        state.composition = { ...transaction, sent: false };
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
      // CY4: the input method commits a composition the change of its context already committed.
      // What it commits goes as an insertion under the composition's own context, deleting
      // nothing: the part after what was committed when that extends it, nothing when it is that,
      // else all of it. Only the reducer of that context sends it (the context left keeps its own
      // reducer; a change of context leaves this one with the composition it ended).
      if (
        transaction.detached &&
        transaction.committed !== undefined &&
        event.data &&
        transaction.contextId &&
        transaction.contextId === state.context?.contextId
      ) {
        const text = committedRemainder(transaction.committed, event.data);
        if (text)
          emit({
            kind: "edit",
            edit: { contextId: transaction.contextId, text, before: "", after: "" },
          });
      }
      if (!transaction.detached) {
        if (!event.data) {
          commit(transaction, "");
          // A cancelled composition's restated text went back in its place: the far caret is
          // after it, and moves to the native caret.
          const restated =
            transaction.base.value.slice(transaction.start, transaction.rawStart) +
            transaction.base.value.slice(transaction.rawEnd, transaction.end);
          if (transaction.sent && restated) {
            const appliedCaret = transaction.start + restated.length;
            if (proxy.selectionStart === proxy.selectionEnd) {
              move(appliedCaret, proxy.selectionEnd, proxy.value);
              if (!state.abilities.commands && appliedCaret !== proxy.selectionEnd)
                state.resetPending = true;
            } else remoteCaret = appliedCaret;
          }
        } else {
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
      if (
        binding &&
        (state.context?.field || state.abilities.basicInput || binding.kind !== "command")
      ) {
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
      // A suppression waits for the input of the beforeinput that set it. Another beforeinput
      // means that input never came (the adapter honoured preventDefault): a later deletion's
      // input is its own, never swallowed for the earlier one.
      state.suppressedInput = null;
      if (state.composition) break;
      if (state.abilities.basicInput && event.inputType === "insertReplacementText") {
        prevent();
        reset();
        break;
      }
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
      } else if (
        deletion &&
        event.inputType.includes("Backward") &&
        state.proxy.selectionStart === 0 &&
        state.proxy.selectionEnd === 0 &&
        !state.pendingEcho
      ) {
        // CV1: a backward deletion at the mirror's start is the page's, at its caret: the page may
        // hold text before it that the mirror does not (it begins where the page's caret was).
        // The mirror after the caret is unchanged either way.
        prevent();
        emit({ kind: "command", command: deletion });
        state.suppressedInput = event.inputType;
      }
      break;
    }
    case "input": {
      if (
        state.abilities.basicInput &&
        event.inputType === "insertReplacementText" &&
        !state.composition
      ) {
        reset();
        break;
      }
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
      // Another input means the suppressed one is not coming (an adapter that reports input
      // without a beforeinput): a later deletion's input, or line break, is its own. No recorded
      // browser puts such an input between an Enter key and its own line break; the inputs there
      // are an IME's commit, which return above.
      state.suppressedInput = null;
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
      // Backspace is the page's, relative to its caret (CU4, CV1): the page's own Backspace goes,
      // never a range deletion the page could find changed, and the mirror takes what the page
      // then holds. A letter written with combining marks loses only its last mark there, where
      // the native field removed the whole letter.
      const at = event.proxy.selectionEnd;
      const removed = base.value.length - event.proxy.value.length;
      if (
        edit &&
        !echo &&
        event.inputType === "deleteContentBackward" &&
        // A Backspace at a caret; a selection deleted is the selection.
        base.selectionStart === base.selectionEnd &&
        state.abilities.commands &&
        event.proxy.selectionStart === at &&
        removed > 0 &&
        caret === at + removed &&
        base.value.slice(0, at) === event.proxy.value.slice(0, at) &&
        base.value.slice(at + removed) === event.proxy.value.slice(at) &&
        countGraphemes(base.value.slice(at, at + removed)) === 1
      ) {
        const letter = base.value.slice(at, at + removed);
        const mark = Array.from(letter).at(-1)!;
        const kept =
          letter.length > mark.length && /\p{M}/u.test(mark)
            ? letter.slice(0, letter.length - mark.length)
            : "";
        emit({ kind: "command", command: "deleteBackward" });
        state.proxy = {
          value: base.value.slice(0, at) + kept + base.value.slice(at + removed),
          selectionStart: at + kept.length,
          selectionEnd: at + kept.length,
        };
        state.caret = at + kept.length;
        if (kept) instruction = { ...instruction, set: state.proxy };
        if (!state.abilities.rangeEdits || state.resetPending) reset();
        break;
      }
      // CV1: what the person types goes as an insertion at the page's caret, with nothing around
      // it the page could find changed: the far caret is brought to where it goes, and over a
      // selection the selection's deletion goes first, on its own (a replacement the page may
      // refuse; the typed text still lands).
      const typed = typedInsertion(base, event.proxy, event.inputType);
      if (
        edit &&
        typed &&
        state.context &&
        state.abilities.commands &&
        (typed.start === typed.end || state.abilities.rangeEdits)
      ) {
        const contextId = state.context.contextId;
        let far = caret;
        if (typed.start < typed.end) {
          const removal = textEdit(
            base,
            {
              value: base.value.slice(0, typed.start) + base.value.slice(typed.end),
              selectionStart: typed.start,
              selectionEnd: typed.start,
            },
            caret,
            contextId,
            null,
          );
          if (removal && removal !== "unverified") {
            if (!emit({ kind: "edit", edit: removal })) {
              reset();
              break;
            }
            far = caret - removal.before.length + removal.text.length;
          }
        }
        const text = base.value.slice(0, typed.start) + base.value.slice(typed.end);
        if (far !== typed.start) move(far, typed.start, text);
        if (!emit({ kind: "edit", edit: { contextId, text: typed.text, before: "", after: "" } })) {
          reset();
          break;
        }
        state.proxy = event.proxy;
        state.caret = event.proxy.selectionEnd;
        if (!state.abilities.rangeEdits || state.resetPending) reset();
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
      if (event.moves !== undefined) {
        // The distances the person moved the caret in a mirror that has since been cleared: the
        // far caret moves by each in turn (stopping at either end, as the page's does). A mirror
        // holding text since then no longer sits at the far caret, so it is cleared.
        if (state.composition || state.pendingEcho) break;
        for (const distance of event.moves)
          for (let count = 0; count < Math.abs(distance); count++)
            emit({ kind: "command", command: distance < 0 ? "moveBackward" : "moveForward" });
        if (state.proxy.value) reset();
        else state.caret = 0;
        break;
      }
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
      if (event.type === "cut" && state.abilities.basicInput) break;
      emit({ kind: event.type });
      break;
    }
    case "paste": {
      prevent();
      // Clipboard items are representations of one copy; a text target keeps its plain text.
      const text = event.items.find(
        (item) => item.type === "text/plain" && item.name === undefined,
      );
      // Whether it may be pasted is decided before anything is deleted: whole, or refused whole.
      const items =
        state.abilities.clipboard === "none"
          ? []
          : state.abilities.clipboard === "full"
            ? event.items
            : text
              ? [text]
              : [];
      // A paste over a selection replaces it, as typing over it does. The far field has no
      // selection: the selection is deleted first, and the paste goes in where it was.
      const { value, selectionStart: start, selectionEnd: end } = state.proxy;
      let selected = start === end;
      if (items.length && !state.composition && start < end) {
        const removed = {
          value: value.slice(0, start) + value.slice(end),
          selectionStart: start,
          selectionEnd: start,
        };
        // CY12: without a field context there is nothing to delete it in.
        const edit = state.context
          ? textEdit(state.proxy, removed, state.caret, state.context.contextId, null)
          : null;
        const deletion =
          edit &&
          edit !== "unverified" &&
          (state.abilities.rangeEdits || (!edit.before && !edit.after))
            ? edit
            : null;
        // CY12: the far caret goes where the selection was, by commands, or nothing goes.
        const far = deletion ? state.caret - deletion.before.length + deletion.text.length : 0;
        const placed = deletion !== null && (far === start || state.abilities.commands);
        if (deletion && placed && emit({ kind: "edit", edit: deletion })) {
          move(far, start, removed.value);
          selected = true;
        } else {
          // CW9 (CT8): the selection could not go first, so the paste does not go either.
          refusal ??= deletion && !placed ? "commands" : "range-edits";
          break;
        }
      }
      // The pasted text is known: on a target that verifies range edits the mirror keeps it where
      // it went, and no place still waiting in the native field is lost to a reset. What the page
      // makes of it is verified with the next edit, like typed text.
      const plain = text ? new TextDecoder().decode(text.bytes) : null;
      if (
        items.length &&
        plain !== null &&
        selected &&
        !state.composition &&
        !state.resetPending &&
        state.context &&
        state.abilities.rangeEdits &&
        value.length - (end - start) + plain.length < editingTextMaxLength
      ) {
        if (start === end && state.caret !== start) {
          // CY12: the paste goes where the person's caret is, or not at all.
          if (!state.abilities.commands) {
            refusal ??= "commands";
            break;
          }
          move(state.caret, start, value);
        }
        emit({ kind: "paste", items });
        const at = start + plain.length;
        state.proxy = {
          value: value.slice(0, start) + plain + value.slice(end),
          selectionStart: at,
          selectionEnd: at,
        };
        state.caret = at;
        state.pendingEcho = null;
        state.replacement = null;
        state.nativeKey = null;
        instruction = { ...instruction, set: state.proxy, edit: { start, end, text: plain } };
        break;
      }
      interrupt();
      if (items.length) emit({ kind: "paste", items });
      else if (event.items.length) refusal = "clipboard";
      break;
    }
  }
  return {
    state,
    operations,
    instruction,
    ...(refusal && (!state.abilities.basicInput || refusal === "too-large") ? { refusal } : {}),
  };
}
