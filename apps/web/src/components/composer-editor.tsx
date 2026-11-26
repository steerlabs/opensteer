import { Extension, type Editor } from "@tiptap/core";
import { closeHistory, history, redo, undo } from "@tiptap/pm/history";
import { Fragment, Slice } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react";
import {
  hrefIcon,
  snapComposerSelection,
  type ComposerEditorHandle,
  type ComposerSelection,
  type ComposerSnapshot,
} from "@opensteer/client/references";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import {
  ComposerReference,
  atomTokens,
  composerContent,
  composerInline,
  composerNodes,
  composerSource,
  composerTokens,
  docPosAt,
  referenceNodeName,
  referenceOf,
  sourceOffsetAt,
  sourceReplacement,
  typedTokenConversions,
} from "./composer-editor-document.js";
import { Icon } from "./icon.js";
import { referenceGlyphs } from "./references/reference-glyphs.js";
import "../styles/composer-editor.css";

/** Who changed the words: the person at the keyboard, or code acting for them. */
export type ComposerChange = "user" | "api";

/** The shared handle, plus what a web picker needs to place itself. */
export interface ComposerEditorControl extends ComposerEditorHandle {
  /** The plain words from the last atom or line break up to a collapsed caret. */
  caretRun(): { readonly start: number; readonly caret: number; readonly text: string } | null;
  /** Where a source offset is drawn on screen. */
  coordsAt(offset: number): { readonly left: number; readonly top: number } | null;
}

interface ComposerEditorProps {
  readonly ref?: Ref<ComposerEditorControl>;
  /** The Markdown source. A value other than the last one reported replaces the words. */
  readonly value: string;
  readonly onChange: (text: string, change: ComposerChange) => void;
  readonly autoFocus?: boolean;
  /** On the editable element, which is the whole box: it pads, sizes and scrolls itself. */
  readonly className?: string;
  readonly fieldAttributes: Readonly<Record<string, string | undefined>>;
  readonly fieldRef?: (element: HTMLElement | null) => void;
  readonly placeholder?: string;
  readonly readOnly?: boolean;
  readonly onBlur?: () => void;
  readonly onCompositionStart?: () => void;
  /** Return true when the key was handled and must go no further. */
  readonly onKeyDown?: (event: KeyboardEvent) => boolean;
  /** Return true when the paste was taken, as files are; otherwise its plain text is inserted. */
  readonly onPaste?: (event: ClipboardEvent) => boolean;
  readonly onSelectionChange?: () => void;
}

const syncMeta = "composerSync";
const apiMeta = "composerApi";

/**
 * The words being written as an editor whose only rich piece is an atomic
 * reference chip; everything else is the Markdown source as typed. Reads and
 * writes are source strings and UTF-16 offsets (see `ComposerEditorHandle`).
 */
