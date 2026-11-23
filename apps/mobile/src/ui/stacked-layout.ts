import { useWindowDimensions } from "react-native";
import { stackedFontScale } from "../theme.js";

/**
 * Whether rows stack at the reader's text size: from `stackedFontScale` up, a row's marks and
 * controls take a line of their own and its words the full width under them, so no word is
 * squeezed into a column narrower than itself and broken inside.
 */
export function useStackedLayout(): boolean {
  return useWindowDimensions().fontScale >= stackedFontScale;
}
