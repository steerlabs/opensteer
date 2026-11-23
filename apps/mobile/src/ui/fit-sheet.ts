import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * The tallest a sheet that fits its contents (`sheetAllowedDetents: "fitToContents"`) lets itself
 * grow: what the sheet actually has, the frame the platform gives its content less the insets it
 * reports there, so what it holds scrolls inside it in either orientation. Inside a form sheet
 * that frame is the sheet's and its top inset is zero (the sheet already stands below the status
 * bar); on Android the system bars come off it.
 */
export function useFitSheetHeight(): number {
  const frame = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  return Math.max(0, frame.height - insets.top - insets.bottom);
}
