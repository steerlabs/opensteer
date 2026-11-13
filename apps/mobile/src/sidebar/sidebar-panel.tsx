import Animated from "react-native-reanimated";
import { move } from "../ui/motion.js";
import { SavedTasks } from "./saved-tasks.js";
import {
  doneTaskList,
  listedRowThreadId,
  quietlyMoved,
  quietSeenScope,
  sameTaskListSource,
  taskAttention,
  taskList,
  taskTime,
  type DoneTaskList,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type PersonalSurfaceDestination,
  type TaskList,
  type TaskRow,
} from "@opensteer/client/host";
import {
  useBrowserGroups,
  usePlace,
  usePlaceStructure,
  useSyncingPlaceholder,
} from "@opensteer/client/react";
import {
  memo,
  useCallback,
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
import { operationDetail } from "../client/mobile-client.js";
import { DeploymentMarkView } from "../threads/deployment-mark.js";
import {
  deploymentIdentity,
  sameDeploymentIdentity,
  type DeploymentIdentity,
} from "../threads/deployment-identity.js";
import {
  DraftPen,
  draftPenLabel,
  setTaskDone,
  taskTextInset,
  TaskRowView,
} from "../threads/task-row.js";
import {
  useHostUserId,
  useMobileClient,
  useMobileState,
  useSavedSurface,
} from "../ui/mobile-client-context.js";
import { useContentInsets } from "../ui/pane.js";
import { useRetainedScroll, type ScrollMemory } from "../ui/retained-scroll.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import type { TeamSessionClient } from "@opensteer/client/team";
import type { MobileTeam } from "../team/mobile-teams.js";
import { useCoordinatorSnapshot, useTeamsSnapshot } from "../team/team-context.js";
import { MentionCount, TeamTile } from "../team/team-marks.js";

/** The root places the drawer switches between. */
export type SidebarDestination = "Home" | "Schedules" | "Tabs";

export interface SidebarActions {
  /** Closes the drawer and hands focus back to whatever opened it. */
  readonly close: () => void;
  /** Home: a new task's composer. */
  readonly onHome: () => void;
  /** The Done page: every task in Done, newest Done first. */
  readonly onOpenDone: (deploymentId: string) => void;
  /** The sheet naming the tasks just moved to Done for the reader. */
  readonly onOpenQuietlyMoved: (deploymentId: string) => void;
  /** Shows exactly this tab, app or phone, alone. */
  readonly onOpenPlace: (destination: PersonalSurfaceDestination) => void;
  /** A task, at the request named when one is. */
  readonly onOpenTask: (deploymentId: string, threadId: string, requestId?: string) => void;
  /** A team's own page: its channels, then its direct messages. */
  readonly onOpenTeam: (teamId: string) => void;
  /** Create a team or join with an invite. */
  readonly onTeams: () => void;
  /** A hosted team still being set up: its progress. */
  readonly onTeamSetup: (hostedTeamId: string) => void;
  readonly onSchedules: () => void;
  readonly onSearch: (deploymentId: string) => void;
  readonly onSettings: () => void;
  readonly onTabs: () => void;
}

/** What the drawer shows of one Deployment's work: the shared task list and its Done. */
interface SidebarModel {
  /** Done, newest Done first, once read from a Host that keeps one. */
  readonly done: DoneTaskList | null;
  readonly list: TaskList;
  /** The Host has sent its first page of tasks. */
  readonly loaded: boolean;
  readonly quietScope: string | null;
}

/**
 * The shelves the drawer last drew, kept by the shell: the drawer and the
 * docked column are separate panels, and a closed one reads nothing, yet a task
 * opened from one must keep its place in whichever shows next.
 */
export interface ShelfMemory {
  list: Pick<TaskList, "ready"> | null;
}

/**
 * The selected Deployment's work as the drawer needs it, or null while no
 * Host of that Deployment is attached. It is rebuilt only when what the list
 * reads changes, so a streamed token leaves the drawer alone.
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
      current.snapshot.user === snapshot.user
    ) {
      return current.model;
    }
    const list = taskList(snapshot, {
      openThreadId: openThreadId === null ? null : listedRowThreadId(snapshot, openThreadId),
      previous: shelves.list,
    });
    const model = {
      done: doneTaskList(snapshot),
      list,
      loaded: snapshot.tasks !== null,
      quietScope: quietSeenScope(snapshot),
    };
    cached.current = { model, snapshot, openThreadId };
    shelves.list = model.list;
    return model;
  }, [hostClient, openThreadId, shelves]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Reads Done once a Host that keeps one is signed in; the Host client keeps it
 * current from then on.
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

const noReplies: ReadonlySet<string> = new Set();

/**
 * The tasks with an unsent reply, held until that set changes: the store
 * publishes every write, and a keystroke leaves it as it was.
 */
function useUnsentReplies(deploymentId: string | null, userId: string | null): ReadonlySet<string> {
  const { drafts } = useMobileClient();
  const cached = useRef(noReplies);
  const read = useCallback((): ReadonlySet<string> => {
    const next =
      deploymentId === null || userId === null
        ? noReplies
        : drafts.readDraftSummary(deploymentId, userId).threadIds;
    const current = cached.current;
    if (next.size !== current.size || [...next].some((id) => !current.has(id)))
      cached.current = next;
    return cached.current;
  }, [deploymentId, drafts, userId]);
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
 * The drawer: every open task — working, with anything waiting on the reader
 * first, then ready — until the Host moves it to Done, and Done's line; Automations;
 * one row per team this computer is in, each opening its own page; then the
 * Deployment's tabs, and below them Settings and which computer this is.
 *
 * Only an attached Host of the Deployment underneath is read. While the
 * selection is moving to another one, or that Host has refused this phone,
 * the tasks are simply absent rather than showing the previous Host's tasks.
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
  /** The task in front, marked as the one open. */
  readonly selectedThreadId: string | null;
  /** The team whose page or channel is in front. */
  readonly openTeamId: string | null;
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
  // Read only while the drawer is on screen: closed, it would otherwise
  // rebuild every row on every streamed update for a list nobody can see.
  const savedTasks = useSavedSurface(visible ? deploymentId : null, "tasks");
  const model = useSidebarModel(
    visible && savedTasks.source !== "saved" ? hostClient : null,
    selectedThreadId,
    props.shelves,
  );
  const identity = useDeploymentIdentity(deploymentId);
  const userId = useHostUserId(hostClient);
  const replies = useUnsentReplies(visible ? deploymentId : null, userId);
  const client = useMobileClient();
  const seen = useSyncExternalStore(
    client.quietSeen.subscribe,
    client.quietSeen.getSnapshot,
    client.quietSeen.getSnapshot,
  );
  useDoneList(hostClient);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierFailure, setEarlierFailure] = useState<string | null>(null);
  const heading = useRef<TextInstance>(null);
  const retained = useRetainedScroll(props.scroll);

  // A screen reader lands on the drawer's own heading as it opens; the drawer
  // isolates it from what it covers while it is there. Docked, it appears with
  // the window and takes nobody's focus.
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
  const moveTask = useCallback(
    (task: TaskRow, done: boolean) => {
      if (hostClient !== null) setTaskDone(hostClient, task.threadId, done);
    },
    [hostClient],
  );

  const selectedRowId = useMemo(() => {
    if (hostClient === null || selectedThreadId === null) return selectedThreadId;
    return listedRowThreadId(hostClient.getSnapshot(), selectedThreadId);
  }, [hostClient, selectedThreadId]);
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
  const openNeedsYou = useCallback(() => {
    if (hostClient === null || deploymentId === null || model === null) return;
    const first = model.list.working.find((task) => task.tone === "needs-you");
    if (first === undefined) return;
    const ask = taskAttention(hostClient.getSnapshot()).find(
      ({ threadId }) => threadId === first.threadId,
    );
    actions.onOpenTask(deploymentId, first.threadId, ask?.requestId);
  }, [actions, deploymentId, hostClient, model]);
  // The Thread in front has its draft in front of the reader already.
  const unsentReply = (threadId: string): boolean =>
    threadId !== selectedRowId && replies.has(threadId);
  // Times are read as the list draws, so a row that has not changed still ages.
  const now = Date.now();
  const list = model?.list ?? null;
  const shown = list === null ? [] : [...list.working, ...list.ready];
  const needsYou = list?.working.filter((task) => task.tone === "needs-you").length ?? 0;
  const doneCount = model?.done?.total ?? list?.done.length ?? 0;
  const moved =
    model === null || seen === null || model.quietScope === null
      ? []
      : quietlyMoved(model.done, seen[model.quietScope] ?? null, now);

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
          <>
            <IconButton
              icon="magnifyingglass"
              label="Search tasks"
              onPress={() => actions.onSearch(deploymentId)}
            />
            <IconButton icon="square.and.pencil" label="New task" onPress={actions.onHome} />
          </>
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
        {savedTasks.source === "saved" ? (
          <SavedTasks
            tasks={savedTasks.content}
            label={savedTasks.label}
            capturedAt={savedTasks.capturedAt}
          />
        ) : null}
        {model === null || list === null || deploymentId === null ? null : !model.loaded ? (
          <View style={styles.loading}>
            <ActivityIndicator color={color.muted} />
          </View>
        ) : (
          <>
            <TasksHead needsYou={needsYou} onNeedsYou={openNeedsYou} />
            {shown.length === 0 ? (
              <AppText role="caption" style={styles.empty} tone="muted">
                {doneCount === 0 && !list.hasMore
                  ? "Ask your agent for something and it shows up here while it works."
                  : "You’re all caught up."}
              </AppText>
            ) : (
              shown.map((task) => (
                <Animated.View key={task.threadId} layout={move}>
                  <TaskRowView
                    ask={task.tone === "needs-you" ? task.line : null}
                    drafted={unsentReply(task.threadId)}
                    onOpen={openTask}
                    onSetDone={moveTask}
                    row={task}
                    selected={task.threadId === selectedRowId}
                    shelf="open"
                    time={taskTime(task, now)}
                  />
                </Animated.View>
              ))
            )}
            {!list.hasMore ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: loadingEarlier }}
                disabled={loadingEarlier}
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
            )}
            {earlierFailure === null ? null : (
              <AppText role="caption" style={styles.empty} tone="danger">
                {earlierFailure}
              </AppText>
            )}
            {doneCount === 0 && moved.length === 0 ? null : (
              <DoneLine
                count={doneCount}
                moved={moved.length}
                onOpen={() => actions.onOpenDone(deploymentId)}
                onOpenMoved={() => actions.onOpenQuietlyMoved(deploymentId)}
              />
            )}
          </>
        )}

        <View style={styles.nav}>
          <DestinationRow
            current={destination === "Schedules"}
            icon="clock"
            label="Automations"
            onPress={actions.onSchedules}
          />
        </View>

        <TeamRows
          current={false}
          onOpen={actions.onOpenTeam}
          onSetup={actions.onTeamSetup}
          onTeams={actions.onTeams}
          openTeamId={props.openTeamId}
          visible={visible}
        />

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
          // Which computer this is, and the way into Settings, where it is
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
 * One row per team the person is in, as `MobileTeams` lists them: the team's name and the
 * mentions of the reader waiting there. It opens the team's own page. Each row
 * reads its own team's count, so a badge changing redraws only that row.
 */
