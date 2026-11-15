import { HostClientRequestError } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { AppText, PrimaryButton, SecondaryButton } from "./primitives.js";
import { Symbol } from "./symbol.js";

/**
 * What a destination says when what a link named can't be shown: gone or not
 * the reader's to see, or out of reach for now. One wording everywhere, and
 * always a way back, so an open never ends in a silent close.
 */
export function UnavailableState(props: {
  readonly onBack: () => void;
  /** Present when the reader is offline; it tries again. */
  readonly onRetry?: (() => void) | undefined;
}): ReactNode {
  const offline = props.onRetry !== undefined;
  return (
    <View accessibilityRole="alert" style={styles.state}>
      <Symbol
        name={offline ? "icloud.slash" : "questionmark.circle"}
        size={32}
        tint={color.muted}
      />
      <AppText role="title" style={styles.centered}>
        {offline ? "You're offline" : "This isn't available"}
      </AppText>
      <AppText role="secondary" style={styles.centered} tone="muted">
        {offline
          ? "Check your connection and try again."
          : "It may have been deleted, or you don't have access."}
      </AppText>
      <View style={styles.actions}>
        {props.onRetry ? <PrimaryButton compact label="Retry" onPress={props.onRetry} /> : null}
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

/** How a read for a linked destination failed: gone or forbidden, out of reach, or otherwise. */
export function readFailure(error: unknown): "unavailable" | "offline" | "failed" {
  if (error instanceof HostClientRequestError) {
    if (error.status === 403 || error.status === 404) return "unavailable";
    if (
      error.reason === "transport-unreachable" ||
      error.reason === "transport-timed-out" ||
      error.code === "runner_offline" ||
      error.code === "timeout"
    )
      return "offline";
    return "failed";
  }
  return error instanceof TypeError ? "offline" : "failed";
}
