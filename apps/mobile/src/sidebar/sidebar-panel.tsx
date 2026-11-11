import Animated from "react-native-reanimated";
import { move } from "../ui/motion.js";
import { SavedTasks } from "./saved-tasks.js";
import { CHAT_THREAD_TITLE } from "@opensteer/core";
import {
  doneTaskList,
  folderSignalWords,
  groupTasksByProject,
  listedRowThreadId,
  mainWorkspace,
  projectStatusLabel,
  quietlyMoved,
  quietSeenScope,
  sameTaskListSource,
  taskList,
  taskRowLabel,
  taskTime,
  type DoneTaskList,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type ProjectFolder,
  type ProjectGrouping,
  type TaskList,
  type TaskRow,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import {
  useBrowserGroups,
  usePlace,
  usePlaceSlots,
  useSyncingPlaceholder,
  VoiceContext,
} from "@opensteer/client/react";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextInstance,
  View,
} from "react-native";
import { ActingDot, agentWorkingLabel } from "../browser/acting-dot.js";
import { opensteerAppGlyph } from "../browser/agent-surface.js";
import { tabSiteLabel } from "../browser/site-label.js";
import { operationDetail } from "../client/mobile-client.js";
import {
  noDrafts,
  sameDraftSummary,
  type DraftSummary,
  type NewTaskDraftSummary,
} from "../client/thread-drafts.js";
import { sidebarBottom, sidebarTop } from "../layout.js";
import { statusTone } from "../screens/deployment-row.js";
import {
  color,
  material,
  controlFontScaleLimit,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { DeploymentMarkView } from "../threads/deployment-mark.js";
import {
  deploymentIdentity,
  sameDeploymentIdentity,
  type DeploymentIdentity,
} from "../threads/deployment-identity.js";
import { discardNewTaskDraft } from "../thread/draft-attachments.js";
import {
  DraftPen,
  draftPenLabel,
  NeedsYouTag,
  setTaskDone,
  taskTextInset,
  TaskRowView,
  UnreadDot,
  type TaskShelf,
} from "../threads/task-row.js";
import {
  useHostUserId,
  useMobileClient,
  useMobileState,
  useSavedSurface,
} from "../ui/mobile-client-context.js";
import { ChatOrb } from "../ui/chat-orb.js";
import { useContentInsets } from "../ui/pane.js";
import { useRetainedScroll, type ScrollMemory } from "../ui/retained-scroll.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { WorkspaceMark } from "../ui/workspace-mark.js";
import { CallTimer } from "../voice/call-timer.js";
import { useVoiceAvailable, useVoiceOn } from "../voice/use-voice-value.js";
import { DraftRow } from "./draft-row.js";
import { sidebarFolders, type SidebarFolder } from "./project-folders.js";
import { voiceRowMark, type VoiceRowMark } from "./voice-row.js";
import { CreateProjectGate } from "../team/team-parts.js";

/** The root destinations the sidebar switches between. */
export type SidebarDestination = "Home" | "Schedules" | "Projects" | "Tabs";

export interface SidebarActions {
  /** Closes the sidebar and hands focus back to whatever opened it. */
  readonly close: () => void;
  readonly onChat: () => void;
  readonly onNewProject: (deploymentId: string) => void;
  readonly onNewTask: (deploymentId: string, workspaceId: string) => void;
  /** Exactly this unfinished new task, with everything it held. */
  readonly onOpenDraft: (deploymentId: string, workspaceId: string, draftId: string) => void;
  /** The Done page: every task put in Done outside Projects. */
  readonly onOpenDone: (deploymentId: string) => void;
  /** The sheet naming the tasks just moved to Done for the reader. */
  readonly onOpenQuietlyMoved: (deploymentId: string) => void;
  /** A Project's own page: its chat, tasks and settings. */
  readonly onOpenProject: (deploymentId: string, workspaceId: string) => void;
  /** Shows exactly this tab, app or phone, alone. */
  readonly onOpenPlace: (destination: WorkspaceSurfaceDestination) => void;
  readonly onOpenTask: (deploymentId: string, threadId: string) => void;
  readonly onSchedules: () => void;
  readonly onSearch: (deploymentId: string) => void;
  readonly onSettings: () => void;
  readonly onProjects: () => void;
  readonly onTabs: () => void;
}

/**
 * What the sidebar shows of one Deployment's work: the shared task list, and
 * where a task started here would run.
 */
interface SidebarModel {
  /** Main's Done list newest Done first, once read from a Host that keeps one. */
  readonly done: DoneTaskList | null;
  /** Main's tasks, then one folder per Project, from the grouping web shares. */
  readonly grouping: ProjectGrouping;
  readonly list: TaskList;
  /** The Host has sent its first page of tasks. */
  readonly loaded: boolean;
  readonly quietScope: string | null;
  /** Main, while it can hold a new task; a task started here runs there. */
  readonly taskWorkspaceId: string | null;
  readonly voice: VoiceRowMark;
  readonly voiceThreadId: string | null;
}

function sidebarModel(
  snapshot: HostSnapshot,
  openThreadId: string | null,
  previous: Pick<TaskList, "ready"> | null,
): SidebarModel {
  const main = mainWorkspace(snapshot);
  const list = taskList(snapshot, {
    openThreadId: openThreadId === null ? null : listedRowThreadId(snapshot, openThreadId),
    previous,
  });
  return {
    done: doneTaskList(snapshot),
    grouping: groupTasksByProject(snapshot, list),
    list,
    loaded: snapshot.tasks !== null,
    quietScope: quietSeenScope(snapshot),
    taskWorkspaceId: main?.status === "ready" ? main.id : null,
    voice: voiceRowMark(snapshot),
    voiceThreadId: snapshot.voiceThreadId,
  };
}

/**
 * The shelves the sidebar last drew, kept by the shell: the drawer and the
 * docked column are separate panels, and a closed one reads nothing, yet a task
 * opened from one must keep its shelf in whichever shows next.
 */
export interface ShelfMemory {
  /** Projects the reader folded; open is the default, so a new Project's first task shows. */
  closedProjects: ReadonlySet<string>;
  list: Pick<TaskList, "ready"> | null;
}

/**
 * The selected Deployment's work as the sidebar needs it, or null while no
 * Host of that Deployment is attached. It reads without loading: the Host
 * client keeps the task list current, and the screen underneath owns the
 * Host's first read. It is rebuilt only when what the list or Main reads
 * changes, so a streamed token leaves the sidebar alone; each opening starts
 * afresh, including shared Done changes and this reader’s unread state.
 */
function useSidebarModel(
  hostClient: HostClient | null,
  openThreadId: string | null,
  shelves: ShelfMemory,
): SidebarModel | null {
  const cached = useRef<{
    readonly model: SidebarModel;
    readonly snapshot: HostSnapshot;
    readonly openThreadId: string | null;
  } | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => hostClient?.subscribe(listener) ?? (() => undefined),
    [hostClient],
  );
  const read = useCallback((): SidebarModel | null => {
    if (hostClient === null) {
      cached.current = null;
      return null;
    }
    const snapshot = hostClient.getSnapshot();
    const current = cached.current;
    if (
      current !== null &&
      current.openThreadId === openThreadId &&
      sameTaskListSource(current.snapshot, snapshot) &&
      current.snapshot.workspaces === snapshot.workspaces &&
      current.snapshot.homeWorkspaceId === snapshot.homeWorkspaceId &&
      current.snapshot.user === snapshot.user
    ) {
      return current.model;
    }
    const model = sidebarModel(snapshot, openThreadId, shelves.list);
    cached.current = { model, snapshot, openThreadId };
    shelves.list = model.list;
    return model;
  }, [hostClient, openThreadId, shelves]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * This reader's drafts, held until the list would change: the store publishes
 * every write, and a keystroke leaves this list as it was. The draft in front
 * keeps the title it had; one written here joins the list on leaving.
 */
function useDraftSummary(
  deploymentId: string | null,
  userId: string | null,
  openDraftId: string | null,
): DraftSummary {
  const { drafts } = useMobileClient();
  const cached = useRef(noDrafts);
  const read = useCallback((): DraftSummary => {
    const saved =
      deploymentId === null || userId === null
        ? noDrafts
        : drafts.readDraftSummary(deploymentId, userId);
    const listed = cached.current.newTasks.find((draft) => draft.draftId === openDraftId);
    const next = {
      ...saved,
      newTasks: saved.newTasks.flatMap((draft) =>
        draft.draftId !== openDraftId ? [draft] : listed ? [{ ...draft, title: listed.title }] : [],
      ),
    };
    if (!sameDraftSummary(cached.current, next)) cached.current = next;
    return cached.current;
  }, [deploymentId, drafts, openDraftId, userId]);
  return useSyncExternalStore(drafts.subscribe, read, read);
}

/** The open Deployment's identity, held across unrelated client updates. */
function useDeploymentIdentity(deploymentId: string | null): DeploymentIdentity | null {
  const client = useMobileClient();
  const cached = useRef<DeploymentIdentity | null>(null);
  const read = useCallback((): DeploymentIdentity | null => {
    if (deploymentId === null) return null;
    const next = deploymentIdentity(client.getSnapshot().rows, deploymentId);
    const current = cached.current;
    if (current !== null && sameDeploymentIdentity(current, next)) return current;
    cached.current = next;
    return next;
  }, [client, deploymentId]);
  return useSyncExternalStore(client.subscribe, read, read);
}

/**
 * Reads Main's Done list once a Host that keeps one is signed in; the Host
 * client keeps it current from then on.
 */
function useDoneList(hostClient: HostClient | null): void {
  useEffect(() => {
    if (hostClient === null) return;
    let asked = false;
    const ask = (): void => {
      const snapshot = hostClient.getSnapshot();
      if (asked || snapshot.quietTasksAvailable !== true || snapshot.session !== "authenticated")
        return;
      asked = true;
      void hostClient.loadDoneTasks().catch(() => undefined);
    };
    ask();
    return hostClient.subscribe(ask);
  }, [hostClient]);
}

/**
 * The sidebar is the one place to move between everything: Chat, New task,
 * Projects and Schedules; the new tasks not yet sent; Main's tasks grouped by
 * what each asks of the reader —
 * Working, with anything waiting on them first; Ready; Done — then each
 * Project as a folder of its chat and work under way; then the Deployment's tabs,
 * apps and phones, and All tabs; and below them Settings and which
 * Deployment this is. Each row comes from the shared task and place lists, so
 * a task or tab reads the same here as on the web.
 *
 * Only an attached Host of the Deployment underneath is read. While the
 * selection is moving to another one, or that Host has refused this phone,
 * the tasks are simply absent rather than showing the previous Host's tasks
 * under the new name.
 */
export const SidebarPanel = memo(function SidebarPanel(props: {
  readonly actions: SidebarActions;
  /** How far an obstruction over this panel reaches in from its bottom edge. */
  readonly clearanceBottom: number;
  /** How far down an obstruction over this panel reaches, measured where it is drawn. */
  readonly clearanceTop: number;
  readonly deploymentId: string | null;
  readonly destination: SidebarDestination | null;
  /**
   * Beside the screens rather than over them: it is part of the screen, so it
   * neither isolates itself for a screen reader nor takes its focus.
   */
  readonly docked: boolean;
  /** Where the reader left the list, kept by the shell across the drawer and the column. */
  readonly scroll: ScrollMemory;
  readonly shelves: ShelfMemory;
  /** The new-task draft in front. */
  readonly openDraftId: string | null;
  /** The task in front, marked as the one open. */
  readonly selectedThreadId: string | null;
  /** The task whose conversation is on screen; opening it never moves its row. */
  readonly openThreadId: string | null;
  /** The Project whose page or settings are in front. */
  readonly openProjectId: string | null;
  readonly visible: boolean;
}): ReactNode {
  const insets = useContentInsets();
  const { rows, selection } = useMobileState();
  const { actions, deploymentId, destination, docked, selectedThreadId, visible } = props;
  const row = rows.find((candidate) => candidate.deploymentId === deploymentId);
  const hostClient =
    deploymentId !== null && selection.deploymentId === deploymentId && row?.signIn === null
      ? selection.hostClient
      : null;
  // Read only while the sidebar is on screen: closed, it would otherwise
  // rebuild every row on every streamed update for a list nobody can see.
  // Opening reads the current snapshot in the same render that shows it.
  const savedTasks = useSavedSurface(visible ? deploymentId : null, "tasks");
  const model = useSidebarModel(
    visible && savedTasks.source !== "saved" ? hostClient : null,
    props.openThreadId,
    props.shelves,
  );
  const identity = useDeploymentIdentity(deploymentId);
  const client = useMobileClient();
  const userId = useHostUserId(hostClient);
  const drafts = useDraftSummary(visible ? deploymentId : null, userId, props.openDraftId);
  const seen = useSyncExternalStore(
    client.quietSeen.subscribe,
    client.quietSeen.getSnapshot,
    client.quietSeen.getSnapshot,
  );
  useDoneList(hostClient);
  const [closedProjects, setClosedProjects] = useState(props.shelves.closedProjects);
  const shelves = props.shelves;
  const toggleProject = useCallback(
    (workspaceId: string) => {
      const next = new Set(shelves.closedProjects);
      if (!next.delete(workspaceId)) next.add(workspaceId);
      shelves.closedProjects = next;
      setClosedProjects(next);
    },
    [shelves],
  );
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierFailure, setEarlierFailure] = useState<string | null>(null);
  const heading = useRef<TextInstance>(null);
  const retained = useRetainedScroll(props.scroll);

  // A screen reader lands on the sidebar's own heading as the drawer opens;
  // the drawer isolates it from what it covers while it is there. Docked, it
  // appears with the window and takes nobody's focus.
  useEffect(() => {
    if (visible && !docked && heading.current !== null) {
      AccessibilityInfo.sendAccessibilityEvent(heading.current, "focus");
    }
  }, [docked, visible]);

  const openTask = useCallback(
    (threadId: string) => {
      if (deploymentId !== null) actions.onOpenTask(deploymentId, threadId);
    },
    [actions, deploymentId],
  );
  const openDraft = useCallback(
    (draft: NewTaskDraftSummary) => {
      if (deploymentId !== null) {
        actions.onOpenDraft(deploymentId, draft.workspaceId, draft.draftId);
      }
    },
    [actions, deploymentId],
  );
  const discardDraft = useCallback(
    (draft: NewTaskDraftSummary) => {
      if (deploymentId === null || userId === null) return;
      const discard = (): void =>
        void discardNewTaskDraft({
          client: hostClient,
          deploymentId,
          draftId: draft.draftId,
          drafts: client.drafts,
          userId,
        }).then(
          () => AccessibilityInfo.announceForAccessibility("Draft discarded"),
          (error: unknown) =>
            Alert.alert("Draft not discarded", operationDetail(error, "Try again.")),
        );
      Alert.alert("Discard draft?", `“${draft.title}” will be removed.`, [
        { style: "cancel", text: "Cancel" },
        { onPress: discard, style: "destructive", text: "Discard" },
      ]);
    },
    [client, deploymentId, hostClient, userId],
  );
  const moveTask = useCallback(
    (task: TaskRow, done: boolean) => {
      if (hostClient !== null) setTaskDone(hostClient, task.threadId, done);
    },
    [hostClient],
  );
  const loadEarlier = useCallback(() => {
    if (hostClient === null || loadingEarlier) return;
    setLoadingEarlier(true);
    setEarlierFailure(null);
    void hostClient
      .loadEarlierTasks()
      .catch((error: unknown) =>
        setEarlierFailure(operationDetail(error, "Earlier tasks could not be loaded.")),
      )
      .finally(() => setLoadingEarlier(false));
  }, [hostClient, loadingEarlier]);

  const list = model?.list ?? null;
  const taskWorkspaceId = model?.taskWorkspaceId ?? null;
  // A helper has no row, so the task it works for, or Chat, is the one marked open.
  const selectedRow = useMemo(() => {
    if (hostClient === null || model === null || selectedThreadId === null)
      return { chat: false, threadId: selectedThreadId, voice: false };
    const snapshot = hostClient.getSnapshot();
    const threadId = listedRowThreadId(snapshot, selectedThreadId);
    return {
      chat: threadId === snapshot.homeThreadId,
      threadId,
      voice: threadId === snapshot.voiceThreadId,
    };
  }, [hostClient, model, selectedThreadId]);
  const main = model?.grouping.main ?? null;
  const folders = useMemo(
    () =>
      model === null
        ? []
        : sidebarFolders(model.grouping.folders, closedProjects, selectedRow.threadId),
    [closedProjects, model, selectedRow.threadId],
  );
  // The Thread in front has its draft in front of the reader already.
  const unsentReply = (threadId: string | null | undefined): boolean =>
    threadId != null && threadId !== selectedRow.threadId && drafts.threadIds.has(threadId);
  // Times are read as the list draws, so a row that has not changed still ages.
  const now = Date.now();
  const doneCount = model?.done?.total ?? main?.done.length ?? 0;
  const moved =
    model === null || seen === null || model.quietScope === null
      ? []
      : quietlyMoved(model.done, seen[model.quietScope] ?? null, now);
  const taskRows = (tasks: readonly TaskRow[], shelf: TaskShelf, nested = false) =>
    tasks.map((task) => (
      <Animated.View key={task.threadId} layout={move} style={nested && styles.nested}>
        <TaskRowView
          drafted={unsentReply(task.threadId)}
          onOpen={openTask}
          onSetDone={moveTask}
          row={task}
          selected={task.threadId === selectedRow.threadId}
          shelf={shelf}
          time={taskTime(task, now)}
        />
      </Animated.View>
    ));

  return (
    <View
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "yes" : "no-hide-descendants"}
      onAccessibilityEscape={docked ? undefined : actions.close}
      style={[
        styles.panel,
        docked && styles.docked,
        {
          paddingLeft: insets.left,
          paddingRight: docked ? insets.right : 0,
          paddingTop: sidebarTop(insets.top, props.clearanceTop, Platform.OS === "ios"),
        },
      ]}
    >
      <View style={styles.head}>
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={controlFontScaleLimit}
          ref={heading}
          style={[type.title, styles.brand]}
        >
          Opensteer
        </Text>
        {deploymentId === null ? null : (
          <IconButton
            icon="magnifyingglass"
            label="Search tasks"
            onPress={() => actions.onSearch(deploymentId)}
          />
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        onContentSizeChange={retained.onContentSizeChange}
        onLayout={retained.onLayout}
        onMomentumScrollEnd={retained.onMomentumScrollEnd}
        onScrollEndDrag={retained.onScrollEndDrag}
        ref={retained.ref}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
      >
        <View style={styles.nav}>
          <DestinationRow
            accessibilityLabel={
              list === null || list.chat === null
                ? CHAT_THREAD_TITLE
                : taskRowLabel(list.chat, { chat: true })
            }
            accessory={list === null ? null : <ChatAccessory row={list.chat} />}
            current={destination === "Home" || selectedRow.chat}
            drafted={destination !== "Home" && unsentReply(list?.chat?.threadId)}
            icon="bubble.left"
            mark={<ChatOrb size={20} />}
            label={CHAT_THREAD_TITLE}
            onPress={actions.onChat}
          />
          <VoiceRow
            current={selectedRow.voice}
            drafted={unsentReply(model?.voiceThreadId)}
            mark={model?.voice ?? null}
            onOpen={openTask}
            threadId={model?.voiceThreadId ?? null}
            visible={visible}
          />
          {deploymentId === null ? null : (
            <DestinationRow
              accessibilityLabel={
                taskWorkspaceId === null ? "New task, unavailable until Main is ready" : "New task"
              }
              current={false}
              disabled={taskWorkspaceId === null}
              icon="plus"
              label="New task"
              onPress={() => {
                if (taskWorkspaceId !== null) actions.onNewTask(deploymentId, taskWorkspaceId);
              }}
            />
          )}
          <DestinationRow
            current={destination === "Projects"}
            icon="folder"
            label="Projects"
            onPress={actions.onProjects}
          />
          <DestinationRow
            current={destination === "Schedules"}
            icon="clock"
            label="Automations"
            onPress={actions.onSchedules}
          />
        </View>

        {drafts.newTasks.length === 0 ? null : (
          <>
            <GroupHead title="Drafts" />
            {drafts.newTasks.map((draft) => (
              <DraftRow
                draft={draft}
                key={draft.draftId}
                onDiscard={discardDraft}
                onOpen={openDraft}
                selected={draft.draftId === props.openDraftId}
              />
            ))}
          </>
        )}

        {savedTasks.source === "saved" ? (
          <SavedTasks
            tasks={savedTasks.content}
            label={savedTasks.label}
            capturedAt={savedTasks.capturedAt}
          />
        ) : null}
        {model === null || main === null ? null : !model.loaded ? (
          <View style={styles.loading}>
            <ActivityIndicator color={color.muted} />
          </View>
        ) : main.working.length === 0 &&
          main.ready.length === 0 &&
          doneCount === 0 &&
          !model.list.hasMore &&
          folders.length === 0 ? (
          <View style={styles.welcome}>
            <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium">
              Your tasks will show up here
            </AppText>
            <AppText role="caption" tone="muted">
              Ask for something bigger in Chat and it runs here on its own while you keep talking.
              You’ll see what’s working and anything that needs you.
            </AppText>
          </View>
        ) : (
          // One keyed run of rows across every shelf and folder, so a task
          // changing shelves keeps its view and slides to its new place
          // instead of reappearing.
          [
            ...[
              { rows: main.working, title: "Working" },
              { rows: main.ready, title: "Ready" },
            ].flatMap((group) =>
              group.rows.length === 0
                ? []
                : [
                    <GroupHead
                      key={`group:${group.title}`}
                      title={group.title}
                      {...(group.title === "Working" ? { count: group.rows.length } : {})}
                    />,
                    ...taskRows(group.rows, "open"),
                  ],
            ),
            main.working.length === 0 &&
            main.ready.length === 0 &&
            (doneCount > 0 || model.list.hasMore) ? (
              <AppText key="caught-up" role="caption" style={styles.empty} tone="muted">
                You’re all caught up.
              </AppText>
            ) : null,
            doneCount === 0 ? null : (
              <DoneLine
                count={doneCount}
                key="done-shelf"
                moved={moved.length}
                onOpen={() => {
                  if (deploymentId !== null) actions.onOpenDone(deploymentId);
                }}
                onOpenMoved={() => {
                  if (deploymentId !== null) actions.onOpenQuietlyMoved(deploymentId);
                }}
              />
            ),
            !model.list.hasMore ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: loadingEarlier }}
                disabled={loadingEarlier}
                key="show-more"
                onPress={loadEarlier}
                style={({ pressed }) => [styles.more, pressed && styles.pressed]}
              >
                {loadingEarlier ? (
                  <ActivityIndicator color={color.muted} size="small" />
                ) : (
                  <AppText
                    maxFontSizeMultiplier={controlFontScaleLimit}
                    role="caption"
                    tone="muted"
                  >
                    Show more
                  </AppText>
                )}
              </Pressable>
            ),
            earlierFailure === null ? null : (
              <AppText key="earlier-failure" role="caption" style={styles.empty} tone="danger">
                {earlierFailure}
              </AppText>
            ),
            ...(folders.length === 0 || deploymentId === null
              ? []
              : [
                  <ProjectsHead
                    hostClient={hostClient}
                    key="projects-head"
                    onNewProject={() => actions.onNewProject(deploymentId)}
                    onProjects={actions.onProjects}
                  />,
                  ...folders.flatMap((entry) => [
                    <Animated.View key={`folder:${entry.folder.workspace.id}`} layout={move}>
                      <ProjectFolderRow
                        current={props.openProjectId === entry.folder.workspace.id}
                        entry={entry}
                        onNewTask={(workspaceId) => actions.onNewTask(deploymentId, workspaceId)}
                        onOpen={(workspaceId) => actions.onOpenProject(deploymentId, workspaceId)}
                        onToggle={toggleProject}
                      />
                    </Animated.View>,
                    entry.chat === null ? null : (
                      <Animated.View key={entry.chat.threadId} layout={move} style={styles.nested}>
                        <FolderChatRow
                          drafted={unsentReply(entry.chat.threadId)}
                          onOpen={openTask}
                          row={entry.chat}
                          selected={entry.chat.threadId === selectedRow.threadId}
                        />
                      </Animated.View>
                    ),
                    ...taskRows(entry.shown, "open", true),
                    entry.more === 0 ? null : (
                      <Pressable
                        accessibilityHint={`Opens ${entry.folder.workspace.name}`}
                        accessibilityRole="button"
                        key={`more:${entry.folder.workspace.id}`}
                        onPress={() =>
                          actions.onOpenProject(deploymentId, entry.folder.workspace.id)
                        }
                        style={({ pressed }) => [
                          styles.more,
                          styles.nested,
                          pressed && styles.pressed,
                        ]}
                      >
                        <AppText
                          maxFontSizeMultiplier={controlFontScaleLimit}
                          role="caption"
                          tone="muted"
                        >
                          {`${entry.more} more`}
                        </AppText>
                      </Pressable>
                    ),
                  ]),
                ]),
          ]
        )}

        <View style={styles.tabs}>
          {hostClient === null || model === null ? (
            <GroupHead title="Tabs" />
          ) : (
            <SidebarTabs hostClient={hostClient} onOpen={actions.onOpenPlace} />
          )}
          <DestinationRow
            current={destination === "Tabs"}
            icon="rectangle.on.rectangle"
            label="All tabs"
            onPress={actions.onTabs}
          />
        </View>
      </ScrollView>

      <View
        style={[
          styles.footer,
          {
            paddingBottom: sidebarBottom(
              insets.bottom,
              props.clearanceBottom,
              Platform.OS === "ios",
            ),
          },
        ]}
      >
        {identity === null || row === undefined ? (
          <DestinationRow
            current={false}
            icon="gearshape"
            label="Settings"
            onPress={actions.onSettings}
          />
        ) : (
          // Which Deployment this is, and the way into Settings, where it is
          // switched on a screen that shows each one's state.
          <Pressable
            accessibilityHint="Opens Settings"
            accessibilityLabel={`Settings. ${identity.name}, ${identity.status}`}
            accessibilityRole="button"
            onPress={actions.onSettings}
            style={({ pressed }) => [styles.deployment, pressed && styles.pressed]}
          >
            <DeploymentMarkView mark={identity.mark} />
            <View style={styles.statusLine}>
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="secondaryMedium"
                style={styles.deploymentName}
              >
                {identity.name}
              </AppText>
              <StatusDot
                live={row.status === "connecting" || row.status === "reconnecting"}
                tone={statusTone(row.status)}
              />
              {/* Colour alone never carries a problem, so only being connected goes unsaid. */}
              {row.status === "connected" ? null : (
                <AppText
                  maxFontSizeMultiplier={controlFontScaleLimit}
                  numberOfLines={1}
                  role="caption"
                  tone="muted"
                >
                  {identity.status}
                </AppText>
              )}
            </View>
            <Symbol name="gearshape" size={17} tint={color.muted} />
          </Pressable>
        )}
      </View>
    </View>
  );
});

