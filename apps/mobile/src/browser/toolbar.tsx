import { createContext, memo, useContext, useRef, type ReactNode, type RefObject } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type HostInstance,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuSection } from "../thread/composer-menu.js";
import { GlassSurface } from "../ui/glass.js";
import { AppText } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";

/**
 * A bar floating over a page on this phone, shrunk by `progress` (0 to 1) as the page is read:
 * the round controls fade away and the capsule draws in to a small pill at the bar's middle,
 * toward the screen's edge, as Safari's does.
 */
export interface ToolbarShrink {
  readonly edge: "bottom" | "top";
  readonly progress: SharedValue<number>;
  /** The bar, which the capsule measures itself against. */
  readonly bar: RefObject<HostInstance | null>;
  /** How far the capsule's middle is from the bar's, measured as it is laid out. */
  readonly capsuleShift: SharedValue<number>;
  readonly onCapsule: (capsule: { readonly width: number; readonly x: number }) => void;
}

const ToolbarShrinkContext = createContext<ToolbarShrink | null>(null);
export const ToolbarShrinkProvider = ToolbarShrinkContext.Provider;
export function useToolbarShrink(): ToolbarShrink | null {
  return useContext(ToolbarShrinkContext);
}

/** The shrunk capsule's size against the full one, and how far it settles toward the edge. */
export const shrunkCapsule = { scale: 0.78, sink: 8 } as const;
/** How far the bar's inner edge moves as it shrinks, for what stands on it to follow. */
export const shrunkTravel = shrunkCapsule.sink + (touchTarget * (1 - shrunkCapsule.scale)) / 2;

/**
 * The one bar a page, Mac app or phone is used through, as Safari's and
 * Chrome's are: separate glass controls in one row, the widest of them the
 * place's own capsule. What is about the place is in that capsule; what is about
 * the app stands outside it. On a phone it sits under the page, where a thumb
 * reaches it; where the page has a regular width it sits over it, as Safari's
 * does on iPad.
 *
 * It never floats over a streamed page, which cannot leave room for chrome it
 * does not know about: anything drawn over it would hide the page's own sticky
 * header or pinned button out of reach. A page on this phone can, so there it
 * floats and shrinks (`ToolbarShrink`).
 */
export function Toolbar(props: {
  readonly children: ReactNode;
  readonly edge: "bottom" | "top";
  readonly testID?: string;
}): ReactNode {
  return (
    <View
      style={[styles.bar, props.edge === "top" ? styles.top : styles.bottom]}
      testID={props.testID}
    >
      {props.children}
    </View>
  );
}

/**
 * One round glass control in a toolbar: a symbol, or a count drawn as a
 * browser's tab button draws how many tabs are open.
 */
export const ToolbarButton = memo(function ToolbarButton(props: {
  readonly accessibilityHint?: string;
  readonly count?: number;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly selected?: boolean;
  readonly symbol?: SFSymbolName;
}): ReactNode {
  const disabled = props.disabled === true;
  const tint = disabled ? color.mutedDim : props.selected === true ? color.inkOnEmber : color.text;
  return (
    <Pressable
      accessibilityHint={props.accessibilityHint}
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{
        disabled,
        ...(props.selected === undefined ? {} : { selected: props.selected }),
      }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [styles.slot, pressed && styles.pressed]}
    >
      <ToolbarRound selected={props.selected === true}>
        {props.count === undefined ? (
          props.symbol === undefined ? null : (
            <Symbol name={props.symbol} size={19} tint={tint} weight="medium" />
          )
        ) : (
          <View style={[styles.count, { borderColor: tint }]}>
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              style={[styles.countText, { color: tint }]}
            >
              {props.count > 99 ? "∞" : String(props.count)}
            </AppText>
          </View>
        )}
      </ToolbarRound>
    </Pressable>
  );
});

