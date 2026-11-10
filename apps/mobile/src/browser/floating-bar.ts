/**
 * How the bar of a page on this phone behaves, as the platform's own browser's does: it floats
 * over the page, shrinks while the person reads down and returns when they head back up or reach
 * either end. iPhone and Android share these decisions; each platform reports its page's scroll.
 */

/** Below this height the page's top bar floats too, as Safari's does on a phone held sideways. */
const floatingHeight = 500;
/** How far the person reads one way before the bar changes. */
const travel = 24;
/** Within this of either end, the bar is shown. */
const endSlop = 8;

/**
 * Whether a page on this phone has its bar float over it. Beside its conversation, and on a
 * tall regular screen where the bar stands over the page, it stays put, as Safari's does on iPad.
 */
export function barFloats(page: {
  readonly edge: "bottom" | "top";
  readonly height: number;
  readonly paired: boolean;
}): boolean {
  return !page.paired && (page.edge === "bottom" || page.height < floatingHeight);
}

export interface BarScroll {
  readonly shrunk: boolean;
  /** Where the page turned last: the furthest it went since the bar last changed. */
  readonly from: number;
}

export const barShown: BarScroll = { from: 0, shrunk: false };

/**
 * The bar after the page moved to `page.y`. Only the person's own scrolling shrinks or returns
 * it; an agent, a restored position or the keyboard moving the page leaves it as it is, but
 * either end of the page always shows it.
 */
export function nextBar(
  state: BarScroll,
  page: { readonly end: number; readonly person: boolean; readonly y: number },
): BarScroll {
  "worklet";
  const { end, person, y } = page;
  if (y <= endSlop || y >= end - endSlop)
    return state.shrunk || state.from !== y ? { from: y, shrunk: false } : state;
  if (!person) return state.from === y ? state : { from: y, shrunk: state.shrunk };
  if (state.shrunk ? y > state.from : y < state.from) return { from: y, shrunk: state.shrunk };
  return Math.abs(y - state.from) < travel ? state : { from: y, shrunk: !state.shrunk };
}

/** What a swipe in from the page's leading edge does: back through the page, else out of the tab. */
export function edgeSwipe(history: { readonly canGoBack: boolean }): "page" | "leave" {
  return history.canGoBack ? "page" : "leave";
}
