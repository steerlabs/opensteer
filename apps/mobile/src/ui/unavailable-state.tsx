import {
  failureNotice,
  type ClientNetworkState,
  type FailureNotice,
  type OperationFailure,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { AppText, PrimaryButton, SecondaryButton } from "./primitives.js";
import { Symbol, type SFSymbolName } from "./symbol.js";

const symbols: Record<FailureNotice["tone"], SFSymbolName> = {
  failed: "exclamationmark.circle",
  gone: "questionmark.circle",
  offline: "icloud.slash",
  "signed-out": "exclamationmark.circle",
  unreachable: "exclamationmark.circle",
};

/**
 * What a destination says when what a link named can't be shown. One wording
 * everywhere, and always a way back, so an open never ends in a silent close.
 * Only a failure that may pass offers Retry.
 */
export function UnavailableState(props: {
  readonly failure?: OperationFailure | undefined;
  readonly network?: ClientNetworkState | undefined;
  readonly onBack: () => void;
  readonly onRetry?: (() => void) | undefined;
}): ReactNode {
  const notice = failureNotice(props.failure ?? "gone", props.network ?? "unknown");
  const retry = notice.retry ? props.onRetry : undefined;
  return (
    <View accessibilityRole="alert" style={styles.state}>
      <Symbol name={symbols[notice.tone]} size={32} tint={color.muted} />
      <AppText role="title" style={styles.centered}>
        {notice.title}
      </AppText>
      <AppText role="secondary" style={styles.centered} tone="muted">
        {notice.body}
      </AppText>
      <View style={styles.actions}>
        {retry ? <PrimaryButton compact label="Retry" onPress={retry} /> : null}
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