function TeamRows(props: {
  /** The Teams page is in front. */
  readonly current: boolean;
  readonly onOpen: (teamId: string) => void;
  readonly onSetup: (hostedTeamId: string) => void;
  readonly onTeams: () => void;
  readonly openTeamId: string | null;
  readonly visible: boolean;
}): ReactNode {
  const { teams } = useTeamsSnapshot();
  const { hostedTeams } = useCoordinatorSnapshot();
  const settingUp = hostedTeams.filter((team) => team.stage !== "ready");
  // Between the nav's rule above and the tabs' rule below: no rule of its own.
  return (
    <View style={styles.teams}>
      {teams.map((team) => (
        <TeamRow
          current={props.openTeamId === team.teamId}
          key={team.teamId}
          onOpen={props.onOpen}
          team={team}
          visible={props.visible}
        />
      ))}
      {settingUp.map((team) => (
        <DestinationRow
          accessibilityLabel={`${team.name}, ${team.stage === "failed" ? "setup didn't finish" : "setting up"}`}
          accessory={
            team.stage === "failed" ? (
              <Text
                maxFontSizeMultiplier={controlFontScaleLimit}
                style={[type.caption, styles.count]}
              >
                Retry
              </Text>
            ) : (
              <ActivityIndicator color={color.muted} size="small" />
            )
          }
          current={false}
          icon="person.3"
          key={team.id}
          label={team.name}
          muted
          onPress={() => props.onSetup(team.id)}
        />
      ))}
      {teams.length > 0 || settingUp.length > 0 ? null : (
        <DestinationRow
          current={props.current}
          icon="person.3"
          label="Teams"
          onPress={props.onTeams}
        />
      )}
    </View>
  );
}

