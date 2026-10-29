import { describe, expect, it } from "vitest";
import type { ReservedRegion } from "react-native-reserved-regions";
import {
  derivePagePair,
  deriveShell,
  noInsets,
  occlusionClearance,
  type PagePair,
  type PairInput,
  type ShellInput,
  type SidebarArrangement,
} from "./layout.js";

/*
 * Where window geometry decides the app's arrangement. What can go wrong:
 * - a fold is guessed at half the width, or the first division reported wins;
 * - a pane straddles a division, or a pane is drawn under one;
 * - geometry not yet measured is trusted, so an unmeasured fold is straddled;
 * - a region outside the surface (frames are not clipped) moves a pane;
 * - a short division (a camera island, not a fold) splits the content;
 * - larger text is squeezed into a second column instead of keeping one;
 * - a width hovering on a threshold flips the arrangement every frame;
 * - an interior occlusion sits over controls nobody moved out of its way;
 * - right-to-left puts the sidebar or page on the trailing side of a fold;
 * - watching a page shows three cramped panes on an ordinary inner display;
 * - the reader's choice to hide the sidebar is overridden by room to show it;
 * - a keyboard under tabletop leaves the conversation no room to type in;
 * - a division no pane is split at is ignored, so a single pane, a hidden
 *   sidebar or large text puts content across a fold, or under an occluding one;
 * - of several divisions only the one used for a split is honoured;
 * - a fit is judged on the surface's raw width, so a pane passes that the
 *   safe area (a notch, the vertical bar) then leaves too narrow;
 * - text scale is capped, so the largest sizes are squeezed into two columns.
 */

const division = (
  x: number,
  y: number,
  width: number,
  height: number,
  occludesContent = false,
): ReservedRegion => ({
  frame: { height, width, x, y },
  kind: "division",
  occludesContent,
});
const occlusion = (x: number, y: number, width: number, height: number): ReservedRegion => ({
  frame: { height, width, x, y },
  kind: "occlusion",
});

const drawer: SidebarArrangement = { mode: "drawer" };

function shell(overrides: Partial<ShellInput>) {
  return deriveShell({
    bounds: { height: 1000, width: 1000 },
    fontScale: 1,
    insets: noInsets,
    previous: drawer,
    ready: true,
    regions: [],
    rtl: false,
    shown: true,
    watching: false,
    ...overrides,
  });
}

function arrange(
  overrides: Partial<PairInput> & {
    readonly bounds: { readonly height: number; readonly width: number };
  },
) {
  return derivePagePair({
    fontScale: 1,
    insets: noInsets,
    previous: { mode: "stacked" },
    ready: true,
    regions: [],
    rtl: false,
    ...overrides,
  });
}
const pair = (overrides: Parameters<typeof arrange>[0]): PagePair => arrange(overrides).pair;

