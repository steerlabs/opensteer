import type { ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import { color, controlFontScaleLimit, space, touchTarget } from "../theme.js";
import { GlassSurface } from "../ui/glass.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * "Fit to screen", over a page drawn at another width: the glyph alone where there is no room
 * for words. It is a control, so its words stop growing where a control's do, and the chip
 * grows with them rather than cutting them through.
 */
export function FitToScreenChip(props: {
  readonly onPress: () => void;
  readonly words: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint="Resizes the page to fill your screen"
      accessibilityLabel="Fit to screen"
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <GlassSurface interactive shape="capsule" style={props.words ? styles.chip : styles.glyph}>
        <Symbol
          name="arrow.up.left.and.arrow.down.right"
          size={14}
          tint={color.ember}
          weight="semibold"
        />
        {props.words ? (
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium">
            Fit to screen
          </AppText>
        ) : null}
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
    paddingVertical: space[6],
  },
  glyph: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  pressed: { opacity: 0.7 },
});
