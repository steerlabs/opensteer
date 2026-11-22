import {
  createElement,
  forwardRef,
  useImperativeHandle,
  type ForwardedRef,
  type ReactNode,
} from "react";
import { act } from "react";
import Yoga, {
  Align,
  Direction,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Wrap,
  type Node as YogaNode,
} from "yoga-layout";

/*
 * React Native's own layout, in a test. These stand-ins for `react-native` draw each view as a
 * DOM element that keeps its props, and `layout` hands the tree to Yoga — the engine React
 * Native lays every view out with — at a phone's width and text size. A test then reads the
 * frames a person would see: where a label is, whether two things cover each other, whether a
 * line of text had to be cut. It reads frames, never a style's value.
 *
 * Text is measured by its characters at the font's size and the reader's text size (capped by
 * `maxFontSizeMultiplier`, as iOS caps it), wrapped by word, so a line that cannot fit in its
 * `numberOfLines` is reported as cut.
 */

export interface Rect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

/** What the window is, as `useWindowDimensions` reads it. */
export const layoutWindow = { fontScale: 1, height: 844, width: 390 };

/**
 * The average advance of a character of the app's text face, as a share of its size. Inter
 * runs near half an em; this errs wide, so a test passes only with room to spare.
 */
const advance = 0.56;

interface Host {
  readonly kind: "View" | "Text" | "ScrollView" | "ScrollContent" | "TextInput" | "Image";
  readonly props: Record<string, unknown>;
}
const hosts = new WeakMap<Element, Host>();

type Style = Record<string, unknown>;
function flatten(style: unknown): Style {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  if (typeof style === "object") return style as Style;
  return {};
}

function host(kind: Host["kind"], props: Record<string, unknown>, children: ReactNode) {
  const attributes: Record<string, unknown> = {
    "data-rn": kind,
    ref: (element: Element | null) => {
      if (element) hosts.set(element, { kind, props });
    },
  };
  const label = props["accessibilityLabel"];
  if (typeof label === "string") attributes["aria-label"] = label;
  if (typeof props["testID"] === "string") attributes["data-testid"] = props["testID"];
  if (props["accessibilityRole"] === "button" || props["accessibilityRole"] === "link")
    attributes["role"] = props["accessibilityRole"];
  if (typeof props["onPress"] === "function") {
    attributes["onClick"] = props["disabled"] === true ? undefined : props["onPress"];
    attributes["data-pressable"] = "";
  }
  if (props["disabled"] === true) attributes["aria-disabled"] = "true";
  return createElement("div", attributes, children);
}

function View(props: Record<string, unknown> & { readonly children?: ReactNode }) {
  return host("View", props, props.children);
}
function Text(props: Record<string, unknown> & { readonly children?: ReactNode }) {
  return host("Text", props, props.children);
}
function Pressable(props: Record<string, unknown> & { readonly children?: unknown }) {
  const style =
    typeof props["style"] === "function" ? props["style"]({ pressed: false }) : props["style"];
  const children =
    typeof props.children === "function" ? props.children({ pressed: false }) : props.children;
  return host("View", { ...props, style }, children as ReactNode);
}
const ScrollView = forwardRef(function ScrollView(
  props: Record<string, unknown> & { readonly children?: ReactNode },
  ref: ForwardedRef<unknown>,
) {
  useImperativeHandle(ref, () => ({
    scrollTo: () => undefined,
    scrollToEnd: () => undefined,
    flashScrollIndicators: () => undefined,
  }));
  const content = host(
    "ScrollContent",
    { style: props["contentContainerStyle"], horizontal: props["horizontal"] },
    props.children,
  );
  return host("ScrollView", props, content);
});
function TextInput(props: Record<string, unknown>) {
  return host("TextInput", props, typeof props["value"] === "string" ? props["value"] : "");
}
function ActivityIndicator(props: Record<string, unknown>) {
  return host("View", { ...props, style: [{ height: 20, width: 20 }, props["style"]] }, null);
}
function Image(props: Record<string, unknown>) {
  return host("Image", props, null);
}

