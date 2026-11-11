import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TeamTile } from "../team/team-marks.js";
import type { TaskSourceView } from "./home-models.js";

/**
 * Where a task started from a team thread came from: the team's tile and the
 * channel, inline on a task's second line ("A #support").
 */
export function TaskSourceLabel(props: { readonly source: TaskSourceView }): ReactNode {
  const { source } = props;
  return (
    <View style={styles.label}>
      <TeamTile size={16} team={source.team} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={source.available ? styles.place : styles.placeGone}
      >
        {source.place}
      </AppText>
    </View>
  );
}

/**
 * Under a team task's title: the way back to the thread that asked for it.
 * Once the reader has left the team it greys, says so, and goes nowhere; the
 * task and its private follow-ups keep working.
 */
export function TaskSourceChip(props: {
  readonly onOpen: () => void;
  readonly source: TaskSourceView;
}): ReactNode {
  const { source } = props;
  const words = [source.place, source.thread].filter(Boolean).join(" · ");
  if (!source.available) {
    return (
      <View
        accessibilityLabel={`${source.team.name} ${words}, no longer available`}
        accessible
        style={[styles.chip, styles.chipGone]}
      >
        <View style={styles.faded}>
          <TeamTile size={16} team={source.team} />
        </View>
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="caption"
          tone="muted"
        >
          {words} · no longer available
        </AppText>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityHint="Opens the thread this task answers"
      accessibilityLabel={`${source.team.name} ${words}`}
      accessibilityRole="link"
      onPress={props.onOpen}
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
    >
      <TeamTile size={16} team={source.team} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={styles.chipText}
      >
        {words}
      </AppText>
      <Symbol name="chevron.right" size={11} tint={color.muted} weight="semibold" />
    </Pressable>
  );
}

/**
 * Above a team task's composer: who will see what the agent posts. Messages
 * typed here stay private; only the agent's reply reaches the channel.
 */
export function AudienceLine(props: {
  /** "Replies post to #support in Acme, where 12 people can see them." */
  readonly text: string;
}): ReactNode {
  return (
    <View style={styles.audience}>
      <Symbol name="person.2" size={13} tint={color.muted} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={2}
        role="caption"
        style={styles.audienceText}
        tone="muted"
      >
        {props.text}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  audience: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: space[6],
    paddingHorizontal: space[16],
  },
  audienceText: { flexShrink: 1, textAlign: "center" },
  chip: {
    ...material.control,
    alignItems: "center",
    alignSelf: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    maxWidth: "90%",
    minHeight: 28,
    paddingLeft: space[6],
    paddingRight: space[10],
  },
  chipGone: { ...material.plate, borderStyle: "dashed" },
  chipPressed: { ...material.platePressed },
  chipText: { color: color.textSoft, flexShrink: 1, fontWeight: "500" },
  faded: { opacity: 0.45 },
  label: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: space[4] },
  place: { color: color.textSoft, flexShrink: 1 },
  placeGone: { color: color.mutedDim, flexShrink: 1 },
});
