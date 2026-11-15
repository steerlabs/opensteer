import { classifyHref } from "@opensteer/core";
import {
  markdownSourceTree,
  visitMarkdownSource,
  type Nodes,
} from "@opensteer/shared/markdownParser";

export interface ComposerSelection {
  readonly start: number;
  readonly end: number;
}
export interface ComposerToken {
  readonly start: number;
  readonly end: number;
  readonly source: string;
  readonly label: string;
  readonly href: string;
  readonly kind: "personal" | "team" | "file";
}
export interface ComposerSnapshot {
  readonly text: string;
  readonly selection: ComposerSelection;
  readonly generation: number;
  readonly composing: boolean;
}
export interface ComposerEditorHandle {
  focus(): void;
  blur(): void;
  containsFocus(): boolean;
  readSnapshot(): ComposerSnapshot;
  replace(
    selection: ComposerSelection,
    text: string,
    options?: { readonly historyGroup: "edit" | "dictation" },
  ): void;
  setSelection(selection: ComposerSelection): void;
  /** Transient dictation updates and cancellation must not enter undo history. */
  preview(snapshot: ComposerSnapshot): void;
  restore(snapshot: ComposerSnapshot): void;
  /** Reject a superseded generation; return the final native source and composition state. */
  flushPendingInput(generation: number): Promise<ComposerSnapshot>;
}

export function collectComposerTokens(
  text: string,
  options?: {
    readonly commitTrailing?: boolean;
    readonly previous?: readonly ComposerToken[];
    readonly scope?: "personal" | "team";
  },
): readonly ComposerToken[] {
  const tokens: ComposerToken[] = [];
  const label = (node: Nodes): string =>
    "value" in node
      ? node.value
      : "alt" in node
        ? (node.alt ?? "")
        : "children" in node
          ? node.children.map(label).join("")
          : "";
  visitMarkdownSource(markdownSourceTree(text), (node) => {
    if (node.type === "link") {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start === undefined || end === undefined || text[start] !== "[") return false;
      const source = text.slice(start, end);
      const classified = classifyHref(node.url);
      const kind =
        classified.kind === "reference"
          ? "personal"
          : classified.kind === "team-page"
            ? "team"
            : classified.kind === "file"
              ? "file"
              : null;
      if (kind === null || (options?.scope === "team" && kind !== "team")) return false;
      if (
        end === text.length &&
        !options?.commitTrailing &&
        !options?.previous?.some(
          (token) => token.start === start && token.end === end && token.source === source,
        )
      )
        return false;
      tokens.push({ start, end, source, label: label(node), href: node.url, kind });
      return false;
    }
    if (["image", "imageReference", "definition", "linkReference"].includes(node.type))
      return false;
    return true;
  });
  return tokens;
}

export function snapComposerSelection(
  text: string,
  selection: ComposerSelection,
  tokens: readonly ComposerToken[],
): ComposerSelection {
  let start = Math.max(0, Math.min(text.length, Math.min(selection.start, selection.end)));
  let end = Math.max(0, Math.min(text.length, Math.max(selection.start, selection.end)));
  const collapsed = start === end;
  for (const token of tokens) {
    if (collapsed && start > token.start && start < token.end) {
      start = end = start - token.start < token.end - start ? token.start : token.end;
      break;
    }
    if (!collapsed && start < token.end && end > token.start) {
      start = Math.min(start, token.start);
      end = Math.max(end, token.end);
    }
  }
  return { start, end };
}

export function replaceComposerRange(
  text: string,
  selection: ComposerSelection,
  insert: string,
  tokens: readonly ComposerToken[],
): { text: string; selection: ComposerSelection } {
  const range = snapComposerSelection(text, selection, tokens);
  const offset = range.start + insert.length;
  return {
    text: text.slice(0, range.start) + insert + text.slice(range.end),
    selection: { start: offset, end: offset },
  };
}
