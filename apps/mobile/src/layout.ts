import type { ReservedRegion } from "react-native-reserved-regions";
import { space } from "./theme.js";

/**
 * What a pane's width means for its content: `compact` is one column with
 * edge-to-edge rows; `split` has room for a list beside what it opens, so the
 * paddings are wider. It is asked of the pane a screen is drawn in, never of
 * the window, because the window's width is shared with a sidebar or a page.
 */
export type LayoutKind = "compact" | "split";

export interface Layout {
  /** The side padding a screen's content sits inside. */
  readonly gutter: number;
  readonly kind: LayoutKind;
  /** The width a column of text is allowed to reach before it stops growing. */
  readonly readingWidth: number;
}

const splitMinimumWidth = 720;
const splitMinimumHeight = 600;
// Roughly 75 characters of 16pt Inter: the top of the range a line of prose is
// read in one sweep, and the widest a row's two ends still belong to each other.
const readingWidth = 560;

export function deriveLayout(width: number, height: number): Layout {
  const split = width >= splitMinimumWidth && height >= splitMinimumHeight;
  return {
    gutter: split ? space[24] : space[16],
    kind: split ? "split" : "compact",
    readingWidth,
  };
}

export interface Size {
  readonly height: number;
  readonly width: number;
}

export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

export interface EdgeInsets {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export const noInsets: EdgeInsets = { bottom: 0, left: 0, right: 0, top: 0 };

/*
 * Pane sizes. A conversation needs room for a readable line and its composer's
 * controls; it grows with the reader's text size, because squeezing large text
 * into a second column is worse than keeping one. The sidebar is a list of
 * titles and stops needing width long before a conversation does.
 */
const sidebarWidth = 320;
const sidebarMinimum = 260;
// Beside a fold the sidebar takes the whole leading side; past this it is not a
// sidebar any more but half of a screen spent on a list.
const sidebarMaximum = 560;
// A list beside a conversation needs some height to be worth reading.
const columnMinimumHeight = 480;
const conversationWidth = 360;
const conversationMaximumWidth = 480;
const pageMinimumWidth = 320;
const pageMinimumHeight = 220;
const pairMinimumHeight = 360;
const tabletopConversationHeight = 260;
// Entering an arrangement needs this much more room than staying in it, so a
// width hovering on a threshold does not flip it every frame.
const hysteresis = 32;

const scaled = (base: number, fontScale: number) => base * Math.max(fontScale, 1);

function usable(size: Size): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
}

/**
 * The surface's reserved regions as layout reads them. Frames are not clipped
 * by the platform, so each is clipped to the surface here, and one wholly
 * outside it is gone. A division is a fold only when it crosses the whole
 * surface; a shorter one cannot divide it and is treated as an obstruction.
 */
export function surfaceRegions(bounds: Size, regions: readonly ReservedRegion[]) {
  const vertical: Rect[] = [];
  const horizontal: Rect[] = [];
  const occlusions: Rect[] = [];
  for (const region of regions) {
    const x = Math.max(0, region.frame.x);
    const y = Math.max(0, region.frame.y);
    const right = Math.min(bounds.width, region.frame.x + region.frame.width);
    const bottom = Math.min(bounds.height, region.frame.y + region.frame.height);
    // Outside the surface. A division may be a line with no width of its own.
    if (right < x || bottom < y) continue;
    const rect = { height: bottom - y, width: right - x, x, y };
    if (region.kind === "division" && rect.height >= bounds.height - 1 && rect.width < bounds.width)
      vertical.push(rect);
    else if (
      region.kind === "division" &&
      rect.width >= bounds.width - 1 &&
      rect.height < bounds.height
    )
      horizontal.push(rect);
    else if (rect.width > 0 && rect.height > 0) occlusions.push(rect);
  }
  return { horizontal, occlusions, vertical };
}

/** An interval along one axis, in the surface's physical coordinates. */
interface Span {
  readonly end: number;
  readonly start: number;
}

const length = (span: Span) => span.end - span.start;

/**
 * What the folds along one axis leave free: the intervals between them. UIKit
 * reports every division as not occluding and still asks for content to stay
 * off it, so a division's frame is its reserved margin whether or not anything
 * under it would be hidden: no pane is ever placed across one. Every fold is
 * honoured this way, the ones a split is aligned to and the ones it is not.
 */
