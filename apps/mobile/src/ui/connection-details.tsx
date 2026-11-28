import { memo, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { useFitSheetHeight } from "./fit-sheet.js";
import { useContentInsets } from "./pane.js";
import { useStackedLayout } from "./stacked-layout.js";
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
 * The sheet is as tall as what it says, up to `useFitSheetHeight`; past that it scrolls.
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
  const tallest = useFitSheetHeight();
  const insets = useContentInsets();
  // At the largest sizes each row's words take the width under its name, and the mark stands
  // above the name (`stacked-layout.ts`).
  const stacked = useStackedLayout();
  // In landscape the island and the home indicator stand at the sides.
  const sides = { paddingLeft: space[20] + insets.left, paddingRight: space[20] + insets.right };
  return (
    <View style={{ maxHeight: tallest }}>
      <ScrollView
        contentContainerStyle={[
          styles.details,
          sides,
          props.action === null && { paddingBottom: insets.bottom + space[24] },
        ]}
        style={styles.words}
      >
        <View
          accessibilityRole="header"
          accessible
          style={[styles.head, stacked && styles.headStacked]}
        >
          {props.mark}
          <AppText role="title" style={styles.name}>
            {props.name}
          </AppText>
        </View>
        <AppText
          role="secondary"
          style={[styles.state, stacked && styles.stateStacked]}
          tone="soft"
        >
          {props.state}
        </AppText>
        <AppText role="secondary" tone="muted">
          {props.explanation}
        </AppText>
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
                style={({ pressed }) => [
                  styles.other,
                  stacked && styles.otherStacked,
                  pressed && styles.otherPressed,
                ]}
              >
                <AppText
                  {...(stacked ? {} : { numberOfLines: 1 })}
                  role="body"
                  style={!stacked && styles.otherName}
                >
                  {session.name}
                </AppText>
                <AppText {...(stacked ? {} : { numberOfLines: 1 })} role="secondary" tone="muted">
                  {session.state}
                </AppText>
                {stacked ? null : (
                  <Symbol name="chevron.right" size={13} tint={color.muted} weight="semibold" />
                )}
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
      {/* The one thing to do stays in view below the words, whatever their size. */}
      {props.action === null ? null : (
        <View style={[styles.action, sides, { paddingBottom: insets.bottom + space[16] }]}>
          <PrimaryButton
            busy={props.action.busy === true}
            compact
            label={props.action.label}
            onPress={props.action.onPress}
            quietBusy
          />
        </View>
      )}
    </View>
  );
});

/** Mark (28) and its gap: the state line sits under the name, not the mark. */
const markColumn = 28 + space[10];

const styles = StyleSheet.create({
  action: { alignItems: "flex-start", paddingTop: space[14] },
  details: { paddingBottom: space[24], paddingTop: space[24] },
  head: { alignItems: "center", flexDirection: "row", gap: space[10] },
  headStacked: { alignItems: "flex-start", flexDirection: "column" },
  meta: { marginTop: space[14] },
  name: { flexShrink: 1 },
  other: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    minHeight: 44,
  },
  otherName: { flex: 1 },
  otherStacked: { alignItems: "stretch", flexDirection: "column", gap: space[2] },
  otherPressed: { opacity: 0.6 },
  others: {
    borderTopColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: space[16],
    paddingTop: space[4],
  },
  state: { marginBottom: space[10], marginLeft: markColumn, marginTop: space[2] },
  stateStacked: { marginLeft: 0 },
  words: { flexGrow: 0, flexShrink: 1 },
});
