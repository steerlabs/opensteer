import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaFrame } from "react-native-safe-area-context";
import { deriveLayout, type Layout } from "../layout.js";
import { color } from "../theme.js";
import { useContentInsets } from "./pane.js";

/**
 * The ground every screen stands on: the product's near-black, the insets its
 * pane keeps clear, and the gutter its pane's width asks for.
 *
 * A screen either lets this component keep its content inside the insets,
 * or it reaches every edge itself. The second is for a screen whose content
 * scrolls: a list runs under the home indicator and pads its own end, and a
 * composer docks against the bottom edge and takes that inset once, where it
 * sits. Padding the bottom here as well would leave a dead band under both.
 */
export function Screen(props: {
  readonly children: ReactNode;
  /** Set when the screen reaches every edge and pads its own content. */
  readonly edgeToEdge?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}): ReactNode {
  const layout = useLayout();
  const insets = useContentInsets();
  return (
    <View
      style={[
        styles.screen,
        props.edgeToEdge === true
          ? null
          : {
              paddingBottom: insets.bottom,
              paddingLeft: layout.gutter + insets.left,
              paddingRight: layout.gutter + insets.right,
            },
        props.style,
      ]}
    >
      {props.children}
    </View>
  );
}

/** Side padding that matches `Screen`'s, for content inside an edge-to-edge list. */
export function useGutter(): number {
  return useLayout().gutter;
}

/**
 * The padding a scrolling list's content takes inside an edge-to-edge screen:
 * the gutter beside each side's own inset — a notch, the vertical bar or a
 * reserved region is on one side only — and the bottom inset plus a rest, so
 * the last row clears the home indicator by more than its own line.
 */
export function useListContentInsets(bottomRest: number): {
  readonly paddingBottom: number;
  readonly paddingLeft: number;
  readonly paddingRight: number;
} {
  const gutter = useGutter();
  const insets = useContentInsets();
  return {
    paddingBottom: insets.bottom + bottomRest,
    paddingLeft: gutter + insets.left,
    paddingRight: gutter + insets.right,
  };
}

/**
 * The measure a single column of content holds, centred in whatever it is
 * given. A tablet is wider than anything is worth reading across: a row that
 * spans 900 points puts its own two halves too far apart to be read as one row,
 * and prose that does is read twice or not at all.
 */
export function useReadingColumn(): ViewStyle {
  const { readingWidth } = useLayout();
  return { alignSelf: "center", maxWidth: readingWidth, width: "100%" };
}

/**
 * The layout this screen's pane asks for. The pane's own frame decides it, not
 * the window's: beside a docked sidebar, or beside a page, a screen has the
 * width it is drawn in.
 */
export function useLayout(): Layout {
  const { height, width } = useSafeAreaFrame();
  return deriveLayout(width, height);
}

const styles = StyleSheet.create({
  screen: { backgroundColor: color.background, flex: 1 },
});
