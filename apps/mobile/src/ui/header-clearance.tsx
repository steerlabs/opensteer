import { getDefaultHeaderHeight, HeaderHeightContext } from "@react-navigation/elements";
import { useIsFocused } from "@react-navigation/native";
import { useContext, useEffect } from "react";
import { Platform, useWindowDimensions } from "react-native";
import { makeMutable } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { space } from "../theme.js";

/** The connection pill's height, which a bar row centres it in. */
export const pillHeight = 36;

/** Room a pill in a bar's row leaves for that bar's buttons on each side. */
const barButtonClearance = space[16] + 48 + space[8];

/**
 * Where chrome drawn outside the navigator (the connection pill) sits on the
 * focused screen, since it cannot measure that screen's header: its top, and
 * the side margin it keeps. A zero top is unknown: the screen has no header of
 * the navigator's. A shared value, so a focus change moves the pill without a
 * render.
 */
export const pillPlacement = makeMutable({ inset: space[24] as number, top: 0 });

/**
 * Rendered in each screen's layout: the focused screen says where the pill
 * goes. Under an ordinary bar it sits just below it. A large title's content
 * starts right under that title, so there the pill takes the bar's own row,
 * empty between its buttons while the title is large, and never covers a row.
 */
export function PublishHeaderClearance(props: { readonly largeTitle: boolean }): null {
  const height = useContext(HeaderHeightContext);
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const frame = useWindowDimensions();
  const largeTitle = props.largeTitle && Platform.OS === "ios";
  const bar = getDefaultHeaderHeight(frame, false, insets.top) - insets.top;
  const top =
    height === undefined || height === 0
      ? 0
      : largeTitle
        ? insets.top + Math.max(0, (bar - pillHeight) / 2)
        : height + space[8];
  const inset = largeTitle && top !== 0 ? barButtonClearance : space[24];
  useEffect(() => {
    if (focused) pillPlacement.value = { inset, top };
  }, [focused, inset, top]);
  return null;
}