const absoluteFill = { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 } as const;

/** `vi.mock("react-native", ...)`: the pieces the screens under test draw with. */
export const layoutReactNative = {
  AccessibilityInfo: {
    addEventListener: () => ({ remove: () => undefined }),
    announceForAccessibility: () => undefined,
    isReduceMotionEnabled: async () => false,
  },
  ActivityIndicator,
  Alert: { alert: () => undefined },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  I18nManager: { isRTL: false },
  Image,
  Keyboard: {
    addListener: () => ({ remove: () => undefined }),
    dismiss: () => undefined,
  },
  Linking: { openURL: async () => undefined },
  PixelRatio: {
    get: () => 3,
    getFontScale: () => layoutWindow.fontScale,
    roundToNearestPixel: (value: number) => Math.round(value * 3) / 3,
  },
  Platform: {
    OS: "ios",
    Version: "26",
    select: (options: { readonly ios?: unknown; readonly default?: unknown }) =>
      "ios" in options ? options.ios : options.default,
  },
  Pressable,
  ScrollView,
  StyleSheet: {
    absoluteFill,
    absoluteFillObject: absoluteFill,
    create: <T,>(styles: T) => styles,
    flatten,
    hairlineWidth: 1 / 3,
  },
  Text,
  TextInput,
  View,
  useWindowDimensions: () => ({ ...layoutWindow, scale: 3 }),
};

/** `vi.mock("react-native-reanimated", ...)`: animated views are views at rest. */
export const layoutReanimated = {
  __esModule: true,
  default: { View, Text, ScrollView },
  FadeIn: { duration: () => ({ delay: () => ({}) }) },
  FadeInDown: { duration: () => ({}) },
  FadeInUp: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  LayoutAnimationConfig: (props: { readonly children?: ReactNode }) => props.children,
  LinearTransition: { duration: () => ({}) },
  cancelAnimation: () => undefined,
  Easing: { inOut: () => undefined, ease: undefined, linear: undefined },
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  withRepeat: (value: unknown) => value,
  withSequence: (value: unknown) => value,
  useSharedValue: (value: unknown) => ({ value }),
  withTiming: (value: unknown) => value,
};

/* ------------------------------------------------------------------------- *
 * Laying the tree out
 * ------------------------------------------------------------------------- */

interface Laid {
  readonly element: Element;
  readonly host: Host;
  readonly node: YogaNode;
  readonly children: Laid[];
  /** For text: the lines its words needed, and the lines it may show. */
  text?: { needed: number; shown: number; chars: number };
}

const alignOf: Record<string, Align> = {
  auto: Align.Auto,
  baseline: Align.Baseline,
  center: Align.Center,
  "flex-end": Align.FlexEnd,
  "flex-start": Align.FlexStart,
  "space-around": Align.SpaceAround,
  "space-between": Align.SpaceBetween,
  stretch: Align.Stretch,
};
const justifyOf: Record<string, Justify> = {
  center: Justify.Center,
  "flex-end": Justify.FlexEnd,
  "flex-start": Justify.FlexStart,
  "space-around": Justify.SpaceAround,
  "space-between": Justify.SpaceBetween,
  "space-evenly": Justify.SpaceEvenly,
};
const directionOf: Record<string, FlexDirection> = {
  column: FlexDirection.Column,
  "column-reverse": FlexDirection.ColumnReverse,
  row: FlexDirection.Row,
  "row-reverse": FlexDirection.RowReverse,
};

type Length = number | `${number}%` | "auto" | undefined;
const length = (value: unknown): Length =>
  typeof value === "number" ||
  value === "auto" ||
  (typeof value === "string" && value.endsWith("%"))
    ? (value as Length)
    : undefined;

