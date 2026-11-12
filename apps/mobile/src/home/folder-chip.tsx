import type { ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import { color, controlFontScaleLimit, material, pillHeight, radius, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * The folder a new task will work in, beside the model pill in the
 * composer's toolbar. A task's folder never changes once it starts.
 */
export function FolderChip(props: {
  readonly label: string;
  readonly home?: boolean;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint="Chooses the folder this task works in"
      accessibilityLabel={`Works in ${props.label}`}
      accessibilityRole="button"
      hitSlop={{ bottom: 6, top: 6 }}
      onPress={props.onPress}
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
    >
      <Symbol name={props.home === false ? "folder" : "house"} size={13} tint={color.muted} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={styles.chipLabel}
      >
        {props.label}
      </AppText>
      <Symbol name="chevron.down" size={11} tint={color.muted} weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    flexShrink: 1,
    gap: space[6],
    height: pillHeight,
    maxWidth: 180,
    paddingHorizontal: space[10] - 1,
  },
  chipLabel: { color: color.textSoft, flexShrink: 1, fontWeight: "600" },
  chipPressed: { ...material.platePressed },
});