export function ComposerEditor({
  ref,
  value,
  onChange,
  autoFocus = false,
  className,
  fieldAttributes,
  fieldRef,
  placeholder = "",
  readOnly = false,
  onBlur,
  onCompositionStart,
  onKeyDown,
  onPaste,
  onSelectionChange,
}: ComposerEditorProps) {
  const latest = useRef({
    onBlur,
    onChange,
    onCompositionStart,
    onKeyDown,
    onPaste,
    onSelectionChange,
  });
  latest.current = { onBlur, onChange, onCompositionStart, onKeyDown, onPaste, onSelectionChange };
  const fieldClass = useRef(className);
  fieldClass.current = className;
  /** The source the editor last reported or was given. */
  const known = useRef(value);
  const generation = useRef(0);
  /** The key being handled belongs to an input method, which keeps Enter and Backspace. */
  const imeKey = useRef(false);
  const [content] = useState(() => composerContent(value));
  // Typed `Editor`, but TipTap destroys an editor whose component has not mounted 1 ms after
  // creating it and creates another once it has: a render that yields before it commits (the
  // desktop's first signed-in render is a time-sliced Suspense retry) commits an editor with no
  // view, or none at all. Its view is reached only through `liveView`, at the moment of use.
  const editor: Editor | null = useEditor(
    {
      content,
      editable: !readOnly,
      enableInputRules: false,
      enablePasteRules: false,
      extensions: [
        ...composerNodes.map((node) =>
          node === ComposerReference
            ? ComposerReference.extend({
                addNodeView: () => ReactNodeViewRenderer(ReferenceChip, { as: "span" }),
              })
            : node,
        ),
        composerBehavior(() => imeKey.current),
      ],
      immediatelyRender: true,
      injectCSS: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: (state: EditorState): Record<string, string> => ({
          class: ["composer-editor__field", fieldClass.current].filter(Boolean).join(" "),
          ...(state.doc.firstChild?.childCount === 0 ? { "data-empty": "" } : {}),
        }),
        handleKeyDown: (view, event) => {
          imeKey.current = event.isComposing || event.keyCode === 229 || view.composing;
          return !imeKey.current && (latest.current.onKeyDown?.(event) ?? false);
        },
        handlePaste: (view, event) => {
          if (latest.current.onPaste?.(event)) return true;
          const text = event.clipboardData?.getData("text/plain").replace(/\r\n?/gu, "\n") ?? "";
          if (text) insertSource(view, text);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          // Files belong to the composer around the field; the field never inserts their names.
          if (event.dataTransfer?.types.includes("Files")) return true;
          if (moved) return false;
          const text = event.dataTransfer?.getData("text/plain").replace(/\r\n?/gu, "\n") ?? "";
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          if (text && at !== undefined) {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
            insertSource(view, text);
          }
          return true;
        },
        handleDOMEvents: {
          compositionstart: () => {
            latest.current.onCompositionStart?.();
            return false;
          },
          copy: (view, event) => copySource(view, event, false),
          cut: (view, event) => copySource(view, event, true),
        },
      },
      onUpdate: ({ editor: current, transaction }) => {
        if (transaction.getMeta(syncMeta)) return;
        const text = composerSource(current.state.doc);
        known.current = text;
        latest.current.onChange(text, transaction.getMeta(apiMeta) ? "api" : "user");
        latest.current.onSelectionChange?.();
      },
      onSelectionUpdate: () => latest.current.onSelectionChange?.(),
      onBlur: () => latest.current.onBlur?.(),
    },
    [],
  );

  // Focus is taken once: when the field appears, or when it first becomes editable.
  const focusPending = useRef(autoFocus);
  const takeFocus = (view: EditorView) => {
    focusPending.current = false;
    view.focus();
    const end = docPosAt(view.state.doc, composerSource(view.state.doc).length);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
  };

  // The field is this editor's view, once it has one. An editor TipTap replaced arrives here
  // again with its own view: it shows the draft as it is now, and takes focus still owed.
  useLayoutEffect(() => {
    const view = liveView(editor);
    if (!view) return;
    if (composerSource(view.state.doc) !== value) {
      known.current = value;
      applySource(view, value, { history: false, sync: true });
    }
    fieldRef?.(view.dom);
    if (focusPending.current && !readOnly) takeFocus(view);
    return () => fieldRef?.(null);
  }, [editor]);

  useLayoutEffect(() => {
    const view = liveView(editor);
    if (!view) return;
    const dom = view.dom;
    const attributes = {
      role: "textbox",
      "aria-multiline": "true",
      ...fieldAttributes,
      "aria-placeholder": placeholder || undefined,
    };
    // Only real changes: layout observes some of these attributes.
    for (const [name, next] of Object.entries(attributes))
      if (next === undefined) dom.removeAttribute(name);
      else if (dom.getAttribute(name) !== next) dom.setAttribute(name, next);
    dom.dataset.placeholder = placeholder;
  });

  useEffect(() => {
    const view = liveView(editor);
    if (!editor || !view) return;
    editor.setEditable(!readOnly, false);
    if (!readOnly && focusPending.current) takeFocus(view);
  }, [editor, readOnly]);

  // A value that is not what the editor last reported is a reset from outside:
  // a sent draft clearing, a message handed back. It starts a new generation.
  useLayoutEffect(() => {
    const view = liveView(editor);
    if (!view || value === known.current) return;
    known.current = value;
    if (composerSource(view.state.doc) === value) return;
    generation.current += 1;
    applySource(view, value, { history: false, sync: true });
  }, [editor, value]);

  // Asked of a field whose editor has no view yet (TipTap is replacing it), reads come from the
  // words it holds and writes wait: the handle is rebuilt for the editor that replaces it.
  useImperativeHandle(ref, (): ComposerEditorControl => {
    const view = () => liveView(editor);
    const snapshot = (): ComposerSnapshot => {
      const state = view()?.state ?? editor?.state;
      if (!state) {
        const end = known.current.length;
        return {
          text: known.current,
          selection: { start: end, end },
          generation: generation.current,
          composing: false,
        };
      }
      const { doc, selection } = state;
      return {
        text: composerSource(doc),
        selection: {
          start: sourceOffsetAt(doc, selection.from),
          end: sourceOffsetAt(doc, selection.to),
        },
        generation: generation.current,
        composing: view()?.composing ?? false,
      };
    };
    const show = (next: ComposerSnapshot) => {
      const current = view();
      if (!current) return;
      applySource(current, next.text, { history: false, sync: true });
      selectSource(current, next.selection);
    };
    return {
      focus: () => view()?.focus(),
      blur: () => view()?.dom.blur(),
      containsFocus: () => view()?.hasFocus() ?? false,
      readSnapshot: snapshot,
      replace: (selection, text) => {
        const current = view();
        if (!current) return;
        const source = composerSource(current.state.doc);
        const range = snapped(current, selection);
        applySource(current, source.slice(0, range.start) + text + source.slice(range.end), {
          history: true,
          sync: false,
        });
        const caret = range.start + text.length;
        selectSource(current, { start: caret, end: caret });
      },
      setSelection: (selection) => {
        const current = view();
        if (current) selectSource(current, selection);
      },
      preview: show,
      restore: show,
      flushPendingInput: (expected) => {
        const current = view();
        const observer: unknown = current ? Reflect.get(current, "domObserver") : null;
        if (
          typeof observer === "object" &&
          observer !== null &&
          "flush" in observer &&
          typeof observer.flush === "function"
        )
          observer.flush();
        const read = snapshot();
        return read.generation === expected
          ? Promise.resolve(read)
          : Promise.reject(new Error("The draft was replaced while it was being read."));
      },
      caretRun: () => {
        const state = view()?.state ?? editor?.state;
        if (!state) return null;
        const { doc, selection } = state;
        if (!selection.empty) return null;
        const caret = sourceOffsetAt(doc, selection.from);
        const text = composerSource(doc);
        let start = 0;
        for (const atom of atomTokens(doc)) if (atom.end <= caret) start = atom.end;
        start = Math.max(start, text.lastIndexOf("\n", caret - 1) + 1);
        return { start, caret, text: text.slice(start, caret) };
      },
      coordsAt: (offset) => {
        const current = view();
        if (!current) return null;
        try {
          const coords = current.coordsAtPos(docPosAt(current.state.doc, offset));
          return { left: coords.left, top: coords.top };
        } catch {
          // A field that is not laid out has nowhere to draw.
          return null;
        }
      },
    };
  }, [editor]);

  // The editable element is the box a press lands in, as a textarea was; the
  // wrapper Tiptap mounts it in takes no part in layout.
  return <EditorContent className="composer-editor" editor={editor} />;
}

