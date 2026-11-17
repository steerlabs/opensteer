import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import Animated from "react-native-reanimated";
import { space, touchTarget } from "../theme.js";
import { appear, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { owedSince } from "./owed-message-model.js";

/** How long an owed message waits silently before it says it is still on its way. */
const quietMs = 1_000;

/**
 * `idle`: owed, with nothing sending it right now. Just written down it is
 * about to go, so it reads as not sent only once the quiet moment has passed.
 */
export type OwedState = "sending" | "idle" | "failed" | "offline";

/**
 * The line under an owed message: nothing while it goes as it should, then
 * that it is on its way, or that it was not sent and can be sent again under
 * the same key.
 */
export function OwedMessageStatus(props: {
  readonly idempotencyKey: string;
  /** Null where sending again needs something first, such as a connection. */
  readonly onRetry: (() => void) | null;
  readonly state: OwedState;
}): ReactNode {
  const since = owedSince(props.idempotencyKey);
  // A view just opened on an owed message, such as the task Home handed it
  // to, is about to send it: it keeps saying what was said until it has.
  const [mountedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const settles = Math.max(since, mountedAt) + quietMs;
  useEffect(() => {
    if (now >= settles) return;
    const timer = setTimeout(() => setNow(Date.now()), settles - now);
    return () => clearTimeout(timer);
  }, [now, settles]);
  const waited = now - since >= quietMs;
  const shown =
    props.state === "sending" || (props.state === "idle" && now - mountedAt < quietMs)
      ? waited
        ? "sending"
        : null
      : props.state === "idle"
        ? "failed"
        : props.state;
  if (shown === null) return null;
  return (
    <Animated.View
      entering={appear}
      exiting={exit}
      key={shown}
      style={styles.status}
      testID="owed-message-status"
    >
      {shown === "sending" ? (
        <AppText role="caption" tone="muted">
          Sending…
        </AppText>
      ) : shown === "offline" || props.onRetry === null ? (
        <AppText role="caption" tone="muted">
          Not sent yet
        </AppText>
      ) : (
        <>
          <AppText role="caption" tone="muted">
            Not sent ·
          </AppText>
          <Pressable
            accessibilityLabel="Send this message again"
            accessibilityRole="button"
            hitSlop={space[12]}
            onPress={props.onRetry}
            style={styles.retry}
          >
            <AppText role="caption" style={styles.retryLabel} tone="ember">
              Try again
            </AppText>
          </Pressable>
        </>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  retry: { justifyContent: "center", minHeight: touchTarget / 2 },
  retryLabel: { fontWeight: "600" },
  status: {
    alignItems: "center",
    alignSelf: "flex-end",
    flexDirection: "row",
    gap: space[4],
    paddingTop: space[4],
  },
});