function freeSpans(total: number, folds: readonly Span[]): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (const fold of [...folds].sort((a, b) => a.start - b.start)) {
    if (fold.start > start) spans.push({ end: fold.start, start });
    start = Math.max(start, fold.end);
  }
  if (total > start) spans.push({ end: total, start });
  return spans.length > 0 ? spans : [{ end: total, start: 0 }];
}

/** The longest span; of equals, the leading one in reading order. */
function longest(spans: readonly Span[], reversed: boolean): Span {
  const ordered = reversed ? [...spans].reverse() : spans;
  return ordered.reduce((best, span) => (length(span) > length(best) ? span : best));
}

/** A span's length less the safe-area inset at whichever surface edge it touches. */
function room(span: Span, total: number, before: number, after: number): number {
  return length(span) - (span.start <= 0 ? before : 0) - (span.end >= total ? after : 0);
}

const rectOf = (x: Span, y: Span): Rect => ({
  height: length(y),
  width: length(x),
  x: x.start,
  y: y.start,
});

/**
 * Of adjacent spans in reading order, the pair that both fit, balanced by the
 * larger smaller side. Never the first fold reported, never one assumed at the
 * middle of the surface.
 */
function bestNeighbours(
  ordered: readonly Span[],
  fits: (leading: Span, trailing: Span) => boolean,
  size: (leading: Span, trailing: Span) => number,
): { readonly leading: Span; readonly trailing: Span } | null {
  let best: { leading: Span; trailing: Span } | null = null;
  let bestSize = -1;
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const leading = ordered[index]!;
    const trailing = ordered[index + 1]!;
    if (!fits(leading, trailing)) continue;
    const next = size(leading, trailing);
    if (next > bestSize) {
      best = { leading, trailing };
      bestSize = next;
    }
  }
  return best;
}

/** The empty distance between two neighbouring spans. */
const between = (a: Span, b: Span) => Math.max(a.start, b.start) - Math.min(a.end, b.end);

/**
 * Where a rect sits inside its surface, as the space left at each side in
 * reading order: what a container pads, or a pane takes as its margins, to put
 * its content exactly there in either direction.
 */
export function edgesAround(
  bounds: Size,
  rect: Rect,
  rtl: boolean,
): { readonly bottom: number; readonly end: number; readonly start: number; readonly top: number } {
  const left = rect.x;
  const right = bounds.width - rect.x - rect.width;
  return {
    bottom: bounds.height - rect.y - rect.height,
    end: rtl ? left : right,
    start: rtl ? right : left,
    top: rect.y,
  };
}

/**
 * How far a pane's content has to keep from its edges to stay off the
 * obstructions over it. An obstruction touching an edge clears from that edge;
 * one inside the pane clears from whichever edge is nearest, so nothing
 * interactive is ever drawn under it, at the cost of the least room.
 */
export function occlusionClearance(pane: Rect, occlusions: readonly Rect[]): EdgeInsets {
  let top = 0;
  let right = 0;
  let bottom = 0;
  let left = 0;
  for (const occlusion of occlusions) {
    const x = Math.max(pane.x, occlusion.x) - pane.x;
    const y = Math.max(pane.y, occlusion.y) - pane.y;
    const endX = Math.min(pane.x + pane.width, occlusion.x + occlusion.width) - pane.x;
    const endY = Math.min(pane.y + pane.height, occlusion.y + occlusion.height) - pane.y;
    if (endX <= x || endY <= y) continue;
    const ways = [
      { edge: "top", touches: y <= 0, value: endY },
      { edge: "bottom", touches: endY >= pane.height, value: pane.height - y },
      { edge: "left", touches: x <= 0, value: endX },
      { edge: "right", touches: endX >= pane.width, value: pane.width - x },
    ] as const;
    const touching = ways.filter((way) => way.touches);
    const candidates = touching.length > 0 ? touching : ways;
    const way = candidates.reduce((least, next) => (next.value < least.value ? next : least));
    if (way.edge === "top") top = Math.max(top, way.value);
    else if (way.edge === "bottom") bottom = Math.max(bottom, way.value);
    else if (way.edge === "left") left = Math.max(left, way.value);
    else right = Math.max(right, way.value);
  }
  return top === 0 && right === 0 && bottom === 0 && left === 0
    ? noInsets
    : { bottom, left, right, top };
}

export type SidebarArrangement =
  | { readonly mode: "drawer" }
  | {
      readonly mode: "column";
      /** Empty space between the column and the stack: a fold's reserved width. */
      readonly gap: number;
      readonly width: number;
    };