/**
 * The editor's view while it has one: TipTap's own `isDestroyed` is true for an editor with no
 * view, whether never mounted or destroyed. Nothing here reads `editor.view` any other way.
 */
function liveView(editor: Editor | null): EditorView | null {
  return editor && !editor.isDestroyed ? editor.view : null;
}

/** Keys, history and the two small plugins the atoms need. */
function composerBehavior(imeKey: () => boolean) {
  return Extension.create({
    name: "composerBehavior",
    priority: 1000,
    addProseMirrorPlugins: () => [history(), typedLinks(), atomSelection()],
    addKeyboardShortcuts() {
      const view = () => this.editor.view;
      const lineBreak = () => {
        if (imeKey()) return false;
        const { state } = view();
        view().dispatch(
          state.tr.replaceSelectionWith(state.schema.nodes.hardBreak!.create()).scrollIntoView(),
        );
        return true;
      };
      const removeAtom = (direction: -1 | 1) => {
        if (imeKey()) return false;
        const { state } = view();
        const { selection } = state;
        if (!selection.empty) return false;
        const node = direction < 0 ? selection.$from.nodeBefore : selection.$from.nodeAfter;
        if (node?.type.name !== referenceNodeName) return false;
        const from = direction < 0 ? selection.from - node.nodeSize : selection.from;
        isolated(view(), state.tr.delete(from, from + node.nodeSize));
        return true;
      };
      const step = (direction: -1 | 1) => {
        const { state } = view();
        const { selection } = state;
        if (selection instanceof NodeSelection) return false;
        if (!selection.empty) return false;
        const node = direction < 0 ? selection.$from.nodeBefore : selection.$from.nodeAfter;
        if (node?.type.name !== referenceNodeName) return false;
        const to = selection.from + direction * node.nodeSize;
        view().dispatch(
          state.tr.setSelection(TextSelection.create(state.doc, to)).scrollIntoView(),
        );
        return true;
      };
      return {
        Enter: lineBreak,
        "Shift-Enter": lineBreak,
        Backspace: () => removeAtom(-1),
        Delete: () => removeAtom(1),
        ArrowLeft: () => step(-1),
        ArrowRight: () => step(1),
        "Mod-z": () => undo(view().state, view().dispatch),
        "Shift-Mod-z": () => redo(view().state, view().dispatch),
        "Mod-y": () => redo(view().state, view().dispatch),
      };
    },
  });
}