function edges(
  style: Style,
  prefix: "margin" | "padding",
  set: (edge: Edge, value: Length) => void,
): void {
  const pairs: [string, Edge][] = [
    [prefix, Edge.All],
    [`${prefix}Horizontal`, Edge.Horizontal],
    [`${prefix}Vertical`, Edge.Vertical],
    [`${prefix}Top`, Edge.Top],
    [`${prefix}Bottom`, Edge.Bottom],
    [`${prefix}Left`, Edge.Left],
    [`${prefix}Right`, Edge.Right],
    [`${prefix}Start`, Edge.Start],
    [`${prefix}End`, Edge.End],
  ];
  for (const [key, edge] of pairs) {
    const value = length(style[key]);
    if (value !== undefined) set(edge, value);
  }
}

function applyStyle(node: YogaNode, style: Style): void {
  const number = (key: string) =>
    typeof style[key] === "number" ? (style[key] as number) : undefined;
  if (style["display"] === "none") node.setDisplay(Display.None);
  if (typeof style["flexDirection"] === "string")
    node.setFlexDirection(directionOf[style["flexDirection"]] ?? FlexDirection.Column);
  if (style["flexWrap"] === "wrap") node.setFlexWrap(Wrap.Wrap);
  if (typeof style["alignItems"] === "string") node.setAlignItems(alignOf[style["alignItems"]]!);
  if (typeof style["alignSelf"] === "string") node.setAlignSelf(alignOf[style["alignSelf"]]!);
  if (typeof style["alignContent"] === "string")
    node.setAlignContent(alignOf[style["alignContent"]]!);
  if (typeof style["justifyContent"] === "string")
    node.setJustifyContent(justifyOf[style["justifyContent"]]!);
  if (number("flex") !== undefined) node.setFlex(number("flex"));
  if (number("flexGrow") !== undefined) node.setFlexGrow(number("flexGrow"));
  if (number("flexShrink") !== undefined) node.setFlexShrink(number("flexShrink"));
  const basis = length(style["flexBasis"]);
  if (basis !== undefined) node.setFlexBasis(basis);
  const size: [string, (value: Length) => void][] = [
    ["width", (value) => node.setWidth(value)],
    ["height", (value) => node.setHeight(value)],
    ["minWidth", (value) => node.setMinWidth(value as never)],
    ["minHeight", (value) => node.setMinHeight(value as never)],
    ["maxWidth", (value) => node.setMaxWidth(value as never)],
    ["maxHeight", (value) => node.setMaxHeight(value as never)],
  ];
  for (const [key, set] of size) {
    const value = length(style[key]);
    if (value !== undefined) set(value);
  }
  if (number("aspectRatio") !== undefined) node.setAspectRatio(number("aspectRatio"));
  edges(style, "margin", (edge, value) => node.setMargin(edge, value));
  edges(style, "padding", (edge, value) => node.setPadding(edge, value as never));
  const borders: [string, Edge][] = [
    ["borderWidth", Edge.All],
    ["borderTopWidth", Edge.Top],
    ["borderBottomWidth", Edge.Bottom],
    ["borderLeftWidth", Edge.Left],
    ["borderRightWidth", Edge.Right],
    ["borderStartWidth", Edge.Start],
    ["borderEndWidth", Edge.End],
  ];
  for (const [key, edge] of borders)
    if (number(key) !== undefined) node.setBorder(edge, number(key));
  if (number("gap") !== undefined) node.setGap(Gutter.All, number("gap"));
  if (number("rowGap") !== undefined) node.setGap(Gutter.Row, number("rowGap"));
  if (number("columnGap") !== undefined) node.setGap(Gutter.Column, number("columnGap"));
  if (style["position"] === "absolute") node.setPositionType(PositionType.Absolute);
  const insets: [string, Edge][] = [
    ["top", Edge.Top],
    ["bottom", Edge.Bottom],
    ["left", Edge.Left],
    ["right", Edge.Right],
    ["start", Edge.Start],
    ["end", Edge.End],
  ];
  for (const [key, edge] of insets) {
    const value = length(style[key]);
    if (value !== undefined && value !== "auto") node.setPosition(edge, value);
  }
  if (style["overflow"] === "hidden") node.setOverflow(Overflow.Hidden);
  if (style["overflow"] === "scroll") node.setOverflow(Overflow.Scroll);
}

