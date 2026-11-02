import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuSection } from "../thread/composer-menu.js";
import { GlassSurface } from "../ui/glass.js";
import { AppText } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";

/**
 * The bar a page, Mac app or phone is used through, as Safari's and Chrome's
 * are: separate glass controls in one row, the widest of them the place's own
 * capsule. On a phone it sits under the page, where a thumb reaches it; where
 * the page has a regular width it sits over it, as Safari's does on iPad.
 *
 * It never floats over the page. A streamed page cannot leave room for chrome
 * it does not know about, so anything drawn over it would hide the page's own
 * sticky header or pinned button out of reach.
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
  readonly label: string;
  readonly sections: readonly NativeMenuSection[];
  readonly symbol: SFSymbolName;
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
        <Symbol name={props.symbol} size={19} tint={color.text} weight="medium" />
      </ToolbarRound>
    </NativeMenu>
  );
}

function ToolbarRound(props: {
  readonly children: ReactNode;
  readonly selected?: boolean;
}): ReactNode {
  return (
    <GlassSurface
      interactive
      shape="capsule"
      style={styles.round}
      {...(props.selected === true ? { tint: color.ember } : {})}
    >
      {props.children}
    </GlassSurface>
  );
}

/**
 * The toolbar's widest control: the place itself, as Safari's address field
 * is. It takes whatever the round controls leave.
 */
export function ToolbarCapsule(props: {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}): ReactNode {
  return (
    <GlassSurface interactive shape="capsule" style={[styles.capsule, props.style]}>
      {props.children}
    </GlassSurface>
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
  slot: { flexShrink: 0 },
  top: { paddingBottom: space[8], paddingTop: space[4] },
});
