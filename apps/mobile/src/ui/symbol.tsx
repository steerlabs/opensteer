import { SymbolView } from "expo-symbols";
import type { ReactNode } from "react";
import { StyleSheet, Text } from "react-native";
import { color } from "../theme.js";

/**
 * One glyph, in the platform's own hand where the platform has one.
 *
 * iOS draws the SF Symbol, which is the system's own icon set: weighted and
 * optically sized with the text beside it, and what makes a control read as
 * the operating system's rather than as a picture drawn inside the app.
 * `SymbolView` resolves a bare string name on iOS only — every other platform
 * has no symbol of its own to map it to and renders `fallback` instead — so
 * the glyph below is the Android answer, and also the answer on an iOS version
 * that never shipped the symbol being asked for.
 *
 * The allowed names are a closed union rather than every SF Symbol, because a
 * name that is only a string is a name nobody has drawn a fallback for:
 * adding one here adds both halves at once.
 */

export type SFSymbolName =
  | "arrow.triangle.branch"
  | "arrow.turn.down.right"
  | "arrow.up"
  | "bolt"
  | "bubble.left"
  | "bubble.left.and.bubble.right"
  | "checklist"
  | "checkmark"
  | "checkmark.circle"
  | "checkmark.circle.fill"
  | "chevron.down"
  | "chevron.left"
  | "chevron.right"
  | "chevron.up"
  | "circle.dotted"
  | "clock"
  | "cloud"
  | "cpu"
  | "cursorarrow"
  | "desktopcomputer"
  | "doc.text"
  | "ellipsis"
  | "exclamationmark.circle"
  | "exclamationmark.triangle.fill"
  | "folder"
  | "gearshape"
  | "globe"
  | "hand.raised"
  | "house"
  | "keyboard"
  | "laptopcomputer"
  | "lightbulb"
  | "line.3.horizontal"
  | "line.3.horizontal.decrease"
  | "list.bullet"
  | "lock"
  | "lock.open"
  | "mic"
  | "macmini"
  | "magnifyingglass"
  | "pencil"
  | "person.2"
  | "person.crop.circle"
  | "plus"
  | "puzzlepiece.extension"
  | "rectangle.on.rectangle"
  | "safari"
  | "server.rack"
  | "shield"
  | "sidebar.left"
  | "smartphone"
  | "sparkles"
  | "square.and.pencil"
  | "stop.circle"
  | "stop.fill"
  | "terminal"
  | "text.append"
  | "trash"
  | "xmark";

export type SymbolWeightName = "regular" | "medium" | "semibold" | "bold";

export function Symbol(props: {
  /**
   * What a screen reader says. Without one the glyph is decoration — the
   * control or label beside it already carries the meaning — and it is hidden
   * rather than read out as its symbol name.
   */
  readonly accessibilityLabel?: string;
  readonly name: SFSymbolName;
  readonly size?: number;
  readonly tint?: string;
  readonly weight?: SymbolWeightName;
}): ReactNode {
  const size = props.size ?? 17;
  const tint = props.tint ?? color.text;
  const weight = props.weight ?? "regular";
  const label = props.accessibilityLabel;

  return (
    <SymbolView
      {...accessibility(label)}
      // The fallback replaces the whole view where there are no SF Symbols and
      // takes none of these props with it, so it carries its own size, colour
      // and accessibility rather than inheriting them.
      fallback={<Glyph label={label} name={props.name} size={size} tint={tint} weight={weight} />}
      name={props.name}
      size={size}
      tintColor={tint}
      weight={weight}
    />
  );
}

/**
 * The same meaning as one character of the system font.
 *
 * A glyph is a graphic sized to the slot it sits in, not text anyone reads, so
 * it does not grow with Dynamic Type: the fixed-height control around it would
 * clip it, and the label beside it grows instead.
 */
function Glyph(props: {
  readonly label: string | undefined;
  readonly name: SFSymbolName;
  readonly size: number;
  readonly tint: string;
  readonly weight: SymbolWeightName;
}): ReactNode {
  return (
    <Text
      {...accessibility(props.label)}
      allowFontScaling={false}
      style={[
        styles.glyph,
        {
          color: props.tint,
          fontSize: props.size,
          fontWeight: glyphWeight[props.weight],
          lineHeight: props.size,
          width: props.size,
        },
      ]}
    >
      {glyph[props.name]}
    </Text>
  );
}

function accessibility(label: string | undefined): {
  readonly accessibilityElementsHidden?: boolean;
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: "image";
  readonly importantForAccessibility?: "no-hide-descendants";
} {
  if (label === undefined) {
    return { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" };
  }
  return { accessibilityLabel: label, accessibilityRole: "image" };
}

/**
 * One character per name, taken from the ranges Android's own font fallback
 * covers, so a phone without SF Symbols draws the mark rather than a box.
 */
const glyph: Record<SFSymbolName, string> = {
  "arrow.triangle.branch": "⑂",
  "arrow.turn.down.right": "↳",
  "arrow.up": "↑",
  bolt: "ϟ",
  "bubble.left": "✉\uFE0E",
  "bubble.left.and.bubble.right": "◌",
  checklist: "☑︎",
  checkmark: "✓",
  "checkmark.circle": "✓",
  "checkmark.circle.fill": "✔",
  "chevron.down": "▾",
  "chevron.left": "◂",
  "chevron.right": "▸",
  "chevron.up": "▴",
  "circle.dotted": "◌",
  clock: "◷",
  cloud: "☁",
  cpu: "▣",
  cursorarrow: "↖",
  desktopcomputer: "▭",
  "doc.text": "▤",
  ellipsis: "…",
  "exclamationmark.circle": "!",
  "exclamationmark.triangle.fill": "⚠",
  folder: "▭",
  gearshape: "⚙",
  globe: "◍",
  "hand.raised": "✋\uFE0E",
  house: "⌂",
  keyboard: "⌨",
  laptopcomputer: "⌨",
  lightbulb: "✱",
  "line.3.horizontal": "☰",
  "line.3.horizontal.decrease": "≡",
  "list.bullet": "≔",
  lock: "⚿",
  "lock.open": "🔓\uFE0E",
  mic: "♩",
  macmini: "▬",
  magnifyingglass: "⌕",
  pencil: "✎",
  "person.2": "☺︎",
  "person.crop.circle": "☻",
  plus: "+",
  "puzzlepiece.extension": "⧉",
  "rectangle.on.rectangle": "❐",
  safari: "◉",
  "server.rack": "☰",
  shield: "⛉",
  "sidebar.left": "◧",
  smartphone: "▯",
  sparkles: "✦",
  "square.and.pencil": "✎",
  "stop.circle": "◼",
  "stop.fill": "■",
  terminal: "›",
  "text.append": "≡",
  trash: "⌫",
  xmark: "✕",
};

const glyphWeight: Record<SymbolWeightName, "400" | "500" | "600" | "700"> = {
  bold: "700",
  medium: "500",
  regular: "400",
  semibold: "600",
};

const styles = StyleSheet.create({
  glyph: { textAlign: "center" },
});