describe("the shell's sidebar", () => {
  it("stays a drawer until the surface has been measured, even with room and a fold", () => {
    expect(shell({ ready: false }).sidebar).toEqual(drawer);
    expect(shell({ ready: false, regions: [division(400, 0, 20, 1000)] }).sidebar).toEqual(drawer);
  });

  it("is a column beside the conversation when a measured surface has room for both", () => {
    // An iPad mini in portrait, with no reserved regions.
    expect(shell({ bounds: { height: 1133, width: 744 } }).sidebar).toEqual({
      gap: 0,
      mode: "column",
      width: 320,
    });
    // A phone in portrait never has room for two.
    expect(shell({ bounds: { height: 844, width: 390 } }).sidebar).toEqual(drawer);
    // A phone on its side is too short to read a list beside a conversation.
    expect(shell({ bounds: { height: 430, width: 932 } }).sidebar).toEqual(drawer);
  });

  it("ends the column exactly at a measured fold and leaves the fold's own width empty", () => {
    const fold = division(470, 0, 24, 1000);
    expect(shell({ bounds: { height: 1000, width: 980 }, regions: [fold] }).sidebar).toEqual({
      gap: 24,
      mode: "column",
      width: 470,
    });
  });

  it("never guesses a fold at half the width, and never trusts list order among folds", () => {
    // A fold far from the middle still decides where the column ends.
    expect(
      shell({ bounds: { height: 1000, width: 1000 }, regions: [division(300, 0, 10, 1000)] })
        .sidebar,
    ).toEqual({ gap: 10, mode: "column", width: 300 });
    // Of two folds, the one leaving the larger smaller pane is used, in either order.
    const near = division(150, 0, 10, 1000);
    const balanced = division(420, 0, 10, 1000);
    const forward = shell({ bounds: { height: 1000, width: 1000 }, regions: [near, balanced] });
    const backward = shell({ bounds: { height: 1000, width: 1000 }, regions: [balanced, near] });
    // The list sits between the two folds and the conversation after the second;
    // nothing crosses either, and the sliver before the first is left empty.
    expect(forward.sidebar).toEqual({ gap: 10, mode: "column", width: 260 });
    expect(forward.sidebarRect).toEqual({ height: 1000, width: 260, x: 160, y: 0 });
    expect(forward.content).toEqual({ height: 1000, width: 570, x: 430, y: 0 });
    expect(backward).toEqual(forward);
  });

  it("keeps a drawer rather than putting the list or the conversation across a fold that does not fit them", () => {
    // The leading side is too narrow for a list.
    expect(
      shell({ bounds: { height: 1000, width: 1000 }, regions: [division(200, 0, 10, 1000)] })
        .sidebar,
    ).toEqual(drawer);
    // The trailing side is too narrow for a conversation.
    expect(
      shell({ bounds: { height: 1000, width: 900 }, regions: [division(560, 0, 10, 1000)] })
        .sidebar,
    ).toEqual(drawer);
  });

  it("ignores regions outside the surface and treats a short division as an obstruction, not a fold", () => {
    const outside = division(1200, 0, 20, 1000);
    expect(shell({ bounds: { height: 1133, width: 744 }, regions: [outside] }).sidebar).toEqual({
      gap: 0,
      mode: "column",
      width: 320,
    });
    // A division only 100 points tall is not a split of the surface.
    const island = division(360, 0, 40, 100);
    const result = shell({ bounds: { height: 1133, width: 744 }, regions: [island] });
    expect(result.sidebar).toEqual({ gap: 0, mode: "column", width: 320 });
    // It sits over the content column's top edge, so that edge is cleared.
    expect(result.contentClearance.top).toBe(100);
  });

  it("keeps one column for larger text rather than squeezing two", () => {
    expect(shell({ bounds: { height: 1133, width: 744 }, fontScale: 1.6 }).sidebar).toEqual(drawer);
  });

  it("does not flip back and forth for a width hovering on its threshold", () => {
    // 320 + 360 is the least room for both; entering needs 32 more.
    expect(shell({ bounds: { height: 1000, width: 700 } }).sidebar).toEqual(drawer);
    const column: SidebarArrangement = { gap: 0, mode: "column", width: 320 };
    expect(shell({ bounds: { height: 1000, width: 712 } }).sidebar).toEqual(column);
    expect(shell({ bounds: { height: 1000, width: 700 }, previous: column }).sidebar).toEqual(
      column,
    );
    expect(shell({ bounds: { height: 1000, width: 679 }, previous: column }).sidebar).toEqual(
      drawer,
    );
  });

  it("lets watching a page take the room, so a normal display shows two panes, not three", () => {
    expect(shell({ bounds: { height: 1133, width: 744 }, watching: true }).sidebar).toEqual(drawer);
    expect(shell({ bounds: { height: 744, width: 1133 }, watching: true }).sidebar).toEqual(drawer);
  });

  it("never overrides the reader's choice to hide it", () => {
    expect(shell({ bounds: { height: 1133, width: 744 }, shown: false }).sidebar).toEqual(drawer);
  });

  it("puts the column on the leading side of a fold in right-to-left", () => {
    // Physical frames: the fold is at x 600; right-to-left leads from the right.
    const fold = division(600, 0, 20, 1000);
    expect(
      shell({ bounds: { height: 1000, width: 1000 }, regions: [fold], rtl: true }).sidebar,
    ).toEqual({ gap: 20, mode: "column", width: 380 });
  });

  it("clears an interior occlusion from the pane it covers, by its nearest edge", () => {
    // A camera island inside the content column, near its trailing edge.
    const camera = occlusion(900, 400, 40, 40);
    const result = shell({ bounds: { height: 1000, width: 1000 }, regions: [camera] });
    expect(result.sidebar).toEqual({ gap: 0, mode: "column", width: 320 });
    expect(result.contentClearance).toEqual({ bottom: 0, left: 0, right: 100, top: 0 });
    expect(result.sidebarClearance).toEqual({ bottom: 0, left: 0, right: 0, top: 0 });
  });

  it("returns the previous arrangement for an unusable measurement", () => {
    const column: SidebarArrangement = { gap: 0, mode: "column", width: 320 };
    expect(shell({ bounds: { height: 0, width: 0 }, previous: column }).sidebar).toEqual(column);
    expect(shell({ bounds: { height: Number.NaN, width: 900 } }).sidebar).toEqual(drawer);
  });
});

