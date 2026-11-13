import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { GlassSurface, useLiquidGlass } from "./glass.js";
import { AppText } from "./primitives.js";
import { Symbol } from "./symbol.js";

/** A form sheet's round button: glass where the system draws glass, a quiet disc elsewhere. */
export function SheetBarButton(props: {
  readonly icon: "chevron.left" | "xmark" | "magnifyingglass";
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  const glass = useLiquidGlass();
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      hitSlop={space[4]}
      onPress={props.onPress}
      style={styles.hit}
    >
      {({ pressed }) => {
        const icon = <Symbol name={props.icon} size={17} weight="semibold" />;
        return glass ? (
          <GlassSurface interactive shape="capsule" style={styles.glass}>
            {icon}
          </GlassSurface>
        ) : (
          <View style={[styles.disc, pressed && styles.pressed]}>{icon}</View>
        );
      }}
    </Pressable>
  );
}

/**
 * A form sheet's top: close at the leading edge, the title, and the one action the sheet is
 * for at the trailing edge, where the keyboard never covers it.
 */
export function SheetBar(props: {
  readonly action?: ReactNode;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly title: string;
}): ReactNode {
  return (
    <View style={styles.bar}>
      <View style={styles.side}>
        <SheetBarButton icon="xmark" label={props.closeLabel} onPress={props.onClose} />
      </View>
      <View accessibilityRole="header" style={styles.title}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="title">
          {props.title}
        </AppText>
      </View>
      <View style={[styles.side, styles.action]}>{props.action}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Both sides take the same room, so the title sits in the middle whatever the action says.
  action: { alignItems: "flex-end" },
  side: { alignItems: "flex-start", flex: 1, minWidth: touchTarget },
  bar: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    flexDirection: "row",
    gap: space[4],
    minHeight: touchTarget + space[8],
    paddingHorizontal: space[8],
    paddingTop: space[8],
  },
  title: { alignItems: "center", flexShrink: 1, minWidth: 0, paddingHorizontal: space[4] },
  disc: {
    ...material.quiet,
    alignItems: "center",
    borderRadius: radius.full,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  glass: { alignItems: "center", height: 36, justifyContent: "center", width: 36 },
  hit: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  pressed: { backgroundColor: material.selected.backgroundColor },
});
