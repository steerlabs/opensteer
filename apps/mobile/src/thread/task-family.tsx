import {
  formatRelativeTime,
  sameTaskFamily,
  taskFamily,
  type FamilyTask,
  type HostClient,
  type TaskFamilyGlance,
  type ThreadAutomation,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, headerFontScaleLimit, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { TaskStatus } from "./task-status.js";

export function familyLabel(glance: TaskFamilyGlance): string {
  return [
    `${glance.running} ${glance.running === 1 ? "task" : "tasks"} running`,
    ...(glance.needsYou ? ["Needs you"] : []),
    ...(glance.automations > 0
      ? [`${glance.automations} ${glance.automations === 1 ? "automation" : "automations"}`]
      : []),
    ...(glance.running === 0 && glance.automations === 0 ? [`${glance.earlier} earlier`] : []),
  ].join(", ");
}

export function familyCount(glance: TaskFamilyGlance): string {
  return [
    String(glance.running || (glance.automations === 0 ? glance.earlier : 0)),
    ...(glance.automations > 0 ? [`◷ ${glance.automations}`] : []),
  ].join(" · ");
}

export function FamilyButton(props: {
  readonly glance: TaskFamilyGlance;
  readonly onPress: () => void;
}): ReactNode {
  const tint = props.glance.needsYou
    ? color.amber
    : props.glance.running > 0
      ? color.text
      : color.muted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={familyLabel(props.glance)}
      accessibilityHint="Opens this conversation's tasks and automations"
      onPress={props.onPress}
      style={styles.button}
    >
      <View style={styles.marks}>
        {props.glance.marks.length === 0 ? (
          <Symbol name="arrow.triangle.branch" size={18} tint={tint} />
        ) : (
          props.glance.marks.map((mark, index) => (
            <View key={index} style={{ marginLeft: index === 0 ? 0 : -8 }}>
              <TaskMark mark={mark} size={16} />
            </View>
          ))
        )}
      </View>
      <AppText role="caption" maxFontSizeMultiplier={headerFontScaleLimit} style={{ color: tint }}>
        {familyCount(props.glance)}
      </AppText>
    </Pressable>
  );
}

/** Mounted only while open: transcript changes never build hidden family rows. */
export function TaskFamilySheet(props: {
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly onClose: () => void;
  readonly onOpenThread: (id: string) => void;
}): ReactNode {
  const family = useHostSelector(
    props.hostClient,
    (snapshot) => taskFamily(snapshot, props.threadId),
    sameTaskFamily,
  );
  const otherSections = family.running.length > 0 || family.automations.length > 0;
  const [expanded, setExpanded] = useState(false);
  const [all, setAll] = useState(false);
  const earlierOpen = !otherSections || expanded;
  const openChild = (id: string) => {
    props.onClose();
    props.onOpenThread(id);
  };
  return (
    <Sheet open title="Tasks" onClose={props.onClose}>
      {family.running.length > 0 ? (
        <>
          <Section title="Running" count={family.running.length} />
          {family.running.map((task) => (
            <Child key={task.threadId} task={task} onOpen={openChild} />
          ))}
        </>
      ) : null}
      {family.automations.length > 0 ? (
        <>
          <Section title="Automations" count={family.automations.length} />
          {family.automations.map((automation) => {
            const detail = automationDetail(automation);
            return (
              <View
                key={automation.id}
                accessible
                accessibilityRole="text"
                accessibilityLabel={`${automation.name}, ${detail}`}
                style={styles.row}
              >
                <Symbol
                  name={
                    automation.kind === "schedule"
                      ? "clock"
                      : automation.kind === "watch"
                        ? "circle.dotted"
                        : "bolt"
                  }
                  tint={color.muted}
                />
                <View style={styles.words}>
                  <AppText role="bodyMedium">{automation.name}</AppText>
                  <AppText role="caption" tone="muted">
                    {detail}
                  </AppText>
                </View>
              </View>
            );
          })}
        </>
      ) : null}
      {family.earlier.length > 0 ? (
        <>
          {otherSections ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Earlier · ${family.earlier.length}`}
              accessibilityState={{ expanded: earlierOpen }}
              onPress={() => setExpanded(!expanded)}
            >
              <Section title="Earlier" count={family.earlier.length} />
            </Pressable>
          ) : (
            <Section title="Earlier" count={family.earlier.length} />
          )}
          {earlierOpen ? (
            <>
              {(all ? family.earlier : family.earlier.slice(0, 4)).map((task) => (
                <Child key={task.threadId} task={task} onOpen={openChild} />
              ))}
              {!all && family.earlier.length > 4 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Show all"
                  onPress={() => setAll(true)}
                  style={styles.row}
                >
                  <AppText role="bodyMedium" tone="muted">
                    Show all
                  </AppText>
                </Pressable>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

function Section(props: { readonly title: string; readonly count: number }): ReactNode {
  return (
    <View style={styles.section}>
      <AppText role="caption" tone="muted">
        {props.title} · {props.count}
      </AppText>
    </View>
  );
}

function Child(props: {
  readonly task: FamilyTask;
  readonly onOpen: (id: string) => void;
}): ReactNode {
  const { task } = props;
  const word = task.needsYou ? "Needs you" : task.word;
  const time = task.finishedAt === null ? null : formatRelativeTime(task.finishedAt);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[task.title, word, task.detail, time].filter(Boolean).join(", ")}
      onPress={() => props.onOpen(task.threadId)}
      style={styles.row}
    >
      <TaskMark mark={task.mark} />
      <View style={styles.words}>
        <AppText role="bodyMedium" numberOfLines={1}>
          {task.title}
        </AppText>
        {task.detail === null ? null : (
          <AppText role="caption" tone="muted" numberOfLines={1}>
            {task.detail}
          </AppText>
        )}
      </View>
      <View style={styles.state}>
        <TaskStatus moving={task.moving} tone={task.needsYou ? "waiting" : task.tone} word={word} />
        {time === null ? null : (
          <AppText role="caption" tone="muted">
            {time}
          </AppText>
        )}
      </View>
    </Pressable>
  );
}

function automationDetail(automation: ThreadAutomation): string {
  if (automation.paused) return "Paused";
  if (automation.kind === "watch") return "Watching";
  if (automation.kind === "webhook") return "On webhook";
  return automation.nextFireAt === null
    ? "Scheduled"
    : new Date(automation.nextFireAt).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

const styles = StyleSheet.create({
  button: { flexDirection: "row", alignItems: "center", gap: space[4], minHeight: touchTarget },
  marks: { flexDirection: "row", alignItems: "center" },
  section: { paddingHorizontal: space[16], paddingTop: space[24], paddingBottom: space[8] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
    paddingVertical: space[12],
  },
  words: { flex: 1, gap: space[4] },
  state: { alignItems: "flex-end", gap: space[4] },
});
