import type { ActionReview } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { space } from "../theme.js";
import { AppText, SecondaryButton } from "./primitives.js";
import { Sheet } from "./sheet.js";

/** Controlled, so a live state change can dismiss the native confirmation too. */
export function ActionReviewSheet(props: {
  readonly review: ActionReview | null;
  readonly title: string;
  readonly detail: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly onClose: () => void;
  /** Runs the reviewed action; its outcome is said beside what asked for it. */
  readonly onConfirm: (review: ActionReview) => void;
}): ReactNode {
  const { review } = props;
  if (!review) return null;
  return (
    <Sheet open title={props.title} onClose={props.onClose}>
      <View style={styles.body}>
        <AppText role="secondary" tone="muted">
          {props.detail}
        </AppText>
        <SecondaryButton label={props.cancelLabel} onPress={props.onClose} />
        <SecondaryButton
          label={props.confirmLabel}
          tone="danger"
          onPress={() => {
            props.onConfirm(review);
            props.onClose();
          }}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: space[12], paddingHorizontal: space[16], paddingTop: space[8] },
});
