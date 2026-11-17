import {
  messageDeliveryActions,
  type MessageDeliveryAction,
  type MessageDeliveryPhase,
} from "@opensteer/client/host";
import { useQuietMoment } from "@opensteer/client/react";
import { createContext, memo, useEffect, useMemo, type ReactNode } from "react";
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

/**
 * What a transcript lets a person do to the messages still on this phone,
 * by their send key, and which of them carry a status line: a run of waiting
 * messages says it once, under the last.
 */
export interface MessageDeliveryControls {
  readonly act: (key: string, action: MessageDeliveryAction) => void;
  readonly statusShown: (key: string) => boolean;
}

export const MessageDeliveryContext = createContext<MessageDeliveryControls | null>(null);

/** The long-press menu's entries for a message on its way, by its phase. */
export function deliveryMenu(
  phase: MessageDeliveryPhase,
  attempted: boolean,
): readonly {
  readonly group: number;
  readonly id: MessageDeliveryAction;
  readonly image: string;
  readonly title: string;
}[] {
  return messageDeliveryActions(phase, attempted).map((id) => ({
    group: 0,
    id,
    image: id === "edit" ? "pencil" : id === "delete" ? "trash" : "xmark",
    title: actionLabel(id, defaultCopy),
  }));
}

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
  const quiet = useQuietMoment(props.phase === "sending" ? props.since : null, quietMs);
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
