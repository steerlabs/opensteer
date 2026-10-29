import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { IphoneAppsApproval } from "../platform/iphone-apps.js";
import { space } from "../theme.js";
import { AppText, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { FailureText } from "../computers/block-actions.js";
import { iphoneApprovalLines, iphoneApprovalTitle } from "./model.js";

/** A task's ask for one app on this iPhone, answered here and nowhere else. */
export function IphoneApprovalCard(props: {
  readonly approval: IphoneAppsApproval;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly name: string;
  readonly onAllow: () => void;
  readonly onDeny: () => void;
}): ReactNode {
  return (
    <View style={styles.card}>
      <AppText role="bodyMedium">{iphoneApprovalTitle(props.approval, props.name)}</AppText>
      {iphoneApprovalLines(props.approval).map((line) => (
        <AppText key={line} role="secondary" tone="muted">
          {line}
        </AppText>
      ))}
      <View style={styles.actions}>
        <SecondaryButton
          accessibilityLabel="Don't allow"
          disabled={props.busy}
          label="Don't allow"
          onPress={props.onDeny}
        />
        <PrimaryButton busy={props.busy} label="Allow" onPress={props.onAllow} />
      </View>
      <FailureText detail={props.failure} />
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: space[12],
    justifyContent: "flex-end",
    paddingTop: space[8],
  },
  card: { gap: space[4], paddingHorizontal: space[16], paddingVertical: space[12] },
});
