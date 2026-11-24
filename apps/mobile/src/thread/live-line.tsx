import type { LiveTurn } from "@opensteer/client/host";
import { useLiveTurnLine } from "@opensteer/client/react";
import { createContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, radius, space } from "../theme.js";
import { AppText, StatusDot, monoFontFamily } from "../ui/primitives.js";

/**
 * The Run the line above the composer speaks for, while it is on screen: that
 * Run's turn keeps only its steps' disclosure for a head, which would otherwise
 * repeat the line out of view once the turn grows.
 */
export const LiveLineRunContext = createContext<string | null>(null);

/**
 * The line above a task's composer while its turn is under way: what the agent
 * is doing — between steps, the step it last finished — how long the Run has
 * gone, and how recent that is. It ticks only while this reader is in touch
 * with the Host; out of touch, nothing on it moves.
 */
export function LiveLine(props: {
  readonly connected: boolean;
  readonly live: LiveTurn;
}): ReactNode {
  const line = useLiveTurnLine(props.live, props.connected);
  const meta = [line.since, line.elapsed].filter(Boolean).join(" · ");
  return (
    <View
      accessibilityLabel="Agent status"
      style={[
        styles.line,
        line.tone === "quiet" ? styles.quiet : line.tone === "stalled" ? styles.stalled : null,
      ]}
    >
      <View style={styles.row}>
        <StatusDot
          live={line.tone === "working"}
          tone={
            line.tone === "quiet"
              ? "amber"
              : line.tone === "stalled"
                ? "red"
                : line.tone === "held"
                  ? "muted"
                  : "ember"
          }
        />
        <View style={styles.words}>
          <View style={styles.head}>
            <AppText numberOfLines={1} role="secondaryMedium" style={styles.label} tone="soft">
              {line.label}
            </AppText>
            {line.detail ? (
              <AppText
                numberOfLines={1}
                role="caption"
                style={[styles.detail, line.detail.code ? styles.code : null]}
                tone="muted"
              >
                {line.detail.text}
              </AppText>
            ) : null}
          </View>
          {meta ? (
            // Ticks every second: kept from VoiceOver, which reads the words.
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <AppText numberOfLines={1} role="caption" style={styles.meta} tone="muted">
                {meta}
              </AppText>
            </View>
          ) : null}
          {line.note ? (
            <AppText role="caption" tone="soft">
              {line.note}
            </AppText>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  code: { fontFamily: monoFontFamily },
  detail: { flexShrink: 1 },
  head: { alignItems: "baseline", flexDirection: "row", gap: space[8], minWidth: 0 },
  label: { flexShrink: 0, maxWidth: "70%" },
  line: {
    backgroundColor: color.surface,
    borderColor: color.lineStrong,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: space[8],
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  meta: { fontVariant: ["tabular-nums"] },
  quiet: { backgroundColor: color.amberWash, borderColor: color.amberLine },
  row: { alignItems: "center", flexDirection: "row", gap: space[10] },
  stalled: { backgroundColor: color.redWash, borderColor: color.redLine },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
