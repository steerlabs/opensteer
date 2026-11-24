// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

/*
 * The reader's re-check of 5ebc2cbbd: the tallest a fitted sheet lets itself grow read the frame of
 * the nearest safe-area provider, which inside a presented sheet is the sheet's own pane, sized to
 * what it holds: a growing sheet was held at its first height, and with the bottom inset taken off
 * again on each layout (its callers pad it inside) it could shrink. It is the window's, less where
 * the sheet stands below the status bar.
 */

const geometry = vi.hoisted(() => ({
  /** What the sheet's pane reports as its frame: its current height, the size of what it holds. */
  paneFrame: { height: 200, width: 390 },
  sheetInsets: { bottom: 34, left: 0, right: 0, top: 0 },
  window: { height: 844, width: 390 },
}));

vi.mock("react-native", () => ({
  // The type scale reads it; the tallest a sheet grows does not.
  Platform: {
    OS: "ios",
    select: (choices: Record<string, unknown>) => choices.ios ?? choices.default,
  },
  useWindowDimensions: () => ({ ...geometry.window, fontScale: 1, scale: 3 }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ ...geometry.paneFrame, x: 0, y: 0 }),
  useSafeAreaInsets: () => geometry.sheetInsets,
}));

const { SheetWindowTop, useFitSheetHeight } = await import("./fit-sheet.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function heightIn(tree: (probe: ReactNode) => ReactNode): number {
  let height = -1;
  function Probe() {
    height = useFitSheetHeight();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(tree(<Probe />)));
  act(() => root.unmount());
  return height;
}

describe("the tallest a fitted sheet grows", () => {
  it("is the window's, less the status bar and the sheet's gap, whatever its pane holds now", () => {
    const tallest = heightIn((probe) => (
      <SheetWindowTop.Provider value={59}>{probe}</SheetWindowTop.Provider>
    ));
    expect(tallest).toBe(844 - 59 - 10);
    // A pane that holds more now changes nothing: the sheet is not held at what it held.
    geometry.paneFrame = { height: 600, width: 390 };
    expect(
      heightIn((probe) => <SheetWindowTop.Provider value={59}>{probe}</SheetWindowTop.Provider>),
    ).toBe(tallest);
  });

  it("keeps the bottom inset for its callers, who pad it inside", () => {
    geometry.sheetInsets = { bottom: 48, left: 0, right: 0, top: 0 };
    expect(
      heightIn((probe) => <SheetWindowTop.Provider value={24}>{probe}</SheetWindowTop.Provider>),
    ).toBe(844 - 24 - 10);
  });
});
