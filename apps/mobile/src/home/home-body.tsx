import { memo, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { ComposerDockLayout } from "../thread/composer-dock.js";
import { NeedsYouTag, UnreadDot } from "../threads/task-row.js";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import type {
  FolderSectionView,
  HomeTaskRowView,
  NeedsYouCardView,
  TaskTone,
} from "./home-models.js";
import { NeedsYouCard, type NeedsYouActions } from "./needs-you.js";
import { TaskSourceLabel } from "./task-source.js";

export interface HomeActions extends NeedsYouActions {
  readonly onOpenTask: (taskId: string) => void;
  readonly onFoldFolder: (folderId: string, folded: boolean) => void;
  /** Starts a task in this folder: the composer opens with its chip set. */
  readonly onNewTaskIn: (folderId: string) => void;
  readonly onMoreInFolder: (folderId: string) => void;
  readonly onSeeAllNeedsYou: () => void;
  readonly onOpenDone: () => void;
  readonly onSuggestion: (text: string) => void;
}

/** A first run: no tasks yet, and maybe no AI account to run one. */
export interface FirstRunView {
  /** "Your agent works on this Mac, in folders you choose." */
  readonly subtitle: string;
  /** Present until an AI account is connected. */
  readonly connectAccount: { readonly label: string; readonly onPress: () => void } | null;
  readonly suggestions: readonly { readonly label: string; readonly text: string }[];
}

/**
 * Home: the reader's agent and their tasks. Needs you first (only when
 * something does), then tasks grouped by the folder they work in, Agent home
 * first, then Done. The new-task composer floats over the foot of the list.
 * With no tasks yet it is the first-run page: what the agent is, and a few
 * things to ask.
 */
export function HomeBody(props: {
  readonly actions: HomeActions;
  readonly composer: ReactNode;
  readonly done: number;
  readonly firstRun: FirstRunView | null;
  readonly folders: readonly FolderSectionView[];
  readonly needsYou: readonly NeedsYouCardView[];
  /** Questions past the ones shown. */
  readonly moreNeedsYou: number;
}): ReactNode {
  const { actions } = props;
  return (
    <ComposerDockLayout avoidKeyboard dock={props.composer}>
      {(clearance) =>
        props.firstRun !== null ? (
          <FirstRun actions={actions} clearance={clearance} firstRun={props.firstRun} />
        ) : (
          <ScrollView
            contentContainerStyle={[styles.content, { paddingBottom: clearance + space[16] }]}
            keyboardDismissMode="interactive"
          >
            {props.needsYou.length === 0 ? null : (
              <View style={styles.needs}>
                <SectionHead
                  label="Needs you"
                  trailing={
                    props.moreNeedsYou > 0 ? (
                      <Pressable
                        accessibilityRole="button"
                        hitSlop={10}
                        onPress={actions.onSeeAllNeedsYou}
                      >
                        <AppText role="caption" style={styles.seeAll}>
                          See all {props.needsYou.length + props.moreNeedsYou}
                        </AppText>
                      </Pressable>
                    ) : null
                  }
                />
                {props.needsYou.map((card) => (
                  <NeedsYouCard actions={actions} card={card} key={card.id} />
                ))}
              </View>
            )}
            {props.folders.map((folder) => (
              <FolderSection actions={actions} folder={folder} key={folder.id} />
            ))}
            {props.done > 0 ? (
              <Pressable
                accessibilityLabel={`Done, ${props.done} tasks`}
                accessibilityRole="button"
                onPress={actions.onOpenDone}
                style={({ pressed }) => [styles.done, pressed && styles.pressed]}
              >
                <Symbol name="checkmark.circle" size={18} tint={color.muted} />
                <AppText role="secondary" style={styles.doneLabel} tone="muted">
                  Done
                </AppText>
                <AppText role="caption" style={styles.count}>
                  {props.done}
                </AppText>
              </Pressable>
            ) : null}
          </ScrollView>
        )
      }
    </ComposerDockLayout>
  );
}

function SectionHead(props: { readonly label: string; readonly trailing?: ReactNode }): ReactNode {
  return (
    <View style={styles.sectionHead}>
      <AppText role="secondaryMedium" style={styles.sectionLabel} tone="muted">
        {props.label}
      </AppText>
      {props.trailing ?? null}
    </View>
  );
}

const FolderSection = memo(function FolderSection(props: {
  readonly actions: HomeActions;
  readonly folder: FolderSectionView;
}): ReactNode {
  const { actions, folder } = props;
  return (
    <View style={styles.folder}>
      <View style={styles.folderHead}>
        <Pressable
          accessibilityHint={folder.folded ? "Shows its tasks" : "Hides its tasks"}
          accessibilityLabel={`${folder.label}, ${folder.detail}${folder.folded ? `, ${folder.count} tasks` : ""}`}
          accessibilityRole="button"
          accessibilityState={{ expanded: !folder.folded }}
          onPress={() => actions.onFoldFolder(folder.id, !folder.folded)}
          style={({ pressed }) => [styles.folderMain, pressed && styles.pressed]}
        >
          <Symbol name={folder.home ? "house" : "folder"} size={15} tint={color.muted} />
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="secondaryMedium"
            style={styles.folderLabel}
            tone="muted"
          >
            {folder.label}
          </AppText>
          {folder.folded ? (
            <>
              {folder.loudest === null ? null : <LoudestMark tone={folder.loudest} />}
              <AppText role="caption" style={styles.count}>
                {folder.count}
              </AppText>
              <Symbol name="chevron.right" size={11} tint={color.muted} weight="semibold" />
            </>
          ) : (
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="caption"
              style={styles.folderDetail}
            >
              {folder.detail}
            </AppText>
          )}
        </Pressable>
        <Pressable
          accessibilityLabel={`New task in ${folder.label}`}
          accessibilityRole="button"
          hitSlop={4}
          onPress={() => actions.onNewTaskIn(folder.id)}
          style={({ pressed }) => [styles.folderPlus, pressed && styles.pressed]}
        >
          <Symbol name="plus" size={14} tint={color.muted} />
        </Pressable>
      </View>
      {folder.folded
        ? null
        : folder.tasks.map((task) => (
            <HomeTaskRow key={task.id} onOpen={actions.onOpenTask} task={task} />
          ))}
      {!folder.folded && folder.more > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => actions.onMoreInFolder(folder.id)}
          style={({ pressed }) => [styles.more, pressed && styles.pressed]}
        >
          <AppText role="caption" tone="muted">
            {folder.more} more
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
});

/** A folded folder's loudest state: needs you, then working, then failed, then unread. */
function LoudestMark(props: { readonly tone: TaskTone }): ReactNode {
  switch (props.tone) {
    case "needs-you":
      return <NeedsYouTag />;
    case "working":
      return <ActivityIndicator color={color.ember} size="small" style={styles.spinner} />;
    case "failed":
      return <Symbol name="exclamationmark.circle" size={14} tint={color.red} />;
    case "finished":
      return <UnreadDot />;
    default:
      return null;
  }
}

/**
 * A task on Home: richer than the drawer's row. Its second line is the ask
 * when it needs the reader, otherwise its live step or outcome, led by the
 * team and channel it came from when a thread started it.
 */
export const HomeTaskRow = memo(
  function HomeTaskRow(props: {
    readonly onOpen: (taskId: string) => void;
    readonly task: HomeTaskRowView;
  }): ReactNode {
    const { task } = props;
    const reducedMotion = useReducedMotion();
    const needsYou = task.tone === "needs-you";
    const second = task.line !== null || task.source !== null;
    return (
      <Pressable
        accessibilityHint="Opens this task"
        accessibilityLabel={[
          task.title,
          task.source?.place,
          task.line,
          task.unread ? "unread" : null,
        ]
          .filter(Boolean)
          .join(", ")}
        accessibilityRole="button"
        onPress={() => props.onOpen(task.id)}
        style={({ pressed }) => [styles.task, pressed && styles.pressed]}
      >
        <View style={second ? styles.taskMarkTop : undefined}>
          <TaskMark mark={task.mark} quiet={task.tone === "finished" && !task.unread} />
        </View>
        <View style={styles.taskWords}>
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="secondary"
            style={
              needsYou
                ? styles.titleStrong
                : task.unread
                  ? styles.titleBright
                  : task.tone === "finished"
                    ? styles.titleQuiet
                    : styles.title
            }
          >
            {task.title}
          </AppText>
          {second ? (
            <View style={styles.secondLine}>
              {task.source === null || needsYou ? null : <TaskSourceLabel source={task.source} />}
              {task.line === null ? null : (
                <AppText
                  maxFontSizeMultiplier={controlFontScaleLimit}
                  numberOfLines={1}
                  role="caption"
                  style={[
                    styles.line,
                    needsYou ? styles.lineAsk : task.tone === "failed" ? styles.lineFailed : null,
                  ]}
                >
                  {task.source === null || needsYou ? task.line : `· ${task.line}`}
                </AppText>
              )}
            </View>
          ) : null}
        </View>
        <View style={styles.state}>
          {needsYou ? (
            <NeedsYouTag />
          ) : task.tone === "working" ? (
            reducedMotion ? (
              <Symbol name="circle.dotted" size={16} tint={color.ember} />
            ) : (
              <ActivityIndicator color={color.ember} size="small" style={styles.spinner} />
            )
          ) : task.tone === "waiting" ? (
            <AppText role="caption" tone="muted">
              Waiting
            </AppText>
          ) : null}
          {task.unread && !needsYou ? <UnreadDot /> : null}
          {task.time !== null && task.tone === "finished" ? (
            <AppText role="caption" style={styles.time}>
              {task.time}
            </AppText>
          ) : null}
        </View>
      </Pressable>
    );
  },
  (left, right) =>
    left.onOpen === right.onOpen &&
    left.task.id === right.task.id &&
    left.task.version === right.task.version,
);

function FirstRun(props: {
  readonly actions: HomeActions;
  readonly clearance: number;
  readonly firstRun: FirstRunView;
}): ReactNode {
  const { firstRun } = props;
  return (
    <ScrollView
      contentContainerStyle={[styles.firstRun, { paddingBottom: props.clearance + space[24] }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.hero}>
        <AppText role="displayLarge" style={styles.heroTitle}>
          What should your agent do?
        </AppText>
        <AppText role="secondary" style={styles.heroText} tone="muted">
          {firstRun.subtitle}
        </AppText>
        {firstRun.connectAccount === null ? null : (
          <Pressable
            accessibilityLabel={firstRun.connectAccount.label}
            accessibilityRole="button"
            onPress={firstRun.connectAccount.onPress}
            style={({ pressed }) => [styles.connect, pressed && styles.connectPressed]}
          >
            <AppText role="secondaryMedium" style={styles.connectLabel}>
              {firstRun.connectAccount.label}
            </AppText>
          </Pressable>
        )}
      </View>
      <View style={styles.suggestions}>
        {firstRun.suggestions.map((suggestion) => (
          <Pressable
            accessibilityHint="Puts this in the composer"
            accessibilityRole="button"
            key={suggestion.label}
            onPress={() => props.actions.onSuggestion(suggestion.text)}
            style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
          >
            <AppText role="secondaryMedium">{suggestion.label}</AppText>
            <AppText numberOfLines={2} role="caption" tone="muted">
              {suggestion.text}
            </AppText>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  connect: {
    ...material.accent,
    alignItems: "center",
    alignSelf: "center",
    borderRadius: radius.full,
    justifyContent: "center",
    marginTop: space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[20],
  },
  connectLabel: { color: color.inkOnEmber, fontWeight: "600" },
  connectPressed: { ...material.accentPressed },
  content: { paddingHorizontal: space[8], paddingTop: space[4] },
  count: { color: color.mutedDim, fontVariant: ["tabular-nums"] },
  done: {
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[12],
    marginTop: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
  doneLabel: { flex: 1 },
  firstRun: { flexGrow: 1, gap: space[24], justifyContent: "center", paddingHorizontal: space[20] },
  folder: { marginTop: space[12] },
  folderDetail: { color: color.mutedDim, flexShrink: 1, marginLeft: "auto" },
  folderHead: { alignItems: "center", flexDirection: "row" },
  folderLabel: { flexShrink: 1 },
  folderMain: {
    alignItems: "center",
    borderRadius: radius.md,
    flex: 1,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget - 8,
    paddingLeft: space[12],
    paddingRight: space[4],
  },
  folderPlus: {
    alignItems: "center",
    borderRadius: radius.full,
    height: touchTarget - 8,
    justifyContent: "center",
    width: touchTarget - 8,
  },
  hero: { alignItems: "center", gap: space[10] },
  heroText: { maxWidth: 320, textAlign: "center" },
  heroTitle: { textAlign: "center" },
  line: { color: color.muted, flexShrink: 1 },
  lineAsk: { color: color.amber },
  lineFailed: { color: color.red },
  more: {
    justifyContent: "center",
    minHeight: touchTarget - 8,
    paddingLeft: space[12] + 20 + space[12],
  },
  needs: { gap: space[8], paddingHorizontal: space[4] },
  pressed: { ...material.quiet },
  secondLine: { alignItems: "center", flexDirection: "row", gap: space[4], minWidth: 0 },
  sectionHead: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: space[8],
    paddingTop: space[8],
  },
  sectionLabel: { flexShrink: 1 },
  seeAll: { color: color.ember, fontWeight: "600" },
  spinner: { transform: [{ scale: 0.8 }] },
  state: { alignItems: "center", flexDirection: "row", flexShrink: 0, gap: space[8] },
  suggestion: { ...material.plate, borderRadius: radius.lg, gap: 2, padding: space[14] },
  suggestionPressed: { ...material.platePressed },
  suggestions: { gap: space[8] },
  task: {
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[12],
    minHeight: Platform.OS === "android" ? 52 : 48,
    paddingHorizontal: space[12],
    paddingVertical: space[6],
  },
  taskMarkTop: { alignSelf: "flex-start", paddingTop: 3 },
  taskWords: { flex: 1, gap: 1, minWidth: 0 },
  time: { color: color.mutedDim, fontVariant: ["tabular-nums"] },
  title: { color: color.textSoft },
  titleBright: { color: color.text },
  titleQuiet: { color: color.muted },
  titleStrong: { color: color.text, fontWeight: "600" },
});
