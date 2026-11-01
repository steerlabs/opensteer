import {
  formatMoment,
  formatRelativeTime,
  sameTaskFamily,
  sameTaskMark,
  taskFamily,
  threadMark,
  type FamilyTask,
  type HostClient,
  type HostSnapshot,
  type ThreadAutomation,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { isRecord } from "@opensteer/shared/isRecord";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { memo, useCallback, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { surfaceRoute } from "../browser/surface-route.js";
import { color, space, touchTarget } from "../theme.js";
import { ChatOrb } from "../ui/chat-orb.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { useContentInsets } from "../ui/pane.js";
import { AppText, Notice } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import {
  aroundFrom,
  aroundPlaces,
  sameAroundPlaces,
  sameRequesterLink,
  type AroundPlace,
} from "./around-model.js";
import { TaskStatus } from "./task-status.js";

export type AroundScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly threadId: string;
}>;

/**
 * Around this thread: the conversation it works for, the places it has open,
 * the tasks it handed out and its schedules, in that order, each section only
 * while it has something in it. A row opens exactly what it names, over the
 * conversation rather than inside this sheet, so Back from it returns there.
 *
 * It reads the Host live, so a task that finishes or a tab that closes while
 * the sheet is open changes here too.
 */
export function AroundScreen(props: AroundScreenProps): ReactNode {
  const { deploymentId, threadId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return <Unavailable />;
  }
  return (
    <Around deploymentId={deploymentId} hostClient={selection.hostClient} threadId={threadId} />
  );
}

function Around(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly threadId: string;
}): ReactNode {
  const { deploymentId, hostClient, threadId } = props;
  const navigation = useNavigation();
  const from = useHostSelector(
    hostClient,
    useCallback((snapshot: HostSnapshot) => aroundFrom(snapshot, threadId), [threadId]),
    sameRequesterLink,
  );
  const fromMark = useHostSelector(
    hostClient,
    useCallback(
      (snapshot: HostSnapshot) =>
        from === null || from.threadId === snapshot.homeThreadId
          ? null
          : threadMark(from.threadId, snapshot),
      [from],
    ),
    sameTaskMark,
  );
  const places = useHostSelector(
    hostClient,
    useCallback((snapshot: HostSnapshot) => aroundPlaces(snapshot, threadId), [threadId]),
    sameAroundPlaces,
  );
  const family = useHostSelector(
    hostClient,
    useCallback((snapshot: HostSnapshot) => taskFamily(snapshot, threadId), [threadId]),
    sameTaskFamily,
  );
  const tasks = family.running.length + family.earlier.length;
  const otherSections =
    places.length > 0 || family.running.length > 0 || family.automations.length > 0;
  const [expanded, setExpanded] = useState(false);
  const [all, setAll] = useState(false);
  const earlierOpen = !otherSections || expanded;

  const openPlace = useCallback(
    (place: AroundPlace) => {
      navigation.goBack();
      navigation.dispatch(
        StackActions.push(
          "WorkspaceBrowser",
          surfaceRoute(deploymentId, threadId, place.destination),
        ),
      );
    },
    [deploymentId, navigation, threadId],
  );
  const openSchedule = useCallback(
    (triggerId: string) => {
      navigation.goBack();
      navigation.dispatch(StackActions.push("Schedule", { deploymentId, triggerId }));
    },
    [deploymentId, navigation],
  );
  // Chat is the root under every stack, so it is returned to; a conversation
  // directly under this one is gone back to rather than opened a second time.
  const openThread = useCallback(
    (id: string) => {
      if (id === hostClient.getSnapshot().homeThreadId) {
        navigation.dispatch(StackActions.popTo("Home", { deploymentId }));
        return;
      }
      const under = navigation.getState()?.routes.at(-3);
      if (
        under?.name === "Thread" &&
        isRecord(under.params) &&
        under.params["deploymentId"] === deploymentId &&
        under.params["threadId"] === id
      ) {
        navigation.dispatch(StackActions.pop(2));
        return;
      }
      navigation.goBack();
      navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId: id }));
    },
    [deploymentId, hostClient, navigation],
  );

  return (
    <Frame>
      {from === null ? null : (
        <Pressable
          accessibilityLabel={`From ${from.title}`}
          accessibilityHint="Opens the conversation this task works for"
          accessibilityRole="button"
          onPress={() => openThread(from.threadId)}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          {fromMark === null ? <ChatOrb size={20} /> : <TaskMark mark={fromMark} />}
          <View style={styles.words}>
            <AppText role="caption" tone="muted">
              From
            </AppText>
            <AppText numberOfLines={1} role="bodyMedium">
              {from.title}
            </AppText>
          </View>
          <Symbol name="arrow.up" size={15} tint={color.muted} />
        </Pressable>
      )}
      {places.length > 0 ? (
        <>
          <Section title="Places" count={places.length} />
          {places.map((place) => (
            <PlaceRow key={place.key} place={place} onOpen={openPlace} />
          ))}
        </>
      ) : null}
      {tasks > 0 ? (
        <>
          <Section title="Tasks" count={tasks} />
          {family.running.map((task) => (
            <TaskRow key={task.threadId} task={task} onOpen={openThread} />
          ))}
          {family.earlier.length > 0 ? (
            <>
              {otherSections ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Earlier · ${family.earlier.length}`}
                  accessibilityState={{ expanded: earlierOpen }}
                  onPress={() => setExpanded(!expanded)}
                  style={styles.subsection}
                >
                  <AppText role="caption" tone="muted">
                    Earlier · {family.earlier.length}
                  </AppText>
                  <Symbol
                    name={earlierOpen ? "chevron.up" : "chevron.down"}
                    size={12}
                    tint={color.muted}
                  />
                </Pressable>
              ) : null}
              {earlierOpen ? (
                <>
                  {(all ? family.earlier : family.earlier.slice(0, 4)).map((task) => (
                    <TaskRow key={task.threadId} task={task} onOpen={openThread} />
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
        </>
      ) : null}
      {family.automations.length > 0 ? (
        <>
          <Section title="Schedules" count={family.automations.length} />
          {family.automations.map((automation) => (
            <ScheduleRow key={automation.id} automation={automation} onOpen={openSchedule} />
          ))}
        </>
      ) : null}
      {from === null && places.length === 0 && tasks === 0 && family.automations.length === 0 ? (
        <AppText role="secondary" tone="muted" style={styles.empty}>
          Nothing is around this conversation now.
        </AppText>
      ) : null}
    </Frame>
  );
}

function Frame(props: { readonly children: ReactNode }): ReactNode {
  const insets = useContentInsets();
  return (
    <ScrollView
      contentContainerStyle={{
        paddingBottom: insets.bottom + space[24],
        paddingLeft: insets.left,
        paddingRight: insets.right,
        paddingTop: space[24],
      }}
      style={styles.sheet}
    >
      <AppText role="title" style={styles.heading}>
        Around this thread
      </AppText>
      {props.children}
    </ScrollView>
  );
}

function Section(props: { readonly title: string; readonly count: number }): ReactNode {
  return (
    <View accessibilityRole="header" style={styles.section}>
      <AppText role="caption" tone="muted">
        {props.title} · {props.count}
      </AppText>
    </View>
  );
}

const placeKind = { globe: "Page", laptopcomputer: "Mac app", smartphone: "Phone" } as const;

const PlaceRow = memo(function PlaceRow(props: {
  readonly place: AroundPlace;
  readonly onOpen: (place: AroundPlace) => void;
}): ReactNode {
  const { place } = props;
  return (
    <Pressable
      accessibilityLabel={[
        placeKind[place.glyph],
        place.title,
        place.detail,
        place.working && "agent working",
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityRole="button"
      onPress={() => props.onOpen(place)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Symbol name={place.glyph} size={18} tint={place.working ? color.green : color.textSoft} />
      <View style={styles.words}>
        <AppText numberOfLines={1} role="bodyMedium">
          {place.title}
        </AppText>
        {place.detail === null ? null : (
          <AppText numberOfLines={1} role="caption" tone="muted">
            {place.detail}
          </AppText>
        )}
      </View>
      {place.working ? <TaskStatus moving tone="working" word="Working" /> : null}
    </Pressable>
  );
});

const TaskRow = memo(function TaskRow(props: {
  readonly task: FamilyTask;
  readonly onOpen: (id: string) => void;
}): ReactNode {
  const { task } = props;
  const word = task.needsYou ? "Needs you" : task.word;
  const time = task.finishedAt === null ? null : formatRelativeTime(task.finishedAt);
  return (
    <Pressable
      accessibilityLabel={[task.title, word, task.detail, time].filter(Boolean).join(", ")}
      accessibilityRole="button"
      onPress={() => props.onOpen(task.threadId)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
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
});

const ScheduleRow = memo(function ScheduleRow(props: {
  readonly automation: ThreadAutomation;
  readonly onOpen: (triggerId: string) => void;
}): ReactNode {
  const { automation } = props;
  const detail = automationDetail(automation);
  return (
    <Pressable
      accessibilityHint="Opens the schedule"
      accessibilityLabel={`${automation.name}, ${detail}`}
      accessibilityRole="button"
      onPress={() => props.onOpen(automation.id)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Symbol
        name={
          automation.paused
            ? "pause"
            : automation.kind === "watch"
              ? "eye"
              : automation.kind === "webhook"
                ? "bolt"
                : "clock"
        }
        tint={color.muted}
      />
      <View style={styles.words}>
        <AppText numberOfLines={1} role="bodyMedium">
          {automation.name}
        </AppText>
        <AppText numberOfLines={1} role="caption" tone="muted">
          {detail}
        </AppText>
      </View>
    </Pressable>
  );
});

/** The schedule's next step in the same words its own screen uses. */
function automationDetail(automation: ThreadAutomation): string {
  if (automation.paused) return "Paused";
  if (automation.kind === "watch") return "Watching";
  if (automation.kind === "webhook") return "When called";
  return automation.nextFireAt === null
    ? "Scheduled"
    : `Next ${formatMoment(automation.nextFireAt, Date.now(), true)}`;
}

function Unavailable(): ReactNode {
  const navigation = useNavigation();
  return (
    <View style={[styles.sheet, styles.unavailable]}>
      <Notice
        action={{ label: "Close", onPress: () => navigation.goBack() }}
        detail="This deployment is no longer open."
        title="This can't be shown"
        tone="neutral"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: color.surfaceElevated, flex: 1 },
  unavailable: { justifyContent: "center", padding: space[24] },
  heading: { paddingBottom: space[8], paddingHorizontal: space[16] },
  section: { paddingHorizontal: space[16], paddingTop: space[24], paddingBottom: space[8] },
  subsection: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[4],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
    paddingVertical: space[12],
  },
  pressed: { backgroundColor: color.surfacePressed },
  words: { flex: 1, gap: space[4] },
  state: { alignItems: "flex-end", gap: space[4] },
  empty: { paddingHorizontal: space[16], paddingTop: space[16] },
});
