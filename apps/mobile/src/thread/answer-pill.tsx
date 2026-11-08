import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/** The composer's round control, as a word: the same 34 points inside the same 44. */
const pillHeight = 34;

export type AnswerPillTone = "primary" | "secondary" | "danger";

/**
 * One answer. The Pressable is the whole touch target with the pill painted
 * inside it, as `ComposerAction` does, so a finger and a switch control land on
 * the same bounds. Busy keeps the label in place under the spinner: the pill
 * holds its width, and nothing beside it moves while the answer is sent.
 */
export function AnswerPill(props: {
  readonly accessibilityHint?: string;
  readonly accessibilityLabel?: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly onPress: () => void;
  readonly tone: AnswerPillTone;
}): ReactNode {
  const busy = props.busy === true;
  const disabled = props.disabled === true || busy;
  const primary = props.tone === "primary";
  return (
    <Pressable
      accessibilityHint={props.accessibilityHint}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={props.onPress}
      style={styles.target}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.pill,
            primary ? styles.primary : styles.secondary,
            props.tone === "danger" && styles.danger,
            pressed && (primary ? styles.primaryPressed : styles.secondaryPressed),
            props.disabled === true && styles.disabled,
          ]}
        >
          <View style={[styles.face, busy && styles.hidden]}>
            {props.icon}
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              role="secondaryMedium"
              style={
                primary ? styles.primaryLabel : props.tone === "danger" ? styles.dangerLabel : null
              }
            >
              {props.label}
            </AppText>
          </View>
          {busy ? (
            <ActivityIndicator
              color={primary ? color.inkOnEmber : color.ember}
              size="small"
              style={styles.spinner}
            />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

/**
 * A Request's answers, on the same line everywhere: the leading slot lines up
 * with the composer's `+`, and the last answer ends where its send circle does.
 * Too wide for the line, the answers wrap and stay against the trailing edge.
 */
export function AnswerRow(props: {
  readonly children: ReactNode;
  readonly leading?: ReactNode;
}): ReactNode {
  return (
    <View style={styles.row}>
      {props.leading === undefined ? null : <View style={styles.leading}>{props.leading}</View>}
      <View style={styles.answers}>{props.children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  answers: {
    columnGap: space[8],
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  danger: { borderColor: color.redLine },
  dangerLabel: { color: color.red },
  disabled: { opacity: 0.45 },
  face: { alignItems: "center", flexDirection: "row", gap: space[6] },
  hidden: { opacity: 0 },
  leading: { flexShrink: 0 },
  pill: {
    alignItems: "center",
    borderRadius: radius.full,
    justifyContent: "center",
    minHeight: pillHeight,
    minWidth: 68,
    paddingHorizontal: space[14] - 1,
    paddingVertical: space[6] - 1,
  },
  primary: { ...material.accent },
  primaryLabel: { color: color.inkOnEmber, fontWeight: "600" },
  primaryPressed: { ...material.accentPressed },
  row: { alignItems: "center", flexDirection: "row", minHeight: touchTarget },
  secondary: { ...material.control },
  secondaryPressed: { ...material.platePressed },
  spinner: { position: "absolute" },
  target: { justifyContent: "center", maxWidth: "100%", minHeight: touchTarget },
});
