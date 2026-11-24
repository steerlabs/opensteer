import type { ReactNode } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  // Drawn before any screen, so it keeps clear of the status bar and the home indicator itself.
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      contentContainerStyle={[
        styles.words,
        {
          paddingBottom: insets.bottom + space[24],
          paddingLeft: insets.left + space[24],
          paddingRight: insets.right + space[24],
          paddingTop: insets.top + space[24],
        },
      ]}
      style={styles.failure}
    >
      <DisplayTitle size="small">Opensteer could not start</DisplayTitle>
      <Notice detail={props.detail} title={props.title} tone="neutral" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  failure: { backgroundColor: color.background, flex: 1 },
  words: { flexGrow: 1, gap: space[16], justifyContent: "center" },
});
