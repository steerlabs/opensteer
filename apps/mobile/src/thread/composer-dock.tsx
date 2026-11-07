import { useCallback, useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated from "react-native-reanimated";
import { space } from "../theme.js";
import { useKeyboardVisible } from "../ui/keyboard.js";
import { move } from "../ui/motion.js";
import { useContentInsets } from "../ui/pane.js";
import { useReadingColumn } from "../ui/screen.js";

/** The resting bar and the air above it, until the dock has measured itself. */
const firstGuess = 56;

/**
 * A pane whose scrolling content runs to its bottom edge, with the composer
 * and everything docked into it floating over the foot of that content.
 *
 * The scrolling content is handed `clearance`: how much of the pane's foot the
 * dock covers, so its last line can scroll clear of the glass while the lines
 * before it pass under it. The dock keeps clear of the home indicator, the
 * navigation bar and whatever the surface reserved at the bottom, and sits
 * just above the keyboard while it is up.
 *
 * `avoidKeyboard` is false where a parent already keeps this pane clear of
 * the keyboard: two avoiding views lift the dock twice.
 */
export function ComposerDockLayout(props: {
  readonly avoidKeyboard: boolean;
  readonly children: (clearance: number) => ReactNode;
  /** The notices, requests, queued words and composer standing over the content. */
  readonly dock: ReactNode;
  readonly keyboardVerticalOffset?: number;
}): ReactNode {
  const insets = useContentInsets();
  const column = useReadingColumn();
  const keyboardVisible = useKeyboardVisible();
  const [height, setHeight] = useState(firstGuess);
  const measure = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    setHeight((current) => (current === next ? current : next));
  }, []);
  // Measured without the bottom spacing and added back here, so the content's
  // clearance changes in the same frame as the dock when the keyboard moves.
  const bottom = keyboardVisible ? space[8] : Math.max(insets.bottom, space[8]);
  const clearance = height + bottom;
  const content = (
    <View style={styles.fill}>
      {props.children(clearance)}
      <Animated.View layout={move} pointerEvents="box-none" style={styles.dock}>
        <View
          pointerEvents="box-none"
          style={[
            column,
            {
              paddingBottom: bottom,
              // Tighter than the content's gutter: the bar floats over the page
              // rather than sitting in its column, and a floating thing that
              // lines up with the text under it reads as part of it.
              paddingLeft: space[8] + insets.left,
              paddingRight: space[8] + insets.right,
            },
          ]}
          testID="composer-dock"
        >
          <View
            onLayout={measure}
            pointerEvents="box-none"
            style={styles.stack}
            testID="composer-dock-stack"
          >
            {props.dock}
          </View>
        </View>
      </Animated.View>
    </View>
  );
  if (!props.avoidKeyboard) return content;
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={props.keyboardVerticalOffset ?? 0}
      style={styles.fill}
    >
      {content}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  dock: { alignItems: "center", bottom: 0, left: 0, position: "absolute", right: 0 },
  fill: { flex: 1 },
  stack: { gap: space[8], paddingTop: space[8] },
});
