import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type ScrollViewInstance,
  type ScrollViewProps,
} from "react-native";
import {
  KeyboardChatScrollView,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { space } from "../theme.js";
import { move } from "../ui/motion.js";
import { useContentInsets } from "../ui/pane.js";
import { useReadingColumn } from "../ui/screen.js";

/** The resting bar and the air above it, until the dock has measured itself. */
const firstGuess = 56;

interface DockKeyboard {
  /** False where a parent already keeps the pane clear of the keyboard. */
  readonly follow: boolean;
  /** The bottom inset the dock gives up while the keyboard covers it. */
  readonly settle: number;
}

const DockKeyboardContext = createContext<DockKeyboard>({ follow: false, settle: 0 });

/**
 * A pane whose scrolling content runs to its bottom edge, with the composer
 * and everything docked into it floating over the foot of that content.
 *
 * The scrolling content is handed `clearance`: how much of the pane's foot the
 * dock covers, so its last line can scroll clear of the glass while the lines
 * before it pass under it. The dock keeps clear of the home indicator, the
 * navigation bar and whatever the surface reserved at the bottom.
 *
 * The keyboard moves the dock and nothing else lays out again: the dock rides
 * the keyboard's own frames on the UI thread, swipe-to-dismiss included, and
 * content scrolled in a `DockScrollView` gains the same room as an inset. The
 * pane must reach the window's bottom edge, as every screen that docks does.
 *
 * `avoidKeyboard` is false where a parent already keeps this pane clear of
 * the keyboard: following it here too would lift the dock twice.
 */
export function ComposerDockLayout(props: {
  readonly avoidKeyboard: boolean;
  readonly children: (clearance: number) => ReactNode;
  /** The notices, requests, queued words and composer standing over the content. */
  readonly dock: ReactNode;
}): ReactNode {
  const insets = useContentInsets();
  const column = useReadingColumn();
  const [height, setHeight] = useState(firstGuess);
  const measure = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    setHeight((current) => (current === next ? current : next));
  }, []);
  const bottom = Math.max(insets.bottom, space[8]);
  const clearance = height + bottom;
  const keyboard = useMemo(
    () => ({ follow: props.avoidKeyboard, settle: bottom - space[8] }),
    [bottom, props.avoidKeyboard],
  );
  return (
    <DockKeyboardContext value={keyboard}>
      <View style={styles.fill}>
        {props.children(clearance)}
        <OverDock>
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
        </OverDock>
      </View>
    </DockKeyboardContext>
  );
}

/**
 * A layer over the whole pane that moves with the dock as the keyboard comes
 * and goes, for what floats just above the dock, such as a jump-to-latest pill.
 */
export function OverDock(props: { readonly children: ReactNode }): ReactNode {
  const { follow, settle } = use(DockKeyboardContext);
  const { height, progress } = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({
    transform: [{ translateY: (follow ? height.value : 0) + progress.value * settle }],
  }));
  return (
    <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, lift]}>
      {props.children}
    </Animated.View>
  );
}

/**
 * The scroll view for content under the dock. While the keyboard is up it adds
 * the keyboard's height as an inset and lifts the content with the dock, in the
 * same frames. FlatList takes it through `renderScrollComponent`.
 */
export function DockScrollView(
  props: ScrollViewProps & {
    readonly inverted?: boolean;
    /** The insets, keyboard included, for code that scrolls to the end itself. */
    readonly onContentInsetChange?: (insets: {
      readonly bottom: number;
      readonly top: number;
    }) => void;
    readonly ref?: Ref<ScrollViewInstance>;
  },
): ReactNode {
  const { follow, settle } = use(DockKeyboardContext);
  if (!follow) {
    const { inverted: _inverted, onContentInsetChange: _onInset, ...rest } = props;
    return <ScrollView {...rest} />;
  }
  return <KeyboardChatScrollView {...props} offset={settle} />;
}

const styles = StyleSheet.create({
  dock: { alignItems: "center", bottom: 0, left: 0, position: "absolute", right: 0 },
  fill: { flex: 1 },
  stack: { gap: space[8], paddingTop: space[8] },
});