describe("a page beside its conversation", () => {
  it("stays stacked until measured", () => {
    expect(pair({ bounds: { height: 1000, width: 1000 }, ready: false })).toEqual({
      mode: "stacked",
    });
  });

  it("goes side by side when a measured surface has room for both, with the page leading", () => {
    expect(pair({ bounds: { height: 1000, width: 744 } })).toEqual({
      gap: 0,
      mode: "side",
      pageWidth: 384,
    });
    expect(pair({ bounds: { height: 760, width: 390 } })).toEqual({ mode: "stacked" });
  });

  it("aligns the two panes to a vertical fold, in either direction", () => {
    const fold = division(480, 0, 20, 900);
    expect(pair({ bounds: { height: 900, width: 1000 }, regions: [fold] })).toEqual({
      gap: 20,
      mode: "side",
      pageWidth: 480,
    });
    expect(pair({ bounds: { height: 900, width: 1000 }, regions: [fold], rtl: true })).toEqual({
      gap: 20,
      mode: "side",
      pageWidth: 500,
    });
  });

  it("shows tabletop only when a horizontal fold leaves both halves useful", () => {
    const fold = division(0, 420, 900, 20);
    expect(pair({ bounds: { height: 900, width: 900 }, regions: [fold] })).toEqual({
      gap: 20,
      mode: "tabletop",
      pageHeight: 420,
    });
    // Too little conversation below the fold for its composer and some of the transcript.
    const low = division(0, 700, 900, 20);
    expect(pair({ bounds: { height: 900, width: 900 }, regions: [low] })).not.toMatchObject({
      mode: "tabletop",
    });
  });

  it("keeps a single column for larger text", () => {
    expect(pair({ bounds: { height: 1000, width: 744 }, fontScale: 1.6 })).toEqual({
      mode: "stacked",
    });
  });

  it("holds side by side across a small resize at its threshold", () => {
    const side = pair({ bounds: { height: 1000, width: 712 } });
    expect(side.mode).toBe("side");
    expect(pair({ bounds: { height: 1000, width: 700 } })).toEqual({ mode: "stacked" });
    expect(pair({ bounds: { height: 1000, width: 700 }, previous: side }).mode).toBe("side");
  });
});

describe("occlusion clearance", () => {
  it("clears each occlusion by the shortest way out of the pane, and ignores one elsewhere", () => {
    const pane = { height: 600, width: 400, x: 100, y: 0 };
    expect(
      occlusionClearance(pane, [
        { height: 30, width: 60, x: 270, y: 0 },
        { height: 50, width: 50, x: 0, y: 300 },
      ]),
    ).toEqual({ bottom: 0, left: 0, right: 0, top: 30 });
    expect(occlusionClearance(pane, [{ height: 40, width: 40, x: 460, y: 280 }])).toEqual({
      bottom: 0,
      left: 0,
      right: 40,
      top: 0,
    });
  });
});

describe("every reserved division, whichever arrangement is chosen", () => {
  const surface = { height: 900, width: 720 };
  const hinge = division(350, 0, 20, 900, true);

  it("keeps a single pane to one side of a fold it is not split at", () => {
    // Too narrow for two panes beside this fold: the conversation takes one side whole.
    const result = shell({ bounds: surface, regions: [hinge] });
    expect(result.sidebar).toEqual(drawer);
    expect(result.content).toEqual({ height: 900, width: 350, x: 0, y: 0 });
    expect(arrange({ bounds: surface, regions: [hinge] })).toEqual({
      pair: { mode: "stacked" },
      region: { height: 900, width: 350, x: 0, y: 0 },
    });
  });

  it("honours the fold with the sidebar hidden, on the larger side", () => {
    const fold = division(470, 0, 24, 1000);
    const result = shell({ bounds: { height: 1000, width: 1000 }, regions: [fold], shown: false });
    expect(result.sidebar).toEqual(drawer);
    expect(result.content).toEqual({ height: 1000, width: 506, x: 494, y: 0 });
  });

  it("honours the fold for text too large for two columns", () => {
    const fold = division(470, 0, 24, 1000);
    const result = shell({ bounds: { height: 1000, width: 1000 }, fontScale: 3, regions: [fold] });
    expect(result.sidebar).toEqual(drawer);
    expect(result.content).toEqual({ height: 1000, width: 506, x: 494, y: 0 });
  });

  it("keeps the sidebar and the conversation off a horizontal fold they are not split at", () => {
    const fold = division(0, 400, 1000, 20);
    const result = shell({ bounds: { height: 1000, width: 1000 }, regions: [fold] });
    expect(result.sidebarRect).toEqual({ height: 580, width: 320, x: 0, y: 420 });
    expect(result.content).toEqual({ height: 580, width: 680, x: 320, y: 420 });
  });

  it("keeps a right-to-left single pane off the fold too", () => {
    const fold = division(600, 0, 20, 1000);
    const result = shell({
      bounds: { height: 1000, width: 1000 },
      regions: [fold],
      rtl: true,
      shown: false,
    });
    expect(result.content).toEqual({ height: 1000, width: 600, x: 0, y: 0 });
  });

  it("keeps side-by-side panes off a horizontal fold too short for tabletop", () => {
    const low = division(0, 700, 900, 20);
    expect(arrange({ bounds: { height: 900, width: 900 }, regions: [low] })).toEqual({
      pair: { gap: 0, mode: "side", pageWidth: 540 },
      region: { height: 700, width: 900, x: 0, y: 0 },
    });
  });

  it("keeps tabletop to one side of a vertical fold it is not split at", () => {
    const vertical = division(480, 0, 20, 900);
    const horizontal = division(0, 420, 1000, 20);
    expect(
      arrange({ bounds: { height: 900, width: 1000 }, regions: [vertical, horizontal] }),
    ).toEqual({
      pair: { gap: 20, mode: "tabletop", pageHeight: 420 },
      region: { height: 900, width: 500, x: 500, y: 0 },
    });
  });
});

