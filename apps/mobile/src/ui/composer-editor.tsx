import { classifyHref } from "@opensteer/core";
import {
  collectComposerTokens,
  hrefIcon,
  replaceComposerRange,
  snapComposerSelection,
  type ComposerEditorHandle,
  type ComposerSelection,
  type ComposerSnapshot,
  type ComposerToken,
} from "@opensteer/client/references";
import {
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Keyboard, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { discardPastedImage } from "../../modules/composer-editor/files.js";
import {
  NativeComposerEditor,
  type NativeComposerEditorRef,
  type NativeComposerState,
  type PastedImages,
} from "../../modules/composer-editor/index.js";
import { color, controlFontScaleLimit, plateFill, type } from "../theme.js";
import { ComposerRevision } from "./composer-editor-revision.js";
import { referenceSymbols } from "./reference-symbols.js";
import type { SFSymbolName } from "./symbol.js";
import { symbolArt } from "./symbol-art.js";

export interface ComposerEditorProps {
  readonly ref?: Ref<ComposerEditorHandle>;
  /** The draft's Markdown source. References in it show as chips; it is what is saved and sent. */
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSelectionChange?: (selection: ComposerSelection) => void;
  /** Which links become chips: a team composer shows only its team's pages as references. */
  readonly scope: "personal" | "team";
  readonly placeholder: string;
  readonly accessibilityLabel: string;
  readonly editable?: boolean;
  readonly autoFocus?: boolean;
  /** Where pasted and dropped images go; without it they are discarded, as an edit takes none. */
  readonly onPasteImages?: (pasted: PastedImages) => void;
  /** The most one pasted image may hold. */
  readonly maxImageBytes?: number;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  /** Backspace in an empty field, which deletes nothing. */
  readonly onBackspaceWhenEmpty?: () => void;
  /** Space above and below the lines, inside the field. */
  readonly paddingVertical: number;
  /** The field grows line by line to this height, then scrolls inside itself. */
  readonly maxHeight: number;
  readonly style?: StyleProp<ViewStyle>;
}

const theme = JSON.stringify({
  text: color.text,
  placeholder: color.muted,
  tint: color.ember,
  chipText: color.text,
  chipGlyph: color.textSoft,
  chipFill: plateFill,
  chipRim: color.lineControl,
  chipEdge: "rgba(255, 255, 255, 0.07)",
  chipSelectedRim: color.ember,
});

/**
 * The composer's text field: the draft is plain Markdown, and the references in it
 * show as atomic chips that move, select and delete as one character.
 *
 * The field is controlled, but native typing runs ahead of React. Every native
 * event carries a count, and a render that lags it is stamped behind, so native
 * keeps what the person typed rather than taking stale text back
 * (`ComposerRevision`). A `restore` with a newer generation is a parent reset —
 * a sent message leaving the field — and wins over keystrokes it never saw.
 */
export function ComposerEditor(props: ComposerEditorProps): ReactNode {
  const native = useRef<NativeComposerEditorRef>(null);
  const revision = useRef(new ComposerRevision()).current;
  const [, render] = useReducer((tick: number) => tick + 1, 0);
  // A dictation preview shown instead of `value`, which is not the draft and not an undo step.
  const preview = useRef<string | null>(null);
  // A caret the parent placed (an inserted reference, a dictation preview), sent until native moves.
  const requestedSelection = useRef<ComposerSelection | null>({
    start: props.value.length,
    end: props.value.length,
  });
  const latest = useRef<{ text: string; selection: ComposerSelection; composing: boolean }>({
    text: props.value,
    selection: { start: props.value.length, end: props.value.length },
    composing: false,
  });
  const focused = useRef(false);
  const [contentHeight, setContentHeight] = useState(0);
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, controlFontScaleLimit);
  const lineHeight = type.body.lineHeight * scale;

  const text = preview.current ?? props.value;

  // Tokens advance from the previous text, so removing the space after a chip keeps it a chip.
  const [confirmed, setConfirmed] = useState(() => ({
    text,
    tokens: collectComposerTokens(text, { commitTrailing: true, scope: props.scope }),
  }));
  let tokens = confirmed.tokens;
  if (confirmed.text !== text) {
    tokens = collectComposerTokens(text, { previous: confirmed.tokens, scope: props.scope });
    setConfirmed({ text, tokens });
  }

  const selection = requestedSelection.current;
  const stamp = revision.stamp(text, selection);
  const documentJson = JSON.stringify({
    value: text,
    selection: stamp.isNativeEcho ? null : selection,
    tokens: tokens.map(nativeToken),
    eventCount: stamp.eventCount,
    isNativeEcho: stamp.isNativeEcho,
    generation: stamp.generation,
  });
  useEffect(() => {
    // A payload native will apply is what it now holds; a lagging one it will refuse.
    if (
      !stamp.isNativeEcho &&
      stamp.eventCount === revision.eventCount &&
      text !== latest.current.text
    )
      latest.current = {
        text,
        selection: selection ?? { start: text.length, end: text.length },
        composing: false,
      };
    revision.settle(stamp, text, selection);
    // Settled once per payload native received.
  }, [documentJson]);

  const deliver = (state: NativeComposerState): boolean => {
    if (!revision.accept(state)) return false;
    requestedSelection.current = null;
    latest.current = { text: state.value, selection: state.selection, composing: state.composing };
    if (state.value !== (preview.current ?? props.value)) {
      // The person edited what was shown, a preview included: that is now the draft.
      preview.current = null;
      props.onChangeText(state.value);
    }
    props.onSelectionChange?.(state.selection);
    render();
    return true;
  };

  const snapshot = (): ComposerSnapshot => ({
    ...latest.current,
    generation: revision.generation,
  });

  // Offsets for the text native holds now, which can run ahead of the last render.
  const tokensNow = (): readonly ComposerToken[] =>
    collectComposerTokens(latest.current.text, { previous: tokens, scope: props.scope });

  const show = (shown: string | null, at: ComposerSelection): void => {
    preview.current = shown;
    requestedSelection.current = at;
    latest.current = { text: shown ?? props.value, selection: at, composing: false };
    render();
  };

  useImperativeHandle(props.ref, (): ComposerEditorHandle => ({
    focus: () => void native.current?.focus().catch(() => undefined),
    blur: () => void native.current?.blur().catch(() => undefined),
    containsFocus: () => focused.current,
    readSnapshot: snapshot,
    replace: (range, insert) => {
      const current = latest.current.text;
      const next = replaceComposerRange(current, range, insert, tokensNow());
      requestedSelection.current = next.selection;
      latest.current = { text: next.text, selection: next.selection, composing: false };
      props.onChangeText(next.text);
      props.onSelectionChange?.(next.selection);
      render();
    },
    setSelection: (range) => {
      const snapped = snapComposerSelection(latest.current.text, range, tokensNow());
      void native.current?.setSelection(snapped.start, snapped.end).catch(() => undefined);
    },
    preview: (next) => show(next.text, next.selection),
    // `value` is the draft, and the parent has already set it; a newer generation makes
    // this a reset, which native applies over keystrokes it sent before.
    restore: (next) => {
      if (next.generation > revision.generation) revision.adopt(next.generation);
      show(null, next.selection);
    },
    flushPendingInput: async (generation) => {
      if (generation !== revision.generation) throw new Error("The composer was reset.");
      const state = await native.current?.readState().catch(() => undefined);
      if (generation !== revision.generation) throw new Error("The composer was reset.");
      // Native has not applied the latest reset yet: what JS holds is the answer.
      if (state === undefined || state.generation < generation) return snapshot();
      if (state.eventCount < revision.eventCount) return snapshot();
      deliver(state);
      return { ...latest.current, generation };
    },
  }));

  const minHeight = lineHeight + props.paddingVertical * 2;
  return (
    <NativeComposerEditor
      autoFocus={props.autoFocus ?? false}
      documentJson={documentJson}
      editable={props.editable ?? true}
      label={props.accessibilityLabel}
      maxBytes={props.maxImageBytes ?? 0}
      onComposerBlur={() => {
        focused.current = false;
        props.onBlur?.();
      }}
      onComposerChange={(event) => void deliver(event.nativeEvent)}
      onComposerContentSizeChange={(event) => setContentHeight(event.nativeEvent.height)}
      onComposerEmptyBackspace={() => props.onBackspaceWhenEmpty?.()}
      onComposerFocus={() => {
        focused.current = true;
        props.onFocus?.();
      }}
      onComposerPasteImages={(event) => {
        if (props.onPasteImages) props.onPasteImages(event.nativeEvent);
        else for (const image of event.nativeEvent.images) discardPastedImage(image.uri);
      }}
      onComposerSelectionChange={(event) => void deliver(event.nativeEvent)}
      placeholder={props.placeholder}
      ref={native}
      style={[
        { height: Math.min(props.maxHeight, Math.max(minHeight, contentHeight)) },
        props.style,
      ]}
      themeJson={theme}
      typographyJson={JSON.stringify({
        fontSize: type.body.fontSize * scale,
        lineHeight,
        paddingVertical: props.paddingVertical,
      })}
    />
  );
}