/**
 * Done, as one quiet line at the end of Tasks: it opens the Done page. Tasks
 * the Host just moved there for the reader add a "+N" that names them.
 */
function DoneLine(props: {
  readonly count: number;
  readonly moved: number;
  readonly onOpen: () => void;
  readonly onOpenMoved: () => void;
}): ReactNode {
  const [pressed, setPressed] = useState(false);
  const press = {
    onPress: props.onOpen,
    onPressIn: () => setPressed(true),
    onPressOut: () => setPressed(false),
  };
  return (
    <View style={[styles.shelf, pressed && styles.pressed]}>
      <Pressable
        accessibilityLabel={`Done, ${props.count} ${props.count === 1 ? "task" : "tasks"}`}
        accessibilityRole="button"
        style={styles.shelfOpen}
        {...press}
      >
        <View style={styles.shelfMark}>
          <Symbol name="checkmark.circle" size={15} tint={color.muted} />
        </View>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondary" tone="muted">
          Done
        </AppText>
      </Pressable>
      {props.moved === 0 ? null : (
        <Pressable
          accessibilityLabel={`${props.moved} ${
            props.moved === 1 ? "task" : "tasks"
          } moved to Done for you`}
          accessibilityRole="button"
          hitSlop={{ bottom: space[12], left: space[8], right: space[4], top: space[12] }}
          onPress={props.onOpenMoved}
          style={({ pressed: chipPressed }) => [styles.moved, chipPressed && styles.movedPressed]}
        >
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            role="caption"
            style={styles.movedText}
          >
            {`+${props.moved}`}
          </AppText>
        </Pressable>
      )}
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.shelfCount}
        {...press}
      >
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" style={styles.count}>
          {String(props.count)}
        </AppText>
      </Pressable>
    </View>
  );
}

