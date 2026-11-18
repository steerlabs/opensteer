import type { ReactNode } from "react";
import { presentClientIssue } from "@opensteer/client/feedback";
import { StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { AppText, SecondaryButton } from "./primitives.js";
import { Symbol } from "./symbol.js";

/**
 * What a destination says when what a link named is gone or not the reader's
 * to see: a fact about it, never the connection, which the route gate says.
 * One wording everywhere, and always a way back.
 */
export function UnavailableState(props: { readonly onBack: () => void }): ReactNode {
  const copy = presentClientIssue({ code: "access-lost" });
  return (
    <View accessibilityRole="alert" style={styles.state}>
      <Symbol name="questionmark.circle" size={32} tint={color.muted} />
      <AppText role="title" style={styles.centered}>
        {copy.title}
      </AppText>
      <AppText role="secondary" style={styles.centered} tone="muted">
        {copy.detail}
      </AppText>
      <View style={styles.actions}>
        <SecondaryButton compact label="Back" onPress={props.onBack} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: space[12], marginTop: space[8] },
  centered: { textAlign: "center" },
  state: {
    alignItems: "center",
    flex: 1,
    gap: space[8],
    justifyContent: "center",
    padding: space[24],
  },
});