/** A line of text: how wide it is, and how many characters it holds. */
interface Line {
  readonly width: number;
  readonly chars: number;
}

/** A text's words, wrapped greedily into lines at a width, as a line breaker would. */
function wrap(words: readonly string[], charWidth: number, available: number): Line[] {
  // Narrower than one character still holds one character a line.
  const width = Math.max(available, charWidth);
  const perLine = Math.max(1, Math.floor((width + 0.01) / charWidth));
  const lines: Line[] = [];
  let chars = 0;
  const push = () => {
    lines.push({ chars, width: chars * charWidth });
    chars = 0;
  };
  for (const word of words) {
    const next = chars === 0 ? word.length : chars + 1 + word.length;
    if (chars > 0 && next > perLine) push();
    if (chars === 0 && word.length > perLine) {
      // A word longer than the line breaks where it must.
      let rest = word.length;
      while (rest > perLine) {
        chars = perLine;
        push();
        rest -= perLine;
      }
      chars = rest;
      continue;
    }
    chars = chars === 0 ? word.length : chars + 1 + word.length;
  }
  if (chars > 0 || lines.length === 0) push();
  return lines;
}

function textMeasure(laid: Laid, style: Style) {
  const props = laid.host.props;
  const limit =
    typeof props["maxFontSizeMultiplier"] === "number" ? props["maxFontSizeMultiplier"] : Infinity;
  const scale = props["allowFontScaling"] === false ? 1 : Math.min(layoutWindow.fontScale, limit);
  const size = (typeof style["fontSize"] === "number" ? style["fontSize"] : 14) * scale;
  const lineHeight =
    (typeof style["lineHeight"] === "number" ? style["lineHeight"] : (size / scale) * 1.2) * scale;
  const words = (laid.element.textContent ?? "").split(/\s+/u).filter(Boolean);
  const shownLimit =
    typeof props["numberOfLines"] === "number" && props["numberOfLines"] > 0
      ? props["numberOfLines"]
      : Infinity;
  const charWidth = size * advance;
  return (width: number, mode: MeasureMode) => {
    const unbounded = mode === MeasureMode.Undefined || !Number.isFinite(width);
    const lines = wrap(words, charWidth, unbounded ? Infinity : width);
    const shown = Math.min(lines.length, shownLimit);
    laid.text = {
      needed: lines.length,
      shown,
      // A cut line gives its last character to the ellipsis.
      // Lines meet at the space the break took.
      chars:
        lines.slice(0, shown).reduce((sum, line) => sum + line.chars, 0) +
        Math.max(0, shown - 1) -
        (shown < lines.length ? 1 : 0),
    };
    const widest = Math.max(0, ...lines.slice(0, shown).map((line) => line.width));
    return {
      height: shown * lineHeight,
      width: unbounded ? widest : Math.min(width, Math.ceil(widest)),
    };
  };
}

function build(element: Element): Laid[] {
  const found = hosts.get(element);
  if (!found || !element.isConnected) return [...element.children].flatMap(build);
  const node = Yoga.Node.create();
  const laid: Laid = { children: [], element, host: found, node };
  const style = flatten(found.props["style"]);
  if (found.kind === "ScrollView") {
    // React Native's own base style for a scroll view: it takes the room it is given.
    node.setOverflow(Overflow.Scroll);
    node.setFlexGrow(1);
    node.setFlexShrink(1);
    applyStyle(node, style);
    if (found.props["horizontal"] === true) node.setFlexDirection(FlexDirection.Row);
  } else if (found.kind === "ScrollContent") {
    applyStyle(node, style);
    node.setFlexShrink(0);
    if (found.props["horizontal"] === true) node.setFlexDirection(FlexDirection.Row);
  } else applyStyle(node, style);
  if (found.kind === "Text" || found.kind === "TextInput") {
    // Words inside a text are inline: the text is one box measured as a whole.
    node.setMeasureFunc(textMeasure(laid, style));
    return [laid];
  }
  for (const child of [...element.children].flatMap(build)) {
    node.insertChild(child.node, laid.children.length);
    laid.children.push(child);
  }
  return [laid];
}

