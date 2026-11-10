import type { ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import { color, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * Which subagent asked, as the way to its own view: there the same question
 * can be answered with what it did on the way to asking.
 */
export function AskedBySubagent(props: {
  readonly onOpen: () => void;
  readonly title: string;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint="Opens the subagent that asked"
      accessibilityRole="link"
      hitSlop={{ bottom: space[12], top: space[12] }}
      onPress={props.onOpen}
      style={({ pressed }) => [styles.asker, pressed && styles.askerPressed]}
    >
      <AppText numberOfLines={1} role="caption" style={styles.askerWords} tone="muted">
        Asked by subagent {props.title}
      </AppText>
      <Symbol name="chevron.right" size={10} tint={color.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  asker: { alignItems: "center", alignSelf: "flex-start", flexDirection: "row", gap: space[4] },
  askerPressed: { opacity: 0.6 },
  askerWords: { flexShrink: 1 },
});
