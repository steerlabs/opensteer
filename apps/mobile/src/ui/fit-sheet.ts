import { useWindowDimensions } from "react-native";

/**
 * The tallest a sheet that fits its contents (`sheetAllowedDetents: "fitToContents"`) lets itself
 * grow: a share of the window, so it stops short of the screen's top and what it holds scrolls
 * inside it. It is never worked out from safe-area insets: inside a form sheet the top inset is
 * zero, and the sheet itself already stands below the status bar, so the window less an inset is
 * taller than the sheet can be.
 */
export const fitSheetShare = 0.85;

export function useFitSheetHeight(): number {
  return useWindowDimensions().height * fitSheetShare;
}