describe("fit, judged on the room a pane can use", () => {
  it("does not dock beside a conversation that the safe area would leave too narrow", () => {
    const bounds = { height: 900, width: 712 };
    expect(shell({ bounds }).sidebar.mode).toBe("column");
    // A trailing inset of 80 leaves 312 of the 392 the conversation needs to enter.
    expect(shell({ bounds, insets: { ...noInsets, right: 80 } }).sidebar).toEqual(drawer);
    expect(
      pair({ bounds: { height: 1000, width: 712 }, insets: { ...noInsets, right: 80 } }),
    ).toEqual({ mode: "stacked" });
  });

  it("follows the reader's text size all the way up", () => {
    const landscape = { height: 744, width: 1133 };
    expect(shell({ bounds: landscape, fontScale: 2 }).sidebar.mode).toBe("column");
    expect(shell({ bounds: landscape, fontScale: 3 }).sidebar).toEqual(drawer);
  });
});

/*
 * The shell and the page pair are nested surfaces: the pair's provider reports
 * the same physical folds in its own coordinates, offset by where the shell put
 * the stack and not clipped. What can go wrong: the shell keeps the stack off a
 * fold the page pair was going to use, so the pair never sees it and cannot
 * arrange tabletop or side by side at it.
 */
describe("the shell and the page pair together", () => {
  /** Regions as a nested provider at `origin` reports them: its own coordinates, unclipped. */
  const seenFrom = (
    origin: { readonly x: number; readonly y: number },
    regions: ReservedRegion[],
  ) =>
    regions.map((region) => ({
      ...region,
      frame: { ...region.frame, x: region.frame.x - origin.x, y: region.frame.y - origin.y },
    }));

  function watch(bounds: { height: number; width: number }, regions: ReservedRegion[]) {
    const outer = shell({ bounds, regions, watching: true });
    const inner = arrange({
      bounds: { height: outer.content.height, width: outer.content.width },
      regions: seenFrom(outer.content, regions),
    });
    return { inner, outer };
  }

  it("lets a watched page use a horizontal fold for tabletop", () => {
    const { inner, outer } = watch({ height: 900, width: 900 }, [division(0, 420, 900, 20)]);
    expect(outer.sidebar).toEqual(drawer);
    expect(outer.content).toEqual({ height: 900, width: 900, x: 0, y: 0 });
    expect(inner).toEqual({
      pair: { gap: 20, mode: "tabletop", pageHeight: 420 },
      region: { height: 900, width: 900, x: 0, y: 0 },
    });
  });

  it("lets a watched page and its conversation sit either side of a vertical fold", () => {
    const { inner, outer } = watch({ height: 900, width: 1000 }, [division(480, 0, 20, 900)]);
    expect(outer.content).toEqual({ height: 900, width: 1000, x: 0, y: 0 });
    expect(inner).toEqual({
      pair: { gap: 20, mode: "side", pageWidth: 480 },
      region: { height: 900, width: 1000, x: 0, y: 0 },
    });
  });

  it("still keeps the pair off a fold it cannot use, on the larger side", () => {
    const hinge = division(350, 0, 20, 900, true);
    const { inner } = watch({ height: 900, width: 720 }, [hinge]);
    expect(inner).toEqual({
      pair: { mode: "stacked" },
      region: { height: 900, width: 350, x: 0, y: 0 },
    });
  });

  it("keeps a screen with nothing to arrange off the fold, as before", () => {
    const result = shell({
      bounds: { height: 900, width: 900 },
      regions: [division(0, 420, 900, 20)],
    });
    expect(result.content).toEqual({ height: 460, width: 900, x: 0, y: 440 });
  });
});
