import { createContext, useContext } from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { space } from "../theme.js";

/**
 * The window's top safe inset, handed in from outside a presented sheet: inside it the safe area
 * is the sheet's own, whose top is zero.
 */
export const SheetWindowTop = createContext<number | null>(null);

/**
 * The tallest a sheet that fits its contents (`sheetAllowedDetents: "fitToContents"`) lets itself
 * grow: the window's height less where the sheet stands, below the status bar and a 10 pt gap
 * (iOS's large detent; an Android sheet stands as low or higher, and a limit set too high clips
 * its pinned controls, F31), so what it holds scrolls inside it in either orientation. It reads
 * the window, not the frame of the sheet's own pane, which is the size of what the sheet holds
 * now. The bottom inset stays in it: a sheet runs to the screen's foot, and its callers pad that
 * inset inside.
 */
export function useFitSheetHeight(): number {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const top = useContext(SheetWindowTop) ?? insets.top;
  return Math.max(0, window.height - top - space[10]);
}
