import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { AppText, PrimaryButton } from "./primitives.js";
import { Symbol } from "./symbol.js";

export interface ConnectionDetailsSession {
  readonly key: string;
  readonly name: string;
  /** The pill's own word for it, such as "Reconnecting…". */
  readonly state: string;
  readonly onPress: () => void;
}

/**
 * What the pill opens: which connection, what is going on, whether messages
 * are safe, and the one thing to do. Other sessions with trouble are rows, not
 * second pills. Its words change in place; it never shows a "Connected" screen.
 */
export const ConnectionDetails = memo(function ConnectionDetails(props: {
  /** The Deployment's mark, drawn beside its name. */
  readonly mark: ReactNode;
  readonly name: string;
  readonly state: string;
  readonly explanation: string;
  readonly action: {
    readonly label: string;
    readonly onPress: () => void;
    readonly busy?: boolean;
  } | null;
  /** "Last connected 9:41 · via Connect"; null when nothing is known. */
  readonly meta: string | null;
  readonly others: readonly ConnectionDetailsSession[];
}): ReactNode {
  return (
    <View style={styles.details}>
      <View accessibilityRole="header" accessible style={styles.head}>
        {props.mark}
        <AppText numberOfLines={1} role="title" style={styles.name}>
          {props.name}
        </AppText>
      </View>
      <AppText role="secondary" style={styles.state} tone="soft">
        {props.state}
      </AppText>
      <AppText role="secondary" tone="muted">
        {props.explanation}
      </AppText>
      {props.action === null ? null : (
        <View style={styles.action}>
          <PrimaryButton
            busy={props.action.busy === true}
            compact
            label={props.action.label}
            onPress={props.action.onPress}
            quietBusy
          />
        </View>
      )}
      {props.meta === null ? null : (
        <AppText role="caption" style={styles.meta} tone="muted">
          {props.meta}
        </AppText>
      )}
      {props.others.length === 0 ? null : (
        <View style={styles.others}>
          {props.others.map((session) => (
            <Pressable
              accessibilityLabel={`${session.name}, ${session.state}`}
              accessibilityRole="button"
              key={session.key}
              onPress={session.onPress}
              style={({ pressed }) => [styles.other, pressed && styles.otherPressed]}
            >
              <AppText numberOfLines={1} role="body" style={styles.otherName}>
                {session.name}
              </AppText>
              <AppText numberOfLines={1} role="secondary" tone="muted">
                {session.state}
              </AppText>
              <Symbol name="chevron.right" size={13} tint={color.muted} weight="semibold" />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
});

/** Mark (28) and its gap: the state line sits under the name, not the mark. */
const markColumn = 28 + space[10];

const styles = StyleSheet.create({
  action: { alignItems: "flex-start", marginTop: space[14] },
  details: { paddingBottom: space[24], paddingHorizontal: space[20], paddingTop: space[24] },
  head: { alignItems: "center", flexDirection: "row", gap: space[10] },
  meta: { marginTop: space[14] },
  name: { flexShrink: 1 },
  other: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    minHeight: 44,
  },
  otherName: { flex: 1 },
  otherPressed: { opacity: 0.6 },
  others: {
    borderTopColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: space[16],
    paddingTop: space[4],
  },
  state: { marginBottom: space[10], marginLeft: markColumn, marginTop: space[2] },
});
