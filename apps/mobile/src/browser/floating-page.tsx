import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type HostInstance,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useEvent,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { PhoneBrowserPageScroll } from "../../modules/phone-browser/types.js";
import { barShown, nextBar, type BarScroll } from "./floating-bar.js";
import { shrunkTravel, ToolbarShrinkProvider, type ToolbarShrink } from "./toolbar.js";

/**
 * What the page's own view on this phone is told by the bar around it: which edges its
 * controls float over, and where its scroll goes while its bar shrinks.
 */
export interface PageChrome {
  readonly barInsets: { readonly top: number; readonly bottom: number } | null;
  readonly onPageScroll: ReturnType<typeof usePageScrollHandler> | null;
}

const PageChromeContext = createContext<PageChrome | null>(null);
export const PageChromeProvider = PageChromeContext.Provider;
export function usePageChrome(): PageChrome | null {
  return useContext(PageChromeContext);
}

function usePageScrollHandler(
  bar: SharedValue<BarScroll>,
  progress: SharedValue<number>,
  onShrunk: (shrunk: boolean) => void,
  instant: boolean,
) {
  return useEvent<NativeSyntheticEvent<PhoneBrowserPageScroll>>(
    (event) => {
      "worklet";
      const previous = bar.value;
      const next = nextBar(previous, event);
      if (next === previous) return;
      bar.value = next;
      if (next.shrunk === previous.shrunk) return;
      progress.value = withTiming(next.shrunk ? 1 : 0, {
        duration: instant ? 0 : 260,
        easing: Easing.out(Easing.cubic),
      });
      scheduleOnRN(onShrunk, next.shrunk);
    },
    ["onPageScroll"],
  );
}

/** Whether the bar is shrunk, as React sees it: for touches and the screen reader alone. */
interface Shrunk {
  readonly get: () => boolean;
  readonly set: (shrunk: boolean) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function shrunkStore(): Shrunk {
  let shrunk = false;
  const listeners = new Set<() => void>();
  return {
    get: () => shrunk,
    set: (next) => {
      if (next === shrunk) return;
      shrunk = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface FloatingBar {
  readonly edge: "bottom" | "top";
  readonly progress: SharedValue<number>;
  readonly shrunk: Shrunk;
  readonly expand: () => void;
  readonly onBarWidth: (width: number) => void;
  readonly onPageScroll: ReturnType<typeof usePageScrollHandler>;
  readonly shrink: ToolbarShrink;
}

/**
 * The page's bar, shrinking as the person reads down and returning as they head back, decided
 * on the UI thread from the page's own scroll. React hears only each change, never each frame.
 * `held` keeps it whole: while the address is edited or the page asks something.
 */
export function useFloatingBar(edge: "bottom" | "top", held: boolean): FloatingBar {
  const progress = useSharedValue(0);
  const bar = useSharedValue<BarScroll>(barShown);
  const capsuleShift = useSharedValue(0);
  const [shrunk] = useState(shrunkStore);
  const reduceMotion = useReducedMotion();
  const onPageScroll = usePageScrollHandler(bar, progress, shrunk.set, reduceMotion);
  const expand = useCallback(() => {
    bar.value = { from: bar.value.from, shrunk: false };
    progress.value = withTiming(0, {
      duration: reduceMotion ? 0 : 260,
      easing: Easing.out(Easing.cubic),
    });
    shrunk.set(false);
  }, [bar, progress, reduceMotion, shrunk]);
  useEffect(() => {
    if (held) expand();
  }, [expand, held]);
  const barRef = useRef<HostInstance>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [capsule, setCapsule] = useState<{ readonly width: number; readonly x: number } | null>(
    null,
  );
  useEffect(() => {
    capsuleShift.value = capsule === null ? 0 : barWidth / 2 - (capsule.x + capsule.width / 2);
  }, [barWidth, capsule, capsuleShift]);
  const onCapsule = useCallback((next: { readonly width: number; readonly x: number }) => {
    setCapsule((current) =>
      current?.width === next.width && current.x === next.x ? current : next,
    );
  }, []);
  const shrink = useMemo(
    () => ({ bar: barRef, capsuleShift, edge, onCapsule, progress }),
    [capsuleShift, edge, onCapsule, progress],
  );
  return { edge, expand, onBarWidth: setBarWidth, onPageScroll, progress, shrink, shrunk };
}

/**
 * The page's controls over one edge of a page on this phone: what stands on the bar (the status
 * row and a call's dock) and, where it floats, the bar itself. It reports its whole height, so
 * the page lays out clear of it once and keeps its size as the bar shrinks and returns.
 */
export function PageEdge(props: {
  readonly edge: "bottom" | "top";
  /** The bar, where it floats here; null where it stands elsewhere. */
  readonly bar: ReactNode;
  /** What stands on the bar's inner side: it follows the bar as it shrinks. */
  readonly lead?: ReactNode;
  readonly floating: FloatingBar | null;
  /** The site, said by the shrunk bar, which brings the bar back when tapped. */
  readonly label: string;
  readonly onHeight: (height: number) => void;
  /** The screen's edge beyond the page, which the bar keeps clear of. */
  readonly outset: number;
}): ReactNode {
  const { floating, onHeight } = props;
  const bottom = props.edge === "bottom";
  const toward = bottom ? 1 : -1;
  const progress = floating?.progress;
  const follow = useAnimatedStyle(() => ({
    transform: [
      { translateY: progress === undefined ? 0 : toward * shrunkTravel * progress.value },
    ],
  }));
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => onHeight(event.nativeEvent.layout.height),
    [onHeight],
  );
  const shrunk = useSyncExternalStore(
    floating?.shrunk.subscribe ?? never,
    floating?.shrunk.get ?? whole,
    whole,
  );
  const bar =
    props.bar === null ? null : (
      <View
        ref={floating?.shrink.bar}
        onLayout={
          floating === null
            ? undefined
            : (event: LayoutChangeEvent) => floating.onBarWidth(event.nativeEvent.layout.width)
        }
      >
        <View
          accessibilityElementsHidden={shrunk}
          importantForAccessibility={shrunk ? "no-hide-descendants" : "auto"}
          pointerEvents={shrunk ? "none" : "box-none"}
        >
          {floating === null ? (
            props.bar
          ) : (
            <ToolbarShrinkProvider value={floating.shrink}>{props.bar}</ToolbarShrinkProvider>
          )}
        </View>
        {shrunk ? (
          <Pressable
            accessibilityHint="Shows the page’s controls"
            accessibilityLabel={props.label}
            accessibilityRole="button"
            onPress={floating?.expand}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
      </View>
    );
  return (
    <View
      onLayout={onLayout}
      pointerEvents="box-none"
      style={[
        styles.edge,
        bottom ? { bottom: 0, paddingBottom: props.outset } : { paddingTop: props.outset, top: 0 },
      ]}
    >
      {bottom && props.lead ? (
        <Animated.View pointerEvents="box-none" style={follow}>
          {props.lead}
        </Animated.View>
      ) : null}
      {bar}
    </View>
  );
}

const never = () => () => undefined;
const whole = () => false;

const styles = StyleSheet.create({
  edge: { end: 0, position: "absolute", start: 0 },
});