/** Lowers the keyboard: React Native's `Keyboard.dismiss` reaches only its own `TextInput`s. */
/** Puts the keyboard away; settles once it is down, or soon after if it never says so. */
export function dismissKeyboard(): Promise<void> {
  Keyboard.dismiss();
  return Promise.race([
    KeyboardController.dismiss(),
    new Promise<void>((resolve) => setTimeout(resolve, keyboardDismissBoundMs)),
  ]);
}

/** Longer than either platform's keyboard animation, so only a keyboard that never reports waits it out. */
const keyboardDismissBoundMs = 700;

const nouns: Readonly<Record<string, string>> = {
  task: "Task",
  run: "Run",
  request: "Request",
  message: "Message",
  automation: "Automation",
  computer: "Computer",
  attachment: "Attachment",
  channel: "Channel",
  thread: "Thread",
  "knowledge-topic": "Topic",
  "knowledge-note": "Note",
  invite: "Invite",
};

/** How a reference reads as a chip, by what it points at. */
function referencePresentation(href: string): {
  readonly symbol: SFSymbolName;
  readonly noun: string;
} {
  const classified = classifyHref(href);
  const kind =
    classified.kind === "reference"
      ? classified.reference.kind
      : classified.kind === "team-page"
        ? classified.page.target.kind
        : null;
  const icon = hrefIcon(href);
  return {
    symbol: referenceSymbols[icon],
    noun: kind === null ? (icon === "image" ? "Image" : "File") : (nouns[kind] ?? "File"),
  };
}

function nativeToken(token: ComposerToken) {
  const presentation = referencePresentation(token.href);
  const label = token.label.trim() || presentation.noun;
  return {
    start: token.start,
    end: token.end,
    source: token.source,
    label,
    symbol: presentation.symbol,
    // Android draws the same strokes the transcript's chip does.
    art: symbolArt[presentation.symbol] ?? "",
    accessibilityLabel: `${presentation.noun}, ${label}`,
  };
}