export interface Frames {
  /**
   * Whether the layout came to rest: a pass in which no view's layout event changed anything.
   * One that never does is a measure loop, which keeps a phone's main thread busy for good.
   */
  readonly settled?: boolean;
  /** The frame of an element drawn by these stand-ins, in the window's points. */
  readonly frame: (element: Element) => Rect;
  /** The frame of what is visible of an element: clipped by every scroll view around it. */
  readonly visible: (element: Element) => Rect | null;
  /** Whether a text had to be cut to its lines. */
  readonly cut: (element: Element) => boolean;
  /** The characters of a text a person sees: all of them, or those before its ellipsis. */
  readonly shown: (element: Element) => string;
  /** Every text drawn, with its words. */
  readonly texts: () => readonly { readonly element: Element; readonly words: string }[];
}

/**
 * Lays the drawn tree out in a window of `width` by `height` points, then gives each view its
 * layout events, as React Native does, until nothing it draws changes size.
 */
export async function layout(container: Element, window: { width: number; height: number }) {
  let frames: Frames | null = null;
  let settled = false;
  for (let pass = 0; pass < 8; pass += 1) {
    const result = once(container, window);
    frames = result.frames;
    let changed = false;
    await act(async () => {
      changed = result.notify();
    });
    if (!changed) {
      settled = true;
      break;
    }
  }
  return { ...frames!, settled };
}

const layoutEvents = new WeakMap<Element, string>();

function once(container: Element, window: { width: number; height: number }) {
  const root = Yoga.Node.create();
  root.setWidth(window.width);
  root.setHeight(window.height);
  const tops = [...container.children].flatMap(build);
  tops.forEach((laid, index) => root.insertChild(laid.node, index));
  root.calculateLayout(window.width, window.height, Direction.LTR);
  const absolute = new Map<Element, Rect>();
  const clip = new Map<Element, Rect | null>();
  const texts = new Map<Element, Laid>();
  const local = new Map<Element, Rect>();
  const content = new Map<Element, { width: number; height: number }>();
  const walk = (laid: Laid, x: number, y: number, clipped: Rect | null): void => {
    const box = laid.node.getComputedLayout();
    const frame = { height: box.height, width: box.width, x: x + box.left, y: y + box.top };
    absolute.set(laid.element, frame);
    local.set(laid.element, { height: box.height, width: box.width, x: box.left, y: box.top });
    clip.set(laid.element, clipped === null ? frame : intersection(frame, clipped));
    if (laid.text) texts.set(laid.element, laid);
    const inner =
      laid.host.kind === "ScrollView" ? (clipped ? intersection(frame, clipped) : frame) : clipped;
    if (laid.host.kind === "ScrollView") {
      const child = laid.children[0]?.node.getComputedLayout();
      if (child) content.set(laid.element, { height: child.height, width: child.width });
    }
    for (const child of laid.children) walk(child, frame.x, frame.y, inner);
  };
  tops.forEach((laid) => walk(laid, 0, 0, null));
  const notify = (): boolean => {
    let changed = false;
    for (const [element, frame] of local) {
      const props = hosts.get(element)!.props;
      const key = JSON.stringify(frame);
      const contentSize = content.get(element);
      const contentKey = contentSize ? JSON.stringify(contentSize) : "";
      if (layoutEvents.get(element) === key + contentKey) continue;
      layoutEvents.set(element, key + contentKey);
      if (typeof props["onLayout"] === "function") {
        changed = true;
        (props["onLayout"] as (event: unknown) => void)({ nativeEvent: { layout: frame } });
      }
      if (contentSize && typeof props["onContentSizeChange"] === "function") {
        changed = true;
        (props["onContentSizeChange"] as (width: number, height: number) => void)(
          contentSize.width,
          contentSize.height,
        );
      }
    }
    return changed;
  };
  root.freeRecursive();
  const frames: Frames = {
    cut: (element) => {
      const laid = texts.get(element);
      return laid?.text !== undefined && laid.text.needed > laid.text.shown;
    },
    shown: (element) => {
      const words = (element.textContent ?? "").split(/\s+/u).filter(Boolean).join(" ");
      const laid = texts.get(element);
      return laid?.text === undefined ? words : words.slice(0, laid.text.chars);
    },
    frame: (element) => {
      const found = absolute.get(element);
      if (!found) throw new Error(`Not laid out: ${element.outerHTML.slice(0, 200)}`);
      return found;
    },
    texts: () =>
      [...texts.keys()].map((element) => ({ element, words: element.textContent ?? "" })),
    visible: (element) => {
      const found = clip.get(element);
      return found === undefined || found === null || found.width <= 0 || found.height <= 0
        ? null
        : found;
    },
  };
  return { frames, notify };
}