/** A link typed out in full becomes an atom once the caret has left it. */
function typedLinks() {
  let view: EditorView | null = null;
  return new Plugin({
    view: (editorView) => {
      view = editorView;
      return { destroy: () => void (view = null) };
    },
    appendTransaction: (transactions, _old, state) => {
      if (view?.composing) return null;
      if (!transactions.some((tr) => tr.docChanged || tr.selectionSet)) return null;
      if (transactions.some((tr) => tr.getMeta(syncMeta))) return null;
      const caret = state.selection.empty ? sourceOffsetAt(state.doc, state.selection.from) : null;
      const conversions = typedTokenConversions(state.doc, caret);
      if (conversions.length === 0) return null;
      const tr = state.tr;
      for (const { from, to, node } of conversions) tr.replaceWith(from, to, node);
      return tr;
    },
  });
}

/** Atoms inside a ranged selection show it, as text there does. */
function atomSelection() {
  return new Plugin({
    props: {
      decorations: (state) => {
        const { selection } = state;
        if (selection.empty || selection instanceof NodeSelection) return null;
        const marks: Decoration[] = [];
        state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
          if (node.type.name === referenceNodeName)
            marks.push(Decoration.node(pos, pos + node.nodeSize, { class: "is-in-selection" }));
        });
        return DecorationSet.create(state.doc, marks);
      },
    },
  });
}

/** One undo step of its own: neither joined to the typing before it nor to what follows. */
function isolated(view: EditorView, tr: Transaction) {
  view.dispatch(closeHistory(tr).scrollIntoView());
  view.dispatch(closeHistory(view.state.tr));
}

function insertSource(view: EditorView, text: string) {
  const nodes = composerInline(view.state.schema, text, composerTokens(text));
  isolated(view, view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)));
}

/** Copy and cut carry the exact Markdown source, so a pasted reference comes back whole. */
function copySource(view: EditorView, event: ClipboardEvent, cut: boolean): boolean {
  const { from, to, empty } = view.state.selection;
  if (empty || !event.clipboardData) return false;
  event.preventDefault();
  event.clipboardData.clearData();
  event.clipboardData.setData("text/plain", composerSource(view.state.doc.slice(from, to).content));
  if (cut && view.editable) isolated(view, view.state.tr.deleteSelection());
  return true;
}

function snapped(view: EditorView, selection: ComposerSelection): ComposerSelection {
  const { doc } = view.state;
  return snapComposerSelection(composerSource(doc), selection, atomTokens(doc));
}

function selectSource(view: EditorView, selection: ComposerSelection) {
  const { doc } = view.state;
  const range = snapped(view, selection);
  const next = TextSelection.create(doc, docPosAt(doc, range.start), docPosAt(doc, range.end));
  if (!view.state.selection.eq(next)) view.dispatch(view.state.tr.setSelection(next));
}

function applySource(
  view: EditorView,
  target: string,
  { history: recorded, sync }: { readonly history: boolean; readonly sync: boolean },
) {
  const replacement = sourceReplacement(view.state.doc, target);
  if (!replacement) return;
  const tr = view.state.tr.replaceWith(replacement.from, replacement.to, replacement.nodes);
  if (sync) tr.setMeta(syncMeta, true);
  else tr.setMeta(apiMeta, true);
  if (!recorded) {
    view.dispatch(tr.setMeta("addToHistory", false));
    return;
  }
  isolated(view, tr);
}

/** A reference as it sits in the words: the transcript's chip at the field's size. */
function ReferenceChip({ node, selected }: NodeViewProps) {
  const token = referenceOf(node);
  return (
    <NodeViewWrapper
      as="span"
      className={selected ? "ref-chip composer-token is-selected" : "ref-chip composer-token"}
      title={token.label}
    >
      <Icon name={referenceGlyphs[hrefIcon(token.href)]} />
      <span className="ref-chip__title">{token.label || token.href}</span>
    </NodeViewWrapper>
  );
}
