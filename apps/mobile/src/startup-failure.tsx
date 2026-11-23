import type { ReactNode } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { color, space } from "./theme.js";
import { DisplayTitle, Notice } from "./ui/primitives.js";

/**
 * Why the app could not start, and what to do. Centred while it fits; at a large text size it
 * scrolls, so what to do about it is never off the screen.
 */
export function StartupFailureView(props: {
  readonly title: string;
  readonly detail: string;
}): ReactNode {
  return (
    <ScrollView contentContainerStyle={styles.words} style={styles.failure}>
      <DisplayTitle size="small">Opensteer could not start</DisplayTitle>
      <Notice detail={props.detail} title={props.title} tone="neutral" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  failure: { backgroundColor: color.background, flex: 1 },
  words: { flexGrow: 1, gap: space[16], justifyContent: "center", padding: space[24] },
});
