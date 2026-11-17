import * as Haptics from "expo-haptics";
import { memo, useEffect, useRef, type ReactNode } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { space, touchTarget } from "../theme.js";
import { appear } from "./motion.js";
import type { ActionLineValue } from "./action-line-value.js";
import { AppText } from "./primitives.js";

export { issueLine, type ActionLineValue } from "./action-line-value.js";

/**
 * The answer to a tap, in one short line next to where it happened: never a
 * box, a toast or a banner. A link, such as Check or Try again, stays in
 * view however the words are cut.
 */
export const ActionLine = memo(function ActionLine(props: {
  readonly line: ActionLineValue;
  /** One line where a row's height must not change; two in a sheet or under buttons. */
  readonly numberOfLines?: 1 | 2;
  /** A refusal is dismissed by tapping it. */
  readonly onDismiss?: (() => void) | undefined;
}): ReactNode {
  const { key, text } = props.line;
  // Said and felt once per outcome, not again when its words are re-rendered.
  const said = useRef(props.line);
  said.current = props.line;
  useEffect(() => {
    const { haptic, text } = said.current;
    void AccessibilityInfo.announceForAccessibility(text);
    if (haptic === "warning")
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    if (haptic === "error") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  }, [key]);
  const link = props.line.link ?? null;
  const words = (
    <AppText
      numberOfLines={props.numberOfLines ?? 1}
      role="caption"
      style={styles.words}
      tone={props.line.tone}
    >
      {text}
    </AppText>
  );
  return (
    <Animated.View entering={appear} key={key} style={styles.line}>
      {props.onDismiss === undefined ? (
        words
      ) : (
        <Pressable
          accessibilityHint="Dismisses"
          accessibilityRole="button"
          onPress={props.onDismiss}
          style={styles.dismiss}
        >
          {words}
        </Pressable>
      )}
      {link === null ? null : (
        <Pressable
          accessibilityLabel={link.accessibilityLabel ?? link.label}
          accessibilityRole="button"
          hitSlop={space[12]}
          onPress={link.onPress}
          style={styles.link}
        >
          <AppText numberOfLines={1} role="caption" style={styles.linkLabel} tone="ember">
            {link.label}
          </AppText>
        </Pressable>
      )}
    </Animated.View>
  );
});

/**
 * A list row's second line: its subtitle, or the outcome of an action on the
 * row in the subtitle's place, at the same one-line height, so the row never
 * grows. The title above it stays.
 */
export function RowSubtitle(props: {
  readonly subtitle: ReactNode;
  readonly line: ActionLineValue | null;
}): ReactNode {
  if (props.line !== null) return <ActionLine line={props.line} numberOfLines={1} />;
  return typeof props.subtitle === "string" ? (
    <AppText numberOfLines={1} role="caption" tone="muted">
      {props.subtitle}
    </AppText>
  ) : (
    props.subtitle
  );
}

/**
 * A sheet's one-line slot above its primary button, reserved whether or not
 * it holds a line, so the button never jumps when an outcome arrives.
 */
export function ActionLineSlot(props: {
  readonly line: ActionLineValue | null;
  readonly onDismiss?: (() => void) | undefined;
}): ReactNode {
  return (
    <View style={styles.slot}>
      {props.line === null ? (
        // One line of caption at the reader's text size, holding the place.
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <AppText role="caption" style={styles.reserved}>
            {" "}
          </AppText>
        </View>
      ) : (
        <ActionLine line={props.line} numberOfLines={1} onDismiss={props.onDismiss} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dismiss: { flexShrink: 1 },
  line: { alignItems: "center", flexDirection: "row", gap: space[6] },
  link: { justifyContent: "center", minHeight: touchTarget / 2 },
  linkLabel: { fontWeight: "600" },
  reserved: { opacity: 0 },
  slot: { justifyContent: "center" },
  words: { flexShrink: 1 },
});
