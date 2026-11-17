import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { color, plateFill, space, touchTarget } from "../theme.js";
import { appear, duration, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";

/** Where a message this phone holds is on its way to the computer. */
export type MessageDeliveryPhase = "waiting" | "sending" | "rejected" | "delivered";

export type MessageDeliveryAction = "edit" | "delete" | "dont-send";

/**
 * What a person may do to a message still on this phone. A refused message can
 * be edited or deleted. A waiting one can be taken back only if no attempt was
 * ever made: after one, it may already be on the computer, and the same key
 * is replayed until it is settled.
 */
export function messageDeliveryActions(
  phase: MessageDeliveryPhase,
  attempted: boolean,
): readonly MessageDeliveryAction[] {
  if (phase === "rejected") return ["edit", "delete"];
  if (phase === "waiting" && !attempted) return ["edit", "dont-send"];
  return [];
}

/**
 * Of a run of messages, which carry the status line: a run of waiting messages
 * says it once, under the last, as a grouped receipt does.
 */
export function messageDeliveryStatusShown(
  phases: readonly MessageDeliveryPhase[],
): readonly boolean[] {
  return phases.map(
    (phase, index) =>
      phase !== "delivered" && !(phase === "waiting" && phases[index + 1] === "waiting"),
  );
}

/** A refused message: the plate with a red edge, in the reading ink. */
export const rejectedBubble = {
  fill: plateFill,
  ink: color.text,
  style: { borderColor: color.redLine, borderWidth: 1 } satisfies ViewStyle,
} as const;

const defaultCopy = {
  delete: "Delete",
  dontSend: "Don't send",
  edit: "Edit",
  sending: "Sending…",
  waiting: "Waiting to send",
};

/** How long a message being sent on a good connection says nothing at all. */
const quietMs = 1_000;
const pendingOpacity = 0.6;

/**
 * A person's own message that is still on this phone, drawn where the
 * delivered message will stand: delivery is a change of state in place, not a
 * second bubble. Waiting dims it at once; sending dims it only once a moment
 * has passed. The bubble itself is the caller's, given `rejectedBubble` when
 * refused.
 */
export const MessageDelivery = memo(function MessageDelivery(props: {
  readonly children: ReactNode;
  readonly phase: MessageDeliveryPhase;
  /** When this message was first shown, in epoch milliseconds: the quiet moment counts from it. */
  readonly since: number;
  readonly attempted: boolean;
  /** False for every waiting message of a run but the last. */
  readonly showStatus: boolean;
  /** The refusal in full, "Not sent. Message is too long."; shown only when rejected. */
  readonly rejection?: string | null;
  readonly onAction?: ((action: MessageDeliveryAction) => void) | undefined;
  readonly copy?: Partial<typeof defaultCopy>;
}): ReactNode {
  const copy = { ...defaultCopy, ...props.copy };
  const quiet = useQuietMoment(props.phase === "sending" ? props.since : null);
  const dimmed = props.phase === "waiting" || (props.phase === "sending" && !quiet);
  const opacity = useSharedValue(dimmed ? pendingOpacity : 1);
  useEffect(() => {
    opacity.value = withTiming(dimmed ? pendingOpacity : 1, { duration: duration.enter });
  }, [dimmed, opacity]);
  const look = useAnimatedStyle(() => ({ opacity: opacity.value }));

  const accessibilityActions = useMemo(
    () =>
      messageDeliveryActions(props.phase, props.attempted).map((name) => ({
        label: name === "edit" ? copy.edit : name === "delete" ? copy.delete : copy.dontSend,
        name,
      })),
    [props.phase, props.attempted, copy.edit, copy.delete, copy.dontSend],
  );
  const onAction = props.onAction;
  const status =
    props.phase === "rejected"
      ? "rejected"
      : !props.showStatus || props.phase === "delivered"
        ? null
        : props.phase === "waiting"
          ? "waiting"
          : quiet
            ? null
            : "sending";

  return (
    <View
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={
        onAction === undefined
          ? undefined
          : (event: AccessibilityActionEvent) => {
              const name = event.nativeEvent.actionName;
              if (name === "edit" || name === "delete" || name === "dont-send") onAction(name);
            }
      }
    >
      <Animated.View style={look}>{props.children}</Animated.View>
      {status === null ? null : (
        <Animated.View entering={appear} exiting={exit} key={status} style={styles.status}>
          {status === "rejected" ? (
            <>
              <AppText role="caption" style={styles.reason} tone="danger">
                {props.rejection ?? null}
              </AppText>
              {onAction === undefined
                ? null
                : (["edit", "delete"] as const).map((name, index) => (
                    <View key={name} style={styles.linkRow}>
                      {index === 0 ? null : (
                        <AppText role="caption" tone="muted">
                          ·
                        </AppText>
                      )}
                      <Pressable
                        accessibilityRole="button"
                        hitSlop={space[8]}
                        onPress={() => onAction(name)}
                        style={styles.link}
                      >
                        <AppText role="caption" style={styles.linkLabel} tone="ember">
                          {actionLabel(name, copy)}
                        </AppText>
                      </Pressable>
                    </View>
                  ))}
            </>
          ) : (
            <AppText role="caption" tone="muted">
              {status === "waiting" ? copy.waiting : copy.sending}
            </AppText>
          )}
        </Animated.View>
      )}
    </View>
  );
});

function actionLabel(name: MessageDeliveryAction, copy: typeof defaultCopy): string {
  return name === "edit" ? copy.edit : name === "delete" ? copy.delete : copy.dontSend;
}

/** True until a second has passed since `since`; one timer, no ticking. */
function useQuietMoment(since: number | null): boolean {
  const ends = since === null ? null : since + quietMs;
  const [passed, setPassed] = useState<number | null>(null);
  useEffect(() => {
    if (ends === null) return;
    const left = ends - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setPassed(ends), left);
    return () => clearTimeout(timer);
  }, [ends]);
  return ends !== null && passed !== ends && Date.now() < ends;
}

const styles = StyleSheet.create({
  link: { justifyContent: "center", minHeight: touchTarget / 2 },
  linkLabel: { fontWeight: "600" },
  linkRow: { alignItems: "center", flexDirection: "row", gap: space[4] },
  reason: { flexShrink: 1, textAlign: "right" },
  status: {
    alignItems: "center",
    alignSelf: "flex-end",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space[4],
    justifyContent: "flex-end",
    paddingTop: space[4],
  },
});