/**
 * The tabs listed before All tabs: enough to switch between the ones in use
 * without the task list moving out of reach. The one open is always listed.
 */
const sidebarTabLimit = 5;

/**
 * The Deployment's tabs, apps and phones as rows, in the shared place list's
 * order. A row opens exactly its place; nothing is shown of who opened it or
 * which task holds it, and no picture is asked for.
 */
const SidebarTabs = memo(function SidebarTabs(props: {
  readonly hostClient: HostClient;
  readonly onOpen: (destination: WorkspaceSurfaceDestination) => void;
}): ReactNode {
  // The panel arranges slots; each row reads its own place, so a title repaints one row.
  const places = usePlaceSlots(props.hostClient);
  const syncing = useBrowserGroups(props.hostClient).syncing && places.length === 0;
  const finding = useSyncingPlaceholder(syncing, places.length);
  return (
    <>
      <GroupHead {...(syncing ? {} : { count: places.length })} title="Tabs" />
      {finding ? (
        <AppText role="caption" style={styles.finding} tone="muted">
          Finding tabs…
        </AppText>
      ) : null}
      {places.slice(0, sidebarTabLimit).map((place) => (
        <KeyedPlaceRow
          hostClient={props.hostClient}
          key={place.key}
          onOpen={props.onOpen}
          placeKey={place.key}
        />
      ))}
    </>
  );
});

