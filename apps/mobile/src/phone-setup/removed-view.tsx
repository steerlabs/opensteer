import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { space } from "../theme.js";
import { AppText, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { useReadingColumn } from "../ui/screen.js";
import type { RemovedViewProps } from "./removed-copy.js";

export function RemovedView(props: RemovedViewProps): ReactNode {
  const column = useReadingColumn();
  return (
    <View style={[styles.content, column]}>
      <AppText role="displaySmall" style={styles.centred}>
        {props.title}
      </AppText>
      <AppText role="body" style={styles.centred} tone="muted">
        {props.body}
      </AppText>
      <View style={styles.actions}>
        <PrimaryButton label="Set up again" onPress={props.onSetUpAgain} prominent />
        <SecondaryButton label="Not now" onPress={props.onNotNow} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { gap: space[8], paddingTop: space[16] },
  centred: { textAlign: "center" },
  content: { flex: 1, gap: space[8], justifyContent: "center" },
});