export function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { height: Math.max(0, bottom - y), width: Math.max(0, right - x), x, y };
}

/** Whether two frames cover any of each other, beyond a hair of rounding. */
export function overlaps(a: Rect, b: Rect): boolean {
  const shared = intersection(a, b);
  return shared.width > 0.5 && shared.height > 0.5;
}

/** Whether `inner` lies wholly inside `outer`. */
export function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

/**
 * The text drawn whose words contain `words`: a whole text box as it is laid out (words nested
 * inside a text are part of it), the shortest that holds them.
 */
export function textElement(container: Element, words: string): Element {
  const boxes = [...container.querySelectorAll('[data-rn="Text"]')].filter(
    (element) =>
      element.parentElement?.closest('[data-rn="Text"]') === null &&
      (element.textContent ?? "").includes(words),
  );
  const found = boxes.sort(
    (a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length,
  )[0];
  if (!found) throw new Error(`No text "${words}" in ${container.textContent ?? ""}`);
  return found;
}

/**
 * What is drawn over an element: anything placed absolutely, outside the element and its own
 * contents, that comes after it and covers part of what is visible of it.
 */
export function coveringOf(container: Element, frames: Frames, element: Element): Element[] {
  const seen = frames.visible(element);
  if (seen === null) return [];
  const all = [...container.querySelectorAll("[data-rn]")];
  const index = all.indexOf(element);
  return all.filter((other, at) => {
    if (at <= index || other.contains(element) || element.contains(other)) return false;
    const style = flatten(hosts.get(other)?.props["style"]);
    if (style["position"] !== "absolute") return false;
    const over = frames.visible(other);
    return over !== null && overlaps(over, seen);
  });
}

/**
 * Whether a person can bring an element into view: inside the window when nothing scrolls it,
 * or inside its scroll view's width and its scrolled content, which never starts above the
 * scroll view's own top (where nothing could scroll it back down).
 */
export function reachable(
  frames: Frames,
  element: Element,
  window: { readonly width: number; readonly height: number },
): boolean {
  const frame = frames.frame(element);
  const content = element.closest('[data-rn="ScrollContent"]');
  const screen = { height: window.height, width: window.width, x: 0, y: 0 };
  if (!content?.parentElement) return inside(frame, screen);
  const box = frames.frame(content);
  const view = frames.frame(content.parentElement);
  return (
    box.y >= view.y - 0.5 &&
    inside(frame, { height: box.height, width: view.width, x: view.x, y: box.y }) &&
    reachable(frames, content.parentElement, window)
  );
}