export const TeamRow = memo(function TeamRow(props: {
  readonly current: boolean;
  readonly onOpen: (teamId: string) => void;
  readonly team: MobileTeam;
  readonly visible: boolean;
}): ReactNode {
  const { team } = props;
  const mentions = useTeamMentions(props.visible ? team.session : null);
  const state =
    team.state === "update-app" || team.state === "update-server"
      ? "Update"
      : team.state === "offline"
        ? "Offline"
        : team.state === "removed"
          ? "Removed"
          : team.state === "signed-out"
            ? "Sign in"
            : null;
  return (
    <DestinationRow
      accessibilityLabel={[
        team.name,
        mentions > 0 ? `${mentions} ${mentions === 1 ? "mention" : "mentions"}` : null,
        state,
      ]
        .filter(Boolean)
        .join(", ")}
      accessory={
        state !== null ? (
          <Text maxFontSizeMultiplier={controlFontScaleLimit} style={[type.caption, styles.count]}>
            {state}
          </Text>
        ) : (
          <MentionCount count={mentions} />
        )
      }
      current={props.current}
      icon="person.3"
      label={team.name}
      mark={<TeamTile size={20} team={{ id: team.teamId, name: team.name, imageUri: null }} />}
      onPress={() => props.onOpen(team.teamId)}
    />
  );
});