export interface ShellInput {
  /**
   * The screen in front arranges a page and its conversation around the folds
   * itself, so its pane spans the ones the sidebar leaves rather than keeping
   * to one side of them.
   */
  readonly aroundFolds: boolean;
  /** The shell's own measured surface, in its provider's points. */
  readonly bounds: Size;
  readonly fontScale: number;
  /** The shell surface's own safe area: what a pane at each edge cannot use. */
  readonly insets: EdgeInsets;
  readonly previous: SidebarArrangement;
  /** The shell's provider has measured its regions, even as none. */
  readonly ready: boolean;
  readonly regions: readonly ReservedRegion[];
  readonly rtl: boolean;
}

export interface ShellArrangement {
  /** Where the stack is drawn, in the shell's coordinates; off every fold. */
  readonly content: Rect;
  readonly contentClearance: EdgeInsets;
  readonly sidebar: SidebarArrangement;
  readonly sidebarClearance: EdgeInsets;
  readonly sidebarRect: Rect | null;
  /** How wide the drawer may open from the leading edge before reaching a fold. */
  readonly leadingRoom: number;
}

/**
 * The shell's arrangement: the sidebar docked as a column beside the stack
 * wherever the surface has room for both, whatever the stack shows, or a
 * drawer over it, and exactly where each is drawn. It depends on geometry
 * alone, so the sidebar is never taken away by what is in front. Until the
 * surface is measured the drawer stays: a column drawn before a fold is known
 * could straddle it. Whatever is chosen stays off every fold: a single pane
 * takes the largest span the folds leave, not the whole surface — except a
 * page with its conversation, whose pair surface keeps itself off the folds it
 * cannot use and is handed the ones it can.
 */
export function deriveShell(input: ShellInput): ShellArrangement {
  const { bounds, fontScale, insets, previous, rtl } = input;
  if (!usable(bounds))
    return {
      content: { height: 0, width: 0, x: 0, y: 0 },
      contentClearance: noInsets,
      sidebar: previous,
      sidebarClearance: noInsets,
      sidebarRect: null,
      leadingRoom: 0,
    };
  const regions = surfaceRegions(bounds, input.regions);
  const xs = freeSpans(
    bounds.width,
    regions.vertical.map((rect) => ({ end: rect.x + rect.width, start: rect.x })),
  );
  const band = longest(
    freeSpans(
      bounds.height,
      regions.horizontal.map((rect) => ({ end: rect.y + rect.height, start: rect.y })),
    ),
    false,
  );
  const columns = shellColumns();
  const sidebarRect = columns.sidebar === null ? null : rectOf(columns.sidebar, band);
  // A page with its conversation arranges itself around the folds — tabletop
  // at a horizontal one, side by side at a vertical one — in its own surface,
  // which must contain them to see them. The shell hands it every fold the
  // sidebar does not keep it from: beside a column, its whole height.
  const content = !input.aroundFolds
    ? rectOf(columns.content, band)
    : columns.sidebar === null
      ? { height: bounds.height, width: bounds.width, x: 0, y: 0 }
      : rectOf(columns.content, { end: bounds.height, start: 0 });
  const leading = rtl ? xs[xs.length - 1]! : xs[0]!;
  return {
    content,
    contentClearance: occlusionClearance(content, regions.occlusions),
    leadingRoom: rtl ? bounds.width - leading.start : leading.end,
    sidebar:
      columns.sidebar === null
        ? { mode: "drawer" }
        : {
            gap: between(columns.sidebar, columns.content),
            mode: "column",
            width: length(columns.sidebar),
          },
    sidebarClearance:
      sidebarRect === null ? noInsets : occlusionClearance(sidebarRect, regions.occlusions),
    sidebarRect,
  };

  function shellColumns(): { readonly content: Span; readonly sidebar: Span | null } {
    const drawer = { content: longest(xs, rtl), sidebar: null };
    if (!input.ready) return drawer;
    if (length(band) < columnMinimumHeight) return drawer;
    const entering = previous.mode !== "column";
    const conversation = scaled(conversationWidth, fontScale) + (entering ? hysteresis : 0);
    const fits = (span: Span) =>
      room(span, bounds.width, insets.left, insets.right) >= conversation;
    if (xs.length > 1) {
      // The list and the conversation each keep to their own spans between
      // folds; when no neighbouring pair holds both, the sidebar is a drawer.
      const split = bestNeighbours(
        rtl ? [...xs].reverse() : xs,
        (list, rest) =>
          length(list) >= sidebarMinimum && length(list) <= sidebarMaximum && fits(rest),
        (list, rest) => Math.min(length(list), length(rest)),
      );
      return split === null ? drawer : { content: split.trailing, sidebar: split.leading };
    }
    const whole = xs[0]!;
    const sidebar = rtl
      ? { end: whole.end, start: whole.end - sidebarWidth }
      : { end: whole.start + sidebarWidth, start: whole.start };
    const rest = rtl
      ? { end: sidebar.start, start: whole.start }
      : { end: whole.end, start: sidebar.end };
    return fits(rest) ? { content: rest, sidebar } : drawer;
  }
}

