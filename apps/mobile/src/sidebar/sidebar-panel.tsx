import Animated from "react-native-reanimated";
import { taskSlide } from "../threads/task-motion.js";
import { SavedTasks } from "./saved-tasks.js";
import { CHAT_THREAD_TITLE } from "@opensteer/core";
import {
  listedRowThreadId,
  mainWorkspace,
  sameTaskListSource,
  taskList,
  taskRowLabel,
  taskTime,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type TaskList,
  type TaskRow,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import { usePlaceList } from "@opensteer/client/react";
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
import { sameDestination } from "../browser/surface-route.js";
import { tabSiteLabel } from "../browser/tab-tiles.js";
import { deploymentStatusLabel } from "../client/deployment-rows.js";
import { operationDetail } from "../client/mobile-client.js";
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
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { DeploymentMarkView } from "../threads/deployment-mark.js";
import {
  deploymentSwitcherModel,
  sameDeploymentSwitcherModel,
  switcherAccessibilityLabel,
  type DeploymentSwitcherModel,
} from "../threads/deployment-switcher-model.js";
import {
  NeedsYouTag,
  setTaskDone,
  taskTextInset,
  TaskRowView,
  UnreadDot,
  type TaskShelf,
} from "../threads/task-row.js";
import { useMobileClient, useMobileState, useSavedSurface } from "../ui/mobile-client-context.js";
import { ChatOrb } from "../ui/chat-orb.js";
import { useContentInsets } from "../ui/pane.js";
import { useRetainedScroll, type ScrollMemory } from "../ui/retained-scroll.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";

/** The root destinations the sidebar switches between. */
export type SidebarDestination = "Home" | "Specialists" | "Tabs";

export interface SidebarActions {
  /** Closes the sidebar and hands focus back to whatever opened it. */
  readonly close: () => void;
  readonly onAddDeployment: () => void;
  readonly onChat: () => void;
  /** Closes the sidebar because the reader is going somewhere else. */
  readonly onLeave: () => void;
  readonly onNewTask: (deploymentId: string, workspaceId: string) => void;
  /** Shows exactly this tab, app or phone, alone. */
  readonly onOpenPlace: (destination: WorkspaceSurfaceDestination) => void;
  readonly onOpenTask: (deploymentId: string, threadId: string) => void;
  readonly onSearch: (deploymentId: string) => void;
  readonly onSettings: () => void;
  readonly onSpecialists: () => void;
  readonly onSwitchDeployment: () => void;
  readonly onTabs: () => void;
}

/**
 * What the sidebar shows of one Deployment's work: the shared task list, and
 * where a task started here would run.
 */
interface SidebarModel {
  readonly list: TaskList;
  /** The Host has sent its first page of tasks. */
  readonly loaded: boolean;
  /** Main, while it can hold a new task; a task started here runs there. */
  readonly taskWorkspaceId: string | null;
}

function sidebarModel(
  snapshot: HostSnapshot,
  openThreadId: string | null,
  previous: Pick<TaskList, "done"> | null,
): SidebarModel {
  const main = mainWorkspace(snapshot);
  return {
    list: taskList(snapshot, {
      openThreadId: openThreadId === null ? null : listedRowThreadId(snapshot, openThreadId),
      previous,
    }),
    loaded: snapshot.tasks !== null,
    taskWorkspaceId: main?.status === "ready" ? main.id : null,
  };
}

/**
 * The shelves the sidebar last drew, kept by the shell: the drawer and the
 * docked column are separate panels, and a closed one reads nothing, yet a task
 * opened from one must keep its shelf in whichever shows next.
 */
export interface ShelfMemory {
  list: Pick<TaskList, "done"> | null;
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
      current.snapshot.homeWorkspaceId === snapshot.homeWorkspaceId
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

/** The switcher's projection of the catalog, held across unrelated client updates. */
function useSwitcherModel(deploymentId: string | null): DeploymentSwitcherModel | null {
  const client = useMobileClient();
  const cached = useRef<DeploymentSwitcherModel | null>(null);
  const read = useCallback((): DeploymentSwitcherModel | null => {
    if (deploymentId === null) return null;
    const next = deploymentSwitcherModel(client.getSnapshot().rows, deploymentId);
    const current = cached.current;
    if (current !== null && sameDeploymentSwitcherModel(current, next)) return current;
    cached.current = next;
    return next;
  }, [client, deploymentId]);
  return useSyncExternalStore(client.subscribe, read, read);
}

/** Whether Done is open, as this phone last left it. */
function useDoneShelf(): readonly [boolean, () => void] {
  const client = useMobileClient();
  const [open, setOpen] = useState(false);
  const touched = useRef(false);
  useEffect(() => {
    let live = true;
    void client.doneShelf.read().then((stored) => {
      if (live && !touched.current) setOpen(stored);
    });
    return () => {
      live = false;
    };
  }, [client]);
  const toggle = useCallback(() => {
    touched.current = true;
    setOpen(!open);
    // A preference that did not save costs one tap next launch.
    void client.doneShelf.write(!open).catch(() => undefined);
  }, [client, open]);
  return [open, toggle];
}

/**
 * The sidebar is the one place to move between everything: Chat, New task and
 * Specialists; tasks grouped by what each asks of the reader — Working, with
 * anything waiting on them first; Ready; Done — then the Deployment's tabs,
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
  /** The tab, app or phone in front, marked as the one open. */
  readonly selectedPlace: WorkspaceSurfaceDestination | null;
  /** The task in front, marked as the one open. */
  readonly selectedThreadId: string | null;
  /** The task whose conversation is on screen; opening it never moves its row. */
  readonly openThreadId: string | null;
  readonly visible: boolean;
}): ReactNode {
  const insets = useContentInsets();
  const client = useMobileClient();
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
  const switcher = useSwitcherModel(deploymentId);
  const [doneOpen, toggleDone] = useDoneShelf();
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

  const switcherOptions = useMemo<readonly NativeMenuOption[]>(
    () =>
      switcher === null
        ? []
        : [
            ...switcher.items.map((item) => ({
              id: item.deploymentId,
              // A state the checkmark cannot say is written beside the name.
              label:
                item.current || item.glyph === null ? item.name : `${item.name} — ${item.status}`,
              onPress: () => {
                if (item.current) return;
                actions.onLeave();
                void AccessibilityInfo.announceForAccessibility("Opening deployment");
                void client.openDeployment(item.deploymentId).catch(() => {
                  // The switcher is where a row's status and its repair are stated.
                  actions.onSwitchDeployment();
                });
              },
              selected: item.current,
            })),
            ...(switcher.seeAll
              ? [{ id: "see-all", label: "See all…", onPress: actions.onSwitchDeployment }]
              : []),
            { id: "add", label: "Add deployment…", onPress: actions.onAddDeployment },
          ],
    [actions, client, switcher],
  );

  const list = model?.list ?? null;
  const taskWorkspaceId = model?.taskWorkspaceId ?? null;
  // A helper has no row, so the task it works for, or Chat, is the one marked open.
  const selectedRow = useMemo(() => {
    if (hostClient === null || model === null || selectedThreadId === null)
      return { chat: false, threadId: selectedThreadId };
    const snapshot = hostClient.getSnapshot();
    const threadId = listedRowThreadId(snapshot, selectedThreadId);
    return { chat: threadId === snapshot.homeThreadId, threadId };
  }, [hostClient, model, selectedThreadId]);
  // Times are read as the list draws, so a row that has not changed still ages.
  const now = Date.now();
  const taskRows = (tasks: readonly TaskRow[], shelf: TaskShelf) =>
    tasks.map((task) => (
      <Animated.View key={task.threadId} layout={taskSlide}>
        <TaskRowView
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
          paddingTop: insets.top + space[8],
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
            icon="bubble.left"
            mark={<ChatOrb size={20} />}
            label={CHAT_THREAD_TITLE}
            onPress={actions.onChat}
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
            current={destination === "Specialists"}
            icon="person.2"
            label="Specialists"
            onPress={actions.onSpecialists}
          />
        </View>

        {savedTasks.source === "saved" ? (
          <SavedTasks
            tasks={savedTasks.content}
            label={savedTasks.label}
            capturedAt={savedTasks.capturedAt}
          />
        ) : null}
        {model === null ? null : !model.loaded ? (
          <View style={styles.loading}>
            <ActivityIndicator color={color.muted} />
          </View>
        ) : model.list.working.length === 0 &&
          model.list.ready.length === 0 &&
          model.list.done.length === 0 &&
          !model.list.hasMore ? (
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
          // One keyed run of rows across every shelf, so a task changing shelves
          // keeps its view and slides to its new place instead of reappearing.
          [
            ...[
              { rows: model.list.working, title: "Working" },
              { rows: model.list.ready, title: "Ready" },
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
            model.list.working.length === 0 && model.list.ready.length === 0 ? (
              <AppText key="caught-up" role="caption" style={styles.empty} tone="muted">
                You’re all caught up.
              </AppText>
            ) : null,
            model.list.done.length === 0 ? null : (
              <Pressable
                accessibilityLabel={`Done, ${model.list.done.length} ${
                  model.list.done.length === 1 ? "task" : "tasks"
                }`}
                accessibilityRole="button"
                accessibilityState={{ expanded: doneOpen }}
                key="done-shelf"
                onPress={toggleDone}
                style={({ pressed }) => [styles.shelf, pressed && styles.pressed]}
              >
                <View style={styles.shelfMark}>
                  <Symbol
                    name={doneOpen ? "chevron.down" : "chevron.right"}
                    size={12}
                    tint={color.muted}
                  />
                </View>
                <AppText
                  maxFontSizeMultiplier={controlFontScaleLimit}
                  role="secondary"
                  tone="muted"
                >
                  Done
                </AppText>
                <AppText
                  maxFontSizeMultiplier={controlFontScaleLimit}
                  role="caption"
                  style={styles.count}
                >
                  {String(model.list.done.length)}
                </AppText>
              </Pressable>
            ),
            ...(doneOpen ? taskRows(model.list.done, "done") : []),
          ]
        )}

        {model === null || !model.list.hasMore ? null : (
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
              <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
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

        <View style={styles.tabs}>
          {hostClient === null || model === null ? (
            <GroupHead title="Tabs" />
          ) : (
            <SidebarTabs
              hostClient={hostClient}
              onOpen={actions.onOpenPlace}
              selected={props.selectedPlace}
            />
          )}
          <DestinationRow
            current={destination === "Tabs"}
            icon="rectangle.on.rectangle"
            label="All tabs"
            onPress={actions.onTabs}
          />
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space[8]) }]}>
        <DestinationRow
          current={false}
          icon="gearshape"
          label="Settings"
          onPress={actions.onSettings}
        />
        {switcher === null || row === undefined ? null : (
          <NativeMenu
            accessibilityHint="Shows the deployments on this phone"
            accessibilityLabel={`Deployment: ${switcherAccessibilityLabel(switcher)}`}
            onPresent={noop}
            onSettle={noop}
            options={switcherOptions}
            title="Deployments"
          >
            <View style={styles.deployment}>
              <DeploymentMarkView mark={switcher.mark} />
              <View style={styles.grow}>
                <AppText
                  maxFontSizeMultiplier={controlFontScaleLimit}
                  numberOfLines={1}
                  role="secondaryMedium"
                >
                  {switcher.name}
                </AppText>
                <View style={styles.statusLine}>
                  <StatusDot
                    live={row.status === "connecting" || row.status === "reconnecting"}
                    tone={statusTone(row.status)}
                  />
                  <AppText
                    maxFontSizeMultiplier={controlFontScaleLimit}
                    numberOfLines={1}
                    role="caption"
                    tone="muted"
                  >
                    {deploymentStatusLabel(row.status)}
                  </AppText>
                </View>
              </View>
              <Symbol name="chevron.down" size={12} tint={color.muted} />
            </View>
          </NativeMenu>
        )}
      </View>
    </View>
  );
});

