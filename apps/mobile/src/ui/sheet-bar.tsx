import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { material, radius, space, touchTarget } from "../theme.js";
import { GlassSurface, useLiquidGlass } from "./glass.js";
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

const styles = StyleSheet.create({
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
