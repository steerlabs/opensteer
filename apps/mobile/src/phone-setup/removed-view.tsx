import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { space } from "../theme.js";
import { AppText, DisplayTitle, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { useReadingColumn } from "../ui/screen.js";
import type { RemovedViewProps } from "./removed-copy.js";

/**
 * Centred while it fits; at a large text size it scrolls, so its title is never cut and the way
 * back in is never off the screen.
 */
export function RemovedView(props: RemovedViewProps): ReactNode {
  const column = useReadingColumn();
  return (
    <ScrollView contentContainerStyle={[styles.content, column]}>
      <DisplayTitle size="small" style={styles.centred}>
        {props.title}
      </DisplayTitle>
      <AppText role="body" style={styles.centred} tone="muted">
        {props.body}
      </AppText>
      <View style={styles.actions}>
        <PrimaryButton label="Set up again" onPress={props.onSetUpAgain} prominent />
        <SecondaryButton label="Not now" onPress={props.onNotNow} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  actions: { gap: space[8], paddingTop: space[16] },
  centred: { textAlign: "center" },
  content: { flexGrow: 1, gap: space[8], justifyContent: "center", paddingVertical: space[16] },
});