/** Mentions of the reader across a team, read from that team's own session only. */
function useTeamMentions(session: TeamSessionClient | null): number {
  const read = useCallback(() => session?.getSnapshot().sidebar?.totalMentionCount ?? 0, [session]);
  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => undefined),
    [session],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * "Tasks", with the amber pill when something needs the reader: the pill
 * opens the first task that does, at its request.
 */
function TasksHead(props: {
  readonly needsYou: number;
  readonly onNeedsYou: () => void;
}): ReactNode {
  return (
    <View accessibilityRole="header" style={styles.groupHead}>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={[styles.groupTitle, styles.grow]}
        tone="muted"
      >
        Tasks
      </AppText>
      {props.needsYou === 0 ? null : (
        <Pressable
          accessibilityHint="Opens the first task that needs you"
          accessibilityLabel={
            props.needsYou === 1 ? "1 task needs you" : `${props.needsYou} tasks need you`
          }
          accessibilityRole="button"
          hitSlop={space[8]}
          onPress={props.onNeedsYou}
          style={({ pressed }) => [styles.amberPill, pressed && styles.pressed]}
        >
          <Symbol name="exclamationmark.circle" size={11} tint={color.inkOnAmber} weight="bold" />
          <Text
            maxFontSizeMultiplier={controlFontScaleLimit}
            style={[type.caption, styles.amberCount]}
          >
            {String(props.needsYou)}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

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
  readonly onOpen: (destination: PersonalSurfaceDestination) => void;
}): ReactNode {
  // The panel arranges slots; each row reads its own place, so a title repaints one row.
  const places = usePlaceStructure(props.hostClient);
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
  readonly onOpen: (destination: PersonalSurfaceDestination) => void;
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
  readonly onOpen: (destination: PersonalSurfaceDestination) => void;
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
  amberCount: { color: color.inkOnAmber, fontVariant: ["tabular-nums"], fontWeight: "700" },
  amberPill: {
    alignItems: "center",
    backgroundColor: color.amber,
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[2],
    paddingHorizontal: space[6],
    paddingVertical: 1,
  },
  grow: { flex: 1 },
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
  teams: { gap: space[2], marginBottom: space[4], paddingBottom: space[8] },
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
