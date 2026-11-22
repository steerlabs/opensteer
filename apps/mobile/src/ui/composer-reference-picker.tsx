import {
  composerReferenceCandidates,
  type ComposerLinkCandidate,
  type HostSnapshot,
} from "@opensteer/client/host";
import {
  collectComposerTokens,
  referenceIcon,
  type ComposerEditorHandle,
} from "@opensteer/client/references";
import { classifyHref } from "@opensteer/core";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "./primitives.js";
import { referenceSymbols } from "./reference-symbols.js";
import { Symbol, type SFSymbolName } from "./symbol.js";

export interface ReferenceRow {
  readonly key: string;
  readonly label: string;
  readonly markdown: string;
  readonly icon: SFSymbolName;
}

export interface ReferenceSection {
  readonly title: string;
  readonly rows: readonly ReferenceRow[];
}

/** The picker stays a few rows above the keyboard; typing narrows it. */
const shownRows = 5;

/** The word typed after an `@` at the caret, and where its `@` starts; null with none open. */
export function activeReferenceQuery(
  text: string,
  caret: number,
): { readonly query: string; readonly start: number } | null {
  const match = /(^|\s)@([^\s@[\]()]*)$/u.exec(text.slice(0, caret));
  if (match === null) return null;
  return { query: match[2]!, start: caret - match[2]!.length - 1 };
}

/** Replaces the open `@query` with the reference and a space, as one edit. */
export function insertReference(
  editor: ComposerEditorHandle | null,
  open: { readonly start: number },
  caret: number,
  markdown: string,
): void {
  editor?.replace({ start: open.start, end: caret }, `${markdown} `);
}

/** Starts a reference at the caret, for a keyboard without an easy `@`. */
export function startReference(editor: ComposerEditorHandle | null): void {
  if (editor === null) return;
  const { selection, text } = editor.readSnapshot();
  const before = text.slice(0, selection.start);
  editor.replace(selection, before === "" || /\s$/u.test(before) ? "@" : " @");
  editor.focus();
}

/** Recent tasks, automations and computers, from what the Host already sent. */
export function personalReferenceSections(
  snapshot: HostSnapshot,
  query: string,
  /** The task being written in: a reference to itself says nothing. */
  threadId: string | null,
): readonly ReferenceSection[] {
  const groups: Record<"task" | "automation" | "computer", ReferenceRow[]> = {
    task: [],
    automation: [],
    computer: [],
  };
  for (const candidate of composerReferenceCandidates(snapshot, query)) {
    const target = classifyHref(candidateHref(candidate));
    if (target.kind !== "reference" || target.reference.id === threadId) continue;
    const kind = target.reference.kind;
    if (kind !== "task" && kind !== "automation" && kind !== "computer") continue;
    groups[kind].push({
      icon: referenceSymbols[referenceIcon(kind)],
      key: candidate.key,
      label: candidate.label,
      markdown: candidate.markdown,
    });
  }
  return [
    { title: "Recent tasks", rows: groups.task },
    { title: "Automations", rows: groups.automation },
    { title: "Computers", rows: groups.computer },
  ];
}

function candidateHref(candidate: ComposerLinkCandidate): string {
  const [link] = collectComposerTokens(candidate.markdown, { commitTrailing: true });
  return link?.href ?? "";
}

/**
 * What an `@` offers to put in the words, right above the composer and so above
 * the keyboard: a few rows in named groups, narrowed by what is typed after it.
 */
export function ComposerReferencePicker(props: {
  readonly sections: readonly ReferenceSection[];
  readonly onPick: (row: ReferenceRow) => void;
}): ReactNode {
  let room = shownRows;
  const shown = props.sections.flatMap((section) => {
    const rows = section.rows.slice(0, Math.max(0, Math.min(room, Math.ceil(shownRows / 2))));
    room -= rows.length;
    return rows.length === 0 ? [] : [{ ...section, rows }];
  });
  if (shown.length === 0) return null;
  return (
    <View accessibilityLabel="References" accessibilityRole="menu" style={styles.list}>
      {shown.map((section, index) => (
        <View key={section.title} style={index > 0 && styles.separated}>
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            role="caption"
            style={styles.heading}
            tone="muted"
          >
            {section.title}
          </AppText>
          {section.rows.map((row) => (
            <Pressable
              accessibilityHint="Puts a link to it in your message"
              accessibilityLabel={row.label}
              accessibilityRole="menuitem"
              key={row.key}
              onPress={() => props.onPick(row)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <View style={styles.mark}>
                <Symbol name={row.icon} size={15} tint={color.textSoft} />
              </View>
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="secondaryMedium"
                style={styles.label}
              >
                {row.label}
              </AppText>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { paddingHorizontal: space[14], paddingTop: space[8] },
  label: { flex: 1, minWidth: 0 },
  list: { ...material.float, borderRadius: radius.lg, overflow: "hidden", paddingBottom: space[4] },
  mark: { alignItems: "center", width: 22 },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[10],
    minHeight: touchTarget,
    paddingHorizontal: space[14],
  },
  separated: { borderTopColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
});