const KeyedPlaceRow = memo(function KeyedPlaceRow(props: {
  readonly hostClient: HostClient;
  readonly onOpen: (destination: WorkspaceSurfaceDestination) => void;
  readonly placeKey: string;
}): ReactNode {
  const place = usePlace(props.hostClient, props.placeKey);
  return place ? <PlaceRow onOpen={props.onOpen} place={place} /> : null;
});

const placeGlyph: Record<PlaceItem["kind"], SFSymbolName> = {
  "opensteer-app": opensteerAppGlyph,
  app: "desktopcomputer",
  browser: "globe",
  phone: "smartphone",
};

const placeKind: Record<PlaceItem["kind"], string> = {
  "opensteer-app": "Opensteer app",
  app: "App",
  browser: "Tab",
  phone: "Phone",
};

const PlaceRow = memo(function PlaceRow(props: {
  readonly onOpen: (destination: WorkspaceSurfaceDestination) => void;
  readonly place: PlaceItem;
}): ReactNode {
  const { onOpen, place } = props;
  const acting = place.occupants.some((occupant) => occupant.acting);
  const unavailable = place.availability === "unavailable";
  const where =
    (place.kind === "browser" ? tabSiteLabel(place.site) : (place.device?.name ?? null)) ??
    placeKind[place.kind];
  const label = [
    place.title,
    where,
    acting ? agentWorkingLabel.toLowerCase() : null,
    unavailable ? "unavailable" : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return (
    <DestinationRow
      accessibilityLabel={label}
      accessory={acting ? <ActingDot grouped /> : null}
      current={false}
      detail={where}
      icon={placeGlyph[place.kind]}
      label={place.title}
      muted={unavailable}
      onPress={() => onOpen(place.destination)}
    />
  );
});

/**
 * Beside Chat, the one thing worth saying: a question waiting on the reader,
 * that it is replying, or that something arrived unread. Before the task list
 * has said anything about Chat, nothing is claimed.
 */
function ChatAccessory(props: { readonly row: TaskRow | null }): ReactNode {
  const { row } = props;
  if (row === null) return null;
  if (row.tone === "needs-you") return <NeedsYouTag />;
  if (row.tone === "working") return <ActivityIndicator color={color.ember} size="small" />;
  return row.unread ? <UnreadDot /> : null;
}

/**
 * The person's Voice Thread, under Chat. It exists only once someone needs it,
 * so opening it asks for it first; after that it holds history and Requests
 * whether or not a call can start.
 */
function VoiceRow(props: {
  readonly current: boolean;
  readonly drafted: boolean;
  readonly mark: VoiceRowMark;
  readonly onOpen: (threadId: string) => void;
  readonly threadId: string | null;
  /** A closed drawer keeps its rows, and nobody reads a clock there. */
  readonly visible: boolean;
}): ReactNode {
  const controller = useContext(VoiceContext);
  const offered = useVoiceAvailable();
  const onCall = useVoiceOn();
  const [opening, setOpening] = useState(false);
  const claimed = useRef(false);
  const { mark, onOpen, threadId } = props;
  if (threadId === null && (controller === null || !offered)) return null;
  const open = (): void => {
    if (threadId !== null) {
      onOpen(threadId);
      return;
    }
    if (claimed.current || controller === null) return;
    claimed.current = true;
    setOpening(true);
    void controller
      .openThread()
      .then((threadId) => {
        if (threadId === null) throw new Error("No Voice Thread");
        onOpen(threadId);
      })
      .catch(() => Alert.alert("Voice didn’t open", "Check your connection and try again."))
      .finally(() => {
        claimed.current = false;
        setOpening(false);
      });
  };
  const state =
    mark === "needs-you"
      ? "needs you"
      : onCall
        ? "on a call"
        : mark === "working"
          ? "replying"
          : mark === "unread"
            ? "unread"
            : null;
  return (
    <DestinationRow
      accessibilityLabel={state === null ? "Voice" : `Voice, ${state}`}
      accessory={
        opening || (mark === "working" && !onCall) ? (
          <ActivityIndicator color={color.ember} size="small" />
        ) : mark === "needs-you" ? (
          <NeedsYouTag />
        ) : onCall ? (
          props.visible ? (
            <CallTimer />
          ) : null
        ) : mark === "unread" ? (
          <UnreadDot />
        ) : null
      }
      current={props.current}
      drafted={props.drafted}
      icon="waveform"
      label="Voice"
      onPress={open}
    />
  );
}

/**
 * The Projects group's head: its name opens the directory, and + starts a
 * new Project, so neither needs a trip through the list above.
 */
function ProjectsHead(props: {
  readonly hostClient: HostClient | null;
  readonly onNewProject: () => void;
  readonly onProjects: () => void;
}): ReactNode {
  return (
    <View style={styles.projectsHead}>
      <Pressable
        accessibilityHint="Opens all projects"
        accessibilityLabel="Projects"
        accessibilityRole="button"
        onPress={props.onProjects}
        style={({ pressed }) => [styles.projectsTitle, pressed && styles.pressed]}
      >
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          role="caption"
          style={styles.groupTitle}
          tone="muted"
        >
          Projects
        </AppText>
      </Pressable>
      <CreateProjectGate hostClient={props.hostClient}>
        <IconButton icon="plus" label="New project" onPress={props.onNewProject} small />
      </CreateProjectGate>
    </View>
  );
}

/**
 * A Project as a folder: its mark and name open its page, + starts a task in
 * it, and the chevron folds its rows away. Folded, it still says the one
 * thing worth knowing about what it hides, so closing a folder never hides a
 * question waiting on the reader.
 */
function ProjectFolderRow(props: {
  readonly current: boolean;
  readonly entry: SidebarFolder;
  readonly onNewTask: (workspaceId: string) => void;
  readonly onOpen: (workspaceId: string) => void;
  readonly onToggle: (workspaceId: string) => void;
}): ReactNode {
  const { entry } = props;
  const { workspace, signal, needsYou } = entry.folder;
  const words = folderSignalWords(signal, needsYou);
  const problem = projectStatusLabel(workspace);
  const ready = workspace.status === "ready";
  const hidden = (entry.folder.chat === null ? 0 : 1) + entry.folder.rows.length;
  return (
    <View style={[styles.folder, (props.current || entry.holdsOpenRow) && styles.current]}>
      <Pressable
        accessibilityHint="Opens this project"
        accessibilityLabel={[workspace.name, words, problem].filter(Boolean).join(", ")}
        accessibilityRole="button"
        accessibilityState={{ selected: props.current }}
        onPress={() => props.onOpen(workspace.id)}
        style={({ pressed }) => [styles.folderMain, pressed && styles.pressed]}
      >
        <View style={styles.destinationMark}>
          <WorkspaceMark
            color={workspace.color}
            icon={workspace.icon}
            name={workspace.name}
            size="mini"
          />
        </View>
        <Text
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          style={[
            type.secondary,
            problem !== null
              ? styles.disabledLabel
              : props.current
                ? styles.currentLabel
                : styles.destinationLabel,
          ]}
        >
          {workspace.name}
        </Text>
        {problem === null ? null : (
          <Symbol name="exclamationmark.circle" size={14} tint={color.amber} />
        )}
        {/* Open, its rows say it themselves; folded, the folder says it for them. */}
        {entry.open && entry.foldable ? null : <FolderSignal folder={entry.folder} />}
      </Pressable>
      <IconButton
        disabled={!ready}
        icon="plus"
        label={
          ready ? `New task in ${workspace.name}` : `New task in ${workspace.name}, unavailable`
        }
        onPress={() => props.onNewTask(workspace.id)}
        small
      />
      {entry.foldable ? (
        <IconButton
          expanded={entry.open}
          icon={entry.open ? "chevron.down" : "chevron.right"}
          label={`${entry.open ? "Fold" : "Unfold"} ${workspace.name}${
            !entry.open && hidden > 0 ? `, ${hidden} hidden` : ""
          }`}
          onPress={() => props.onToggle(workspace.id)}
          small
        />
      ) : (
        <View style={styles.iconSpacer} />
      )}
    </View>
  );
}

/** What a folded folder says for the work it hides, loudest first. */
function FolderSignal(props: { readonly folder: ProjectFolder }): ReactNode {
  switch (props.folder.signal) {
    case "needs-you":
      return <NeedsYouTag />;
    case "working":
      return <ActivityIndicator color={color.ember} size="small" />;
    case "failed":
      return <Symbol name="exclamationmark.circle" size={14} tint={color.red} />;
    case "unread":
      return <UnreadDot />;
    case null:
      return null;
  }
}

/** A Project's own chat, first in its folder. */
function FolderChatRow(props: {
  readonly drafted: boolean;
  readonly onOpen: (threadId: string) => void;
  readonly row: TaskRow;
  readonly selected: boolean;
}): ReactNode {
  const { row } = props;
  return (
    <DestinationRow
      accessibilityLabel={taskRowLabel(row, { chat: true })}
      accessory={<ChatAccessory row={row} />}
      current={props.selected}
      drafted={props.drafted}
      icon="bubble.left"
      label={CHAT_THREAD_TITLE}
      mark={<ChatOrb size={16} />}
      onPress={() => props.onOpen(row.threadId)}
    />
  );
}

/** A group's label over its rows: Working with its count, Ready. */
function GroupHead(props: { readonly count?: number; readonly title: string }): ReactNode {
  return (
    <View
      accessibilityLabel={
        props.count === undefined ? props.title : `${props.title}, ${props.count}`
      }
      accessibilityRole="header"
      style={styles.groupHead}
    >
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={styles.groupTitle}
        tone="muted"
      >
        {props.title}
      </AppText>
      {props.count === undefined ? null : (
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" style={styles.count}>
          {String(props.count)}
        </AppText>
      )}
    </View>
  );
}

/** A glyph-only control in the sidebar's head or a section's head, at a full touch target. */
function IconButton(props: {
  readonly disabled?: boolean;
  /** For a control that folds something: whether it is open now. */
  readonly expanded?: boolean;
  readonly icon: SFSymbolName;
  readonly label: string;
  readonly onPress: () => void;
  /** Sized to a section label rather than to the sidebar's own head. */
  readonly small?: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{
        disabled: props.disabled === true,
        ...(props.expanded === undefined ? {} : { expanded: props.expanded }),
      }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
    >
      <Symbol
        name={props.icon}
        size={props.small === true ? 15 : 18}
        tint={props.disabled === true ? color.mutedDim : color.muted}
        weight="medium"
      />
    </Pressable>
  );
}

/**
 * One place to go. The current one is filled, bold and announced as selected,
 * so which it is does not rest on colour alone.
 */
function DestinationRow(props: {
  readonly mark?: ReactNode;
  readonly accessibilityLabel?: string;
  /** What the place has to say for itself, at the row's end. */
  readonly accessory?: ReactNode;
  readonly current: boolean;
  /** A second, quieter word after the label: a tab's site. */
  readonly detail?: string;
  readonly disabled?: boolean;
  /** The reader has an unsent reply here. */
  readonly drafted?: boolean;
  readonly icon: SFSymbolName;
  readonly label: string;
  /** Still a place to go, but one that cannot show anything now. */
  readonly muted?: boolean;
  readonly onPress: () => void;
}): ReactNode {
  const disabled = props.disabled === true;
  const quiet = disabled || props.muted === true;
  const drafted = props.drafted === true;
  const spoken = props.accessibilityLabel ?? props.label;
  return (
    <Pressable
      accessibilityLabel={drafted ? `${spoken}, ${draftPenLabel}` : spoken}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: props.current }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.destination,
        props.current && styles.current,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.destinationMark}>
        {props.mark ?? (
          <Symbol
            name={props.icon}
            size={18}
            tint={quiet ? color.mutedDim : props.current ? color.ember : color.muted}
            weight={props.current ? "semibold" : "regular"}
          />
        )}
      </View>
      <Text
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        style={[
          type.secondary,
          quiet
            ? styles.disabledLabel
            : props.current
              ? styles.currentLabel
              : styles.destinationLabel,
        ]}
      >
        {props.label}
      </Text>
      {props.detail === undefined ? null : (
        <Text
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          style={[type.caption, styles.detail]}
        >
          {props.detail}
        </Text>
      )}
      {props.accessory}
      {drafted ? <DraftPen /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  brand: { color: color.text, flex: 1 },
  content: { paddingBottom: space[16], paddingHorizontal: space[8] },
  count: { color: color.mutedDim, fontVariant: ["tabular-nums"] },
  current: { ...material.selected },
  currentLabel: { color: color.text, flex: 1, fontWeight: "600" },
  deployment: {
    borderColor: "transparent",
    borderWidth: 1,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[12] - 1,
  },
  deploymentName: { flexShrink: 1 },
  finding: { paddingHorizontal: space[12], paddingVertical: space[6] },
  destination: {
    borderColor: "transparent",
    borderWidth: 1,
    cursor: "pointer",
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[12] - 1,
  },
  destinationLabel: { color: color.textSoft, flex: 1 },
  // A site is the shorter of the two words: the title keeps what room there is.
  detail: { color: color.mutedDim, flexShrink: 1, maxWidth: "40%" },
  // The places to go share the task rows' mark column, so every label lines up.
  destinationMark: { alignItems: "center", width: taskTextInset - space[12] * 2 },
  disabledLabel: { color: color.mutedDim, flex: 1 },
  empty: { paddingBottom: space[6], paddingHorizontal: space[12], paddingTop: space[12] },
  footer: {
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space[2],
    paddingHorizontal: space[8],
    paddingTop: space[6],
  },
  groupHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    paddingBottom: space[4],
    paddingHorizontal: space[12],
    paddingTop: space[16],
  },
  groupTitle: { fontWeight: "600" },
  folder: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    minHeight: touchTarget,
  },
  folderMain: {
    alignItems: "center",
    alignSelf: "stretch",
    borderRadius: radius.md,
    cursor: "pointer",
    flex: 1,
    flexDirection: "row",
    gap: space[12],
    minWidth: 0,
    paddingHorizontal: space[12] - 1,
  },
  iconSpacer: { width: touchTarget },
  // A folder's rows step in under its mark, so they read as its contents.
  nested: { marginLeft: space[12] },
  projectsHead: {
    alignItems: "center",
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    marginTop: space[12],
    paddingLeft: space[12],
    paddingTop: space[4],
  },
  projectsTitle: {
    borderRadius: radius.xs,
    cursor: "pointer",
    flex: 1,
    justifyContent: "center",
    minHeight: touchTarget,
  },
  head: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: touchTarget,
    paddingBottom: space[4],
    paddingLeft: space[20],
    paddingRight: space[8],
  },
  iconButton: {
    cursor: "pointer",
    alignItems: "center",
    borderRadius: radius.full,
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  loading: { alignItems: "flex-start", paddingHorizontal: space[12], paddingVertical: space[12] },
  more: {
    cursor: "pointer",
    alignItems: "flex-start",
    borderRadius: radius.md,
    justifyContent: "center",
    minHeight: touchTarget,
    paddingLeft: taskTextInset,
  },
  tabs: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    gap: space[2],
    marginTop: space[4],
    paddingTop: space[8],
  },
  nav: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    gap: space[2],
    marginBottom: space[4],
    paddingBottom: space[8],
  },
  // Its own ground a step above the page. Where it is laid over the screen
  // (Android) its trailing corners are rounded, so it reads as a surface on
  // top rather than a second screen; where the screen slides aside to show it
  // (iOS) the screen's own edge is its boundary.
  panel: {
    backgroundColor: color.surfaceElevated,
    flex: 1,
    overflow: "hidden",
    ...Platform.select({
      android: {
        borderBottomRightRadius: radius.xxl,
        borderColor: color.lineStrong,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderTopRightRadius: radius.xxl,
      },
    }),
  },
  // Docked, it is a column of the screen: square, and on the screen's own ground.
  docked: { backgroundColor: color.background, borderRadius: 0, borderRightWidth: 0 },
  pressed: { ...material.quiet },
  scroll: { flex: 1 },
  moved: {
    backgroundColor: color.emberWash,
    borderRadius: radius.full,
    paddingHorizontal: space[6],
    paddingVertical: 1,
  },
  movedPressed: { backgroundColor: color.emberLine },
  movedText: { color: color.ember, fontVariant: ["tabular-nums"], fontWeight: "600" },
  shelf: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[8],
    marginTop: space[8],
    minHeight: Platform.OS === "android" ? 48 : touchTarget,
  },
  shelfCount: {
    alignSelf: "stretch",
    cursor: "pointer",
    justifyContent: "center",
    paddingRight: space[12] - 1,
  },
  shelfMark: { alignItems: "center", width: taskTextInset - space[12] * 2 },
  shelfOpen: {
    alignItems: "center",
    alignSelf: "stretch",
    cursor: "pointer",
    flex: 1,
    flexDirection: "row",
    gap: space[12],
    paddingLeft: space[12] - 1,
  },
  statusLine: { alignItems: "center", flex: 1, flexDirection: "row", gap: space[6], minWidth: 0 },
  welcome: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[6],
    marginHorizontal: space[4],
    marginTop: space[12],
    padding: space[16],
  },
});
