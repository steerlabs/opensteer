import { useState, type ReactNode } from "react";

/**
 * `@expo/ui/jetpack-compose` drawn as DOM that keeps each composable's kind, and a layout of it
 * by Compose's own rules, for tests of where things land on an Android phone: a Column stacks
 * its children, a Row lines them up, and a Box, like every slot of a Material `ListItem`, puts
 * each child at its own top left, over the others. `@expo/ui`'s `ListItem.HeadlineContent` hands
 * its children straight to Material's `headlineContent` (`ListItemView.kt`, `SlotView.kt`), so two
 * children there are drawn one over the other unless a Column holds them.
 *
 * Text is measured as Roboto at its type scale: an average advance of 0.55 em, lines of 1.5 em,
 * wrapping where the width runs out. Sizes are dp; text scales with the reader's font scale.
 *
 * Each rule is the source's (`@expo/ui` 58.0.23, `android/src/main/java/expo/modules/ui/`):
 * - Column, Row, Box: Compose's own (`ComposeViews.kt`).
 * - Host: every child at the top left, over the others (`HostView.kt:312-316`, `placeRelative(0, 0)`).
 * - Button and TextButton: their content a Row (`button/Button.kt:86` in ButtonContent, `:174`
 *   in TextButtonContent, each `rowScope`).
 * - FlowRow: a Row that takes another line where the next child does not fit
 *   (`ComposeViews.kt:95`, Compose's `FlowRow`).
 * - A `ListItem` slot: its children handed to Material's slot as they are (`ListItemView.kt`,
 *   `SlotView.kt:33-36`), drawn over one another.
 *
 * What it does not cover: padding and alignment on a sized container (a sized Box puts its
 * children at its top left, whatever `contentAlignment` says), a container's layout direction,
 * and line breaking inside an address (it wraps by characters, and draws no zero-width marks).
 */
type Modifier =
  | { readonly kind: "size"; readonly width: number; readonly height: number }
  | { readonly kind: "padding"; readonly edges: readonly [number, number, number, number] }
  | { readonly kind: "other" };

interface Props {
  readonly children?: ReactNode;
  readonly modifiers?: readonly Modifier[];
  readonly verticalArrangement?: { readonly spacedBy?: number };
  readonly horizontalArrangement?: { readonly spacedBy?: number };
  readonly style?: { readonly typography?: string; readonly fontSize?: number };
}

const attributes = (kind: string, props: Props) => {
  const sized = props.modifiers?.find((modifier) => modifier.kind === "size");
  const padded = props.modifiers?.find((modifier) => modifier.kind === "padding");
  // Two spacings, as FlowRow takes them (`ComposeViews.kt:96-97`): between children on a line
  // (horizontal) and between lines (vertical). A Column's is its vertical; a Row's its horizontal.
  const across = props.horizontalArrangement?.spacedBy;
  const down = props.verticalArrangement?.spacedBy;
  return {
    "data-compose": kind,
    ...(sized ? { "data-size": `${sized.width},${sized.height}` } : {}),
    ...(padded ? { "data-padding": padded.edges.join(",") } : {}),
    ...(across === undefined ? {} : { "data-spaced-across": String(across) }),
    ...(down === undefined ? {} : { "data-spaced-down": String(down) }),
  };
};
const node =
  (kind: string) =>
  (props: Props): ReactNode => <div {...attributes(kind, props)}>{props.children}</div>;
const slot =
  (name: string) =>
  ({ children }: { readonly children?: ReactNode }): ReactNode => (
    <div data-compose="slot" data-slot={name}>
      {children}
    </div>
  );

const typeScale: Record<string, number> = {
  bodyLarge: 16,
  bodyMedium: 14,
  labelMedium: 12,
  titleMedium: 16,
};

const nothing = () => null;
export const composeLayout = {
  Box: node("Box"),
  Button: node("Row"),
  Checkbox: nothing,
  CircularProgressIndicator: nothing,
  Column: node("Column"),
  DropdownMenu: Object.assign(node("Box"), { Items: nothing, Trigger: slot("trigger") }),
  DropdownMenuItem: Object.assign(node("Box"), { Text: slot("text") }),
  FilterChip: Object.assign(node("Box"), { Label: slot("label"), LeadingIcon: slot("icon") }),
  FlowRow: node("FlowRow"),
  Host: node("Box"),
  IconButton: node("Box"),
  LazyColumn: node("Column"),
  ModalBottomSheet: node("Column"),
  OutlinedTextField: Object.assign(node("Box"), { Label: slot("label") }),
  RadioButton: nothing,
  Switch: nothing,
  ListItem: Object.assign(node("ListItem"), {
    HeadlineContent: slot("headline"),
    LeadingContent: slot("leading"),
    OverlineContent: slot("overline"),
    SupportingContent: slot("supporting"),
    TrailingContent: slot("trailing"),
  }),
  RNHostView: node("Column"),
  Row: node("Row"),
  Text: (props: Props) => (
    <span
      data-compose="Text"
      data-font={String(props.style?.fontSize ?? typeScale[props.style?.typography ?? ""] ?? 16)}
    >
      {props.children}
    </span>
  ),
  TextButton: node("Row"),
  useNativeState: <T,>(initial: T) => {
    const [value, set] = useState(initial);
    return { value, set };
  },
};

