import { getDefaultHeaderHeight, HeaderHeightContext } from "@react-navigation/elements";
import { useIsFocused } from "@react-navigation/native";
import { useAnimatedHeaderHeight } from "@react-navigation/native-stack";
import { useContext, useEffect, useRef, type ReactNode } from "react";
import { Platform, useWindowDimensions } from "react-native";
import { makeMutable } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { space } from "../theme.js";
import { pillHeight } from "./pill-metrics.js";

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
 * empty between its buttons while the title is large; once the title
 * collapses into that row on scroll, the pill drops below the bar instead.
 */
export function PublishHeaderClearance(props: { readonly largeTitle: boolean }): ReactNode {
  const height = useContext(HeaderHeightContext);
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const frame = useWindowDimensions();
  const largeTitle = props.largeTitle && Platform.OS === "ios";
  const bar = getDefaultHeaderHeight(frame, false, insets.top) - insets.top;
  const known = height !== undefined && height !== 0;
  const below = { inset: space[24], top: known ? height + space[8] : 0 };
  useEffect(() => {
    if (focused && !(largeTitle && known)) pillPlacement.value = below;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, largeTitle, known, below.top]);
  if (!largeTitle || !known) return null;
  return (
    <FollowLargeTitle
      collapsedBar={insets.top + bar}
      focused={focused}
      inRow={{ inset: barButtonClearance, top: insets.top + Math.max(0, (bar - pillHeight) / 2) }}
    />
  );
}

type Placement = { readonly inset: number; readonly top: number };

/** How far past the collapsed bar the header may still reach and count as collapsed. */
const collapsedSlack = 12;

/**
 * Follows a large title as it collapses: the bar's row while the title is
 * large, below the collapsed bar once its small title shows there. It keeps
 * listening while another screen is on top, so a return to a screen left
 * collapsed places the pill from how its header stands, before any scroll.
 */
function FollowLargeTitle(props: {
  readonly collapsedBar: number;
  readonly focused: boolean;
  readonly inRow: Placement;
}): null {
  const live = useAnimatedHeaderHeight();
  // A screen first shows its title large.
  const header = useRef(Number.POSITIVE_INFINITY);
  const { collapsedBar, focused, inRow } = props;
  useEffect(() => {
    const place = (value: number) => {
      header.current = value;
      if (!focused) return;
      const next =
        value <= collapsedBar + collapsedSlack
          ? { inset: space[24], top: collapsedBar + space[8] }
          : inRow;
      const shown = pillPlacement.value;
      if (shown.top !== next.top || shown.inset !== next.inset) pillPlacement.value = next;
    };
    place(header.current);
    const id = live.addListener(({ value }) => place(value));
    return () => live.removeListener(id);
  }, [collapsedBar, focused, inRow.inset, inRow.top, live]);
  return null;
}