/** A round glass control whose choices the system draws as a menu. */
export function ToolbarMenu(props: {
  readonly accessibilityHint?: string;
  /** What the control shows, where a symbol does not say enough. */
  readonly face?: ReactNode;
  readonly label: string;
  readonly sections: readonly NativeMenuSection[];
  readonly symbol?: SFSymbolName;
  readonly title?: string;
}): ReactNode {
  return (
    <NativeMenu
      {...(props.accessibilityHint === undefined
        ? {}
        : { accessibilityHint: props.accessibilityHint })}
      accessibilityLabel={props.label}
      onPresent={noop}
      onSettle={noop}
      options={props.sections}
      style={styles.slot}
      {...(props.title === undefined ? {} : { title: props.title })}
    >
      <ToolbarRound>
        {props.face}
        {props.symbol === undefined ? null : (
          <Symbol name={props.symbol} size={19} tint={color.text} weight="medium" />
        )}
      </ToolbarRound>
    </NativeMenu>
  );
}

function ToolbarRound(props: {
  readonly children: ReactNode;
  readonly selected?: boolean;
}): ReactNode {
  const shrink = useToolbarShrink();
  const round = (
    <GlassSurface
      interactive
      shape="capsule"
      style={styles.round}
      {...(props.selected === true
        ? { tint: color.ember }
        : shrink === null
          ? {}
          : { tint: color.floatTint })}
    >
      {props.children}
    </GlassSurface>
  );
  return shrink === null ? round : <ShrinkingRound shrink={shrink}>{round}</ShrinkingRound>;
}

function ShrinkingRound(props: {
  readonly children: ReactNode;
  readonly shrink: ToolbarShrink;
}): ReactNode {
  const { edge, progress } = props.shrink;
  const toward = edge === "bottom" ? 1 : -1;
  const style = useAnimatedStyle(() => ({
    opacity: Math.max(0, 1 - progress.value * 1.6),
    transform: [
      { translateY: toward * shrunkCapsule.sink * progress.value },
      { scale: 1 - 0.4 * progress.value },
    ],
  }));
  return <Animated.View style={style}>{props.children}</Animated.View>;
}

/**
 * The toolbar's widest control: the place itself, as Safari's address field
 * is. It takes whatever the round controls leave.
 */
export function ToolbarCapsule(props: {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}): ReactNode {
  const shrink = useToolbarShrink();
  const capsule = (
    <GlassSurface
      interactive
      shape="capsule"
      style={[styles.capsule, props.style]}
      {...(shrink === null ? {} : { tint: color.floatTint })}
    >
      {props.children}
    </GlassSurface>
  );
  return shrink === null ? capsule : <ShrinkingCapsule shrink={shrink}>{capsule}</ShrinkingCapsule>;
}

function ShrinkingCapsule(props: {
  readonly children: ReactNode;
  readonly shrink: ToolbarShrink;
}): ReactNode {
  const { bar, capsuleShift, edge, onCapsule, progress } = props.shrink;
  const toward = edge === "bottom" ? 1 : -1;
  const measured = useRef<HostInstance>(null);
  const measure = () => {
    const base = bar.current;
    if (base !== null)
      measured.current?.measureLayout(base, (x: number, _y: number, width: number) =>
        onCapsule({ width, x }),
      );
  };
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: capsuleShift.value * progress.value },
      { translateY: toward * shrunkCapsule.sink * progress.value },
      { scale: 1 - (1 - shrunkCapsule.scale) * progress.value },
    ],
  }));
  return (
    <Animated.View style={[styles.shrinking, style]}>
      <View onLayout={measure} ref={measured} style={styles.shrinking}>
        {props.children}
      </View>
    </Animated.View>
  );
}

function noop(): void {}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    paddingHorizontal: space[12],
  },
  bottom: { paddingBottom: space[4], paddingTop: space[8] },
  // Chrome's tab button: the number of tabs in a rounded square.
  count: {
    alignItems: "center",
    borderRadius: radius.xs,
    borderWidth: 1.75,
    height: 21,
    justifyContent: "center",
    minWidth: 21,
    paddingHorizontal: 3,
  },
  countText: { fontSize: 12, fontWeight: "700", lineHeight: 15 },
  capsule: {
    alignItems: "center",
    flexDirection: "row",
    height: touchTarget,
    overflow: "hidden",
  },
  pressed: { opacity: 0.7 },
  round: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  shrinking: { flex: 1, minWidth: 0 },
  slot: { flexShrink: 0 },
  top: { paddingBottom: space[8], paddingTop: space[4] },
});