export type PagePair =
  | { readonly mode: "stacked" }
  | { readonly mode: "side"; readonly gap: number; readonly pageWidth: number }
  | { readonly mode: "tabletop"; readonly gap: number; readonly pageHeight: number };

export interface PairInput {
  readonly bounds: Size;
  readonly fontScale: number;
  /** The pair's own safe area: what a pane at each edge cannot use. */
  readonly insets: EdgeInsets;
  readonly previous: PagePair;
  readonly ready: boolean;
  readonly regions: readonly ReservedRegion[];
  readonly rtl: boolean;
}

/**
 * A page beside its occupant's own Thread, or above it across a horizontal
 * fold; compact shows the page alone. The pair stays off every fold it is not
 * split at. Tabletop needs a fold the system reports and both halves useful;
 * it is never inferred from the shape of the window.
 */
export function derivePagePair(input: PairInput): {
  readonly pair: PagePair;
  readonly region: Rect;
} {
  const { bounds, fontScale, insets, previous, rtl } = input;
  const whole = { height: bounds.height, width: bounds.width, x: 0, y: 0 };
  if (!usable(bounds)) return { pair: previous, region: whole };
  const stacked = { mode: "stacked" } as const;
  if (!input.ready) return { pair: stacked, region: whole };
  const regions = surfaceRegions(bounds, input.regions);
  const xs = freeSpans(
    bounds.width,
    regions.vertical.map((rect) => ({ end: rect.x + rect.width, start: rect.x })),
  );
  const ys = freeSpans(
    bounds.height,
    regions.horizontal.map((rect) => ({ end: rect.y + rect.height, start: rect.y })),
  );
  const conversation = scaled(conversationWidth, fontScale);

  if (ys.length > 1) {
    const needed =
      scaled(tabletopConversationHeight, fontScale) +
      (previous.mode === "tabletop" ? 0 : hysteresis);
    const fold = bestNeighbours(
      ys,
      (top, bottom) =>
        length(top) >= pageMinimumHeight &&
        room(bottom, bounds.height, insets.top, insets.bottom) >= needed,
      (top, bottom) => Math.min(length(top), length(bottom)),
    );
    if (fold !== null) {
      const across = longest(xs, rtl);
      return {
        pair: {
          gap: between(fold.leading, fold.trailing),
          mode: "tabletop",
          pageHeight: length(fold.leading),
        },
        region: rectOf(across, { end: fold.trailing.end, start: fold.leading.start }),
      };
    }
  }

  const tall = longest(ys, false);
  const stackedRegion = { pair: stacked, region: rectOf(longest(xs, rtl), tall) };
  if (length(tall) < pairMinimumHeight) return stackedRegion;
  const entering = previous.mode !== "side";
  const conversationNeeded = conversation + (entering ? hysteresis : 0);
  const fits = (span: Span) =>
    room(span, bounds.width, insets.left, insets.right) >= conversationNeeded;
  if (xs.length > 1) {
    const split = bestNeighbours(
      rtl ? [...xs].reverse() : xs,
      (page, rest) => length(page) >= pageMinimumWidth && fits(rest),
      (page, rest) => Math.min(length(page), length(rest)),
    );
    if (split === null) return stackedRegion;
    const start = Math.min(split.leading.start, split.trailing.start);
    const end = Math.max(split.leading.end, split.trailing.end);
    return {
      pair: {
        gap: between(split.leading, split.trailing),
        mode: "side",
        pageWidth: length(split.leading),
      },
      region: rectOf({ end, start }, tall),
    };
  }
  const span = xs[0]!;
  if (room(span, bounds.width, insets.left, insets.right) < pageMinimumWidth + conversationNeeded)
    return stackedRegion;
  const conversationShare = Math.min(
    Math.max(length(span) * 0.4, conversation),
    scaled(conversationMaximumWidth, fontScale),
  );
  return {
    pair: { gap: 0, mode: "side", pageWidth: Math.round(length(span) - conversationShare) },
    region: rectOf(span, tall),
  };
}
