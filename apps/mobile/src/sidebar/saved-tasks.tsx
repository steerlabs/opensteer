import { taskMark, type SavedTask } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { View } from "react-native";
import { space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { TaskMark } from "../ui/task-mark.js";

/** Historical group and subject only: no navigation, mutation, attention or status badge. */
export function SavedTasks(props: {
  readonly tasks: readonly SavedTask[];
  readonly label: string;
  readonly capturedAt: string;
}): ReactNode {
  return (
    <View
      accessibilityLabel={`Saved view, last updated ${props.capturedAt}.`}
      style={{ gap: space[8] }}
    >
      <AppText role="caption" tone="muted">
        {props.label}
      </AppText>
      {(["working", "ready", "done"] as const).map((group) => {
        const tasks = props.tasks.filter((task) => task.group === group);
        return tasks.length ? (
          <View key={group} style={{ gap: space[8] }}>
            <AppText role="caption" tone="muted">
              {group === "working"
                ? "Last seen Working"
                : group === "ready"
                  ? "Last seen Ready"
                  : "Last seen Done"}
            </AppText>
            {tasks.map((task) => (
              <View
                key={task.id}
                accessibilityLabel={`${task.title}, last seen ${group}`}
                style={{
                  alignItems: "center",
                  flexDirection: "row",
                  gap: space[12],
                  paddingVertical: space[8],
                }}
              >
                <TaskMark mark={taskMark(task.glyph)} quiet={group === "done"} />
                <AppText role="secondary" numberOfLines={1} style={{ flex: 1 }}>
                  {task.title}
                </AppText>
              </View>
            ))}
          </View>
        ) : null;
      })}
    </View>
  );
}