const other = (): Modifier => ({ kind: "other" });
export const composeLayoutModifiers = {
  alpha: other,
  background: other,
  clickable: other,
  clip: other,
  fillMaxSize: other,
  fillMaxWidth: other,
  imePadding: other,
  padding: (start = 0, top = 0, end = 0, bottom = 0): Modifier => ({
    edges: [start, top, end, bottom],
    kind: "padding",
  }),
  selectable: other,
  selectableGroup: other,
  semantics: other,
  Shapes: { Circle: {} },
  size: (width: number, height: number): Modifier => ({ height, kind: "size", width }),
  toggleable: other,
  weight: other,
};

export interface ComposeFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Each composable's frame in dp, laid out in `width` at `fontScale`. */
export function composeFrames(
  root: Element,
  { fontScale, width }: { readonly fontScale: number; readonly width: number },
): Map<Element, ComposeFrame> {
  const frames = new Map<Element, ComposeFrame>();
  const kids = (element: Element) =>
    [...element.children].filter((child) => child.hasAttribute("data-compose"));
  /** Lays `element` out at (x, y) in at most `room` wide; returns its size. */
  const place = (element: Element, x: number, y: number, room: number): [number, number] => {
    const kind = element.getAttribute("data-compose");
    const size = element.getAttribute("data-size")?.split(",").map(Number);
    const [ps, pt, pe, pb] = (element.getAttribute("data-padding") ?? "0,0,0,0")
      .split(",")
      .map(Number) as [number, number, number, number];
    const across = Number(element.getAttribute("data-spaced-across") ?? 0);
    const down = Number(element.getAttribute("data-spaced-down") ?? 0);
    let w = 0;
    let h = 0;
    if (kind === "Text") {
      const em = Number(element.getAttribute("data-font")) * fontScale;
      const chars = (element.textContent ?? "").replace(/[⁠​]/gu, "").length;
      const line = chars * em * 0.55;
      const lines = Math.max(1, Math.ceil(line / Math.max(1, room)));
      w = Math.min(line, room);
      h = lines * em * 1.5;
    } else if (kind === "ListItem") {
      // Material's ListItem: 16 dp on each side, its leading and trailing slots beside a column
      // of overline, headline and supporting, 16 dp apart.
      const slots = Object.fromEntries(
        kids(element).map((child) => [child.getAttribute("data-slot"), child]),
      );
      let left = x + 16;
      let right = x + room - 16;
      let tallest = 0;
      if (slots.leading) {
        const [lw, lh] = place(slots.leading, left, y + 8, right - left);
        left += lw + 16;
        tallest = Math.max(tallest, lh);
      }
      if (slots.trailing) {
        const [tw, th] = measure(slots.trailing, right - left);
        place(slots.trailing, right - tw, y + 8, tw);
        right -= tw + 16;
        tallest = Math.max(tallest, th);
      }
      let top = y + 8;
      for (const name of ["overline", "headline", "supporting"])
        if (slots[name]) top += place(slots[name], left, top, right - left)[1];
      w = room;
      h = Math.max(tallest, top - y - 8) + 16;
    } else if (size) {
      [w, h] = size as [number, number];
      for (const child of kids(element)) place(child, x, y, w);
    } else if (kind === "Column") {
      let top = y + pt;
      for (const [index, child] of kids(element).entries()) {
        if (index > 0) top += down;
        const [cw, ch] = place(child, x + ps, top, room - ps - pe);
        w = Math.max(w, cw);
        top += ch;
      }
      w += ps + pe;
      h = top - y + pb;
    } else if (kind === "FlowRow") {
      // A line at a time: a child that does not fit what is left of one starts the next.
      let left = x + ps;
      let top = y + pt;
      let line = 0;
      for (const child of kids(element)) {
        const [cw, ch] = measure(child, room - ps - pe);
        if (left > x + ps && left + cw > x + room - pe) {
          top += line + down;
          left = x + ps;
          line = 0;
        }
        place(child, left, top, x + room - pe - left);
        left += cw + across;
        line = Math.max(line, ch);
        w = Math.max(w, left - across - x);
      }
      w += pe;
      h = top + line - y + pb;
    } else if (kind === "Row") {
      let left = x + ps;
      for (const [index, child] of kids(element).entries()) {
        if (index > 0) left += across;
        const [cw, ch] = place(child, left, y + pt, x + room - pe - left);
        left += cw;
        h = Math.max(h, ch);
      }
      w = left - x + pe;
      h += pt + pb;
    } else {
      // A Box, and every slot: each child at its top left, over the others.
      for (const child of kids(element)) {
        const [cw, ch] = place(child, x + ps, y + pt, room - ps - pe);
        w = Math.max(w, cw);
        h = Math.max(h, ch);
      }
      w += ps + pe;
      h += pt + pb;
    }
    frames.set(element, { height: h, width: w, x, y });
    return [w, h];
  };
  const measure = (element: Element, room: number): [number, number] => {
    const saved = new Map(frames);
    const result = place(element, 0, 0, room);
    frames.clear();
    for (const [key, value] of saved) frames.set(key, value);
    return result;
  };
  let top = 0;
  for (const child of kids(root)) top += place(child, 0, top, width)[1];
  return frames;
}

export const intersects = (a: ComposeFrame, b: ComposeFrame): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