function noop(): void {}

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
  readonly selected: WorkspaceSurfaceDestination | null;
}): ReactNode {
  const places = usePlaceList(props.hostClient);
  const { selected } = props;
  const shown = useMemo(() => {
    const first = places.slice(0, sidebarTabLimit);
    if (selected === null || first.some((place) => sameDestination(place.destination, selected)))
      return first;
    const open = places.find((place) => sameDestination(place.destination, selected));
    return open === undefined ? first : [...first, open];
  }, [places, selected]);
  return (
    <>
      <GroupHead count={places.length} title="Tabs" />
      {shown.map((place) => (
        <PlaceRow
          key={place.key}
          onOpen={props.onOpen}
          place={place}
          selected={selected !== null && sameDestination(place.destination, selected)}
        />
      ))}
    </>
  );
});

const placeGlyph: Record<PlaceItem["kind"], SFSymbolName> = {
  app: "desktopcomputer",
  browser: "globe",
  phone: "smartphone",
};

const placeKind: Record<PlaceItem["kind"], string> = {
  app: "App",
  browser: "Tab",
  phone: "Phone",
};

const PlaceRow = memo(function PlaceRow(props: {
  readonly onOpen: (destination: WorkspaceSurfaceDestination) => void;
  readonly place: PlaceItem;
  readonly selected: boolean;
}): ReactNode {
  const { onOpen, place, selected } = props;
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
      current={selected}
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
      accessibilityState={{ disabled: props.disabled === true }}
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
  readonly icon: SFSymbolName;
  readonly label: string;
  /** Still a place to go, but one that cannot show anything now. */
  readonly muted?: boolean;
  readonly onPress: () => void;
}): ReactNode {
  const disabled = props.disabled === true;
  const quiet = disabled || props.muted === true;
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
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
    minHeight: 56,
    paddingHorizontal: space[12] - 1,
    paddingVertical: space[8] - 1,
  },
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
    paddingTop: space[8],
  },
  grow: { flex: 1, minWidth: 0 },
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
  shelf: {
    ...material.plate,
    cursor: "pointer",
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[12],
    marginTop: space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[12] - 1,
  },
  shelfMark: { alignItems: "center", width: taskTextInset - space[12] * 2 },
  statusLine: { alignItems: "center", flexDirection: "row", gap: space[6] },
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
