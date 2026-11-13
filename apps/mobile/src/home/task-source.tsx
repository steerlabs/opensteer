import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
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

const styles = StyleSheet.create({
  label: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: space[4] },
  place: { color: color.textSoft, flexShrink: 1 },
  placeGone: { color: color.mutedDim, flexShrink: 1 },
});
