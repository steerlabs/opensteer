import type { PlaceAgent } from "@opensteer/client/host";
import { memo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, radius } from "../theme.js";
import { AgentOrb } from "../team/team-marks.js";
import { TaskMark } from "../ui/task-mark.js";

/** Marks drawn side by side before the rest are only counted in words. */
const shownMarks = 3;

/**
 * Who is in a place, as overlapping marks: each task's mark, Chat's orb, a
 * green ring on whoever is acting now. Marks are pictures of the words beside
 * them, so they are silent to a screen reader.
 */
export const AgentMarks = memo(function AgentMarks(props: {
  readonly agents: readonly PlaceAgent[];
  readonly size?: 16 | 20;
}): ReactNode {
  const size = props.size ?? 20;
  if (props.agents.length === 0) return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.marks}
    >
      {props.agents.slice(0, shownMarks).map((agent, index) => (
        <View
          key={agent.threadId}
          style={[
            styles.mark,
            index > 0 && { marginStart: -size / 3 },
            agent.acting && {
              borderColor: color.green,
              borderRadius: agent.home ? radius.full : radius.sm,
            },
          ]}
        >
          {agent.home || agent.mark === null ? (
            <AgentOrb size={size} />
          ) : (
            <TaskMark mark={agent.mark} size={size} />
          )}
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  mark: { borderColor: "transparent", borderWidth: 1.5, padding: 1 },
  marks: { alignItems: "center", flexDirection: "row" },
});
