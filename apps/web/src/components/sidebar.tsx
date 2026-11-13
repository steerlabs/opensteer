import { NeedsYouList } from "./needs-you-list.js";
import { TeamAskReview } from "./team-ask-review.js";
import { placeByKey } from "@opensteer/client/host";
import { DesktopUpdateButton } from "./desktop-update-button.js";
import { PendingBrowserTabRows } from "./workspace/pending-browser-tab.js";
import { taskMark, taskMarkQuiet } from "@opensteer/client/host";
import { TaskIconEditor } from "./task-icon-editor.js";
import { ThreadTitleEditor } from "./thread-title-editor.js";
import { useNativeBrowserLayer, useNativeBrowserOverlay } from "./native-browser-overlays.js";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { BrowserTabGroupColor } from "@opensteer/protocol";
import type { BrowserTabStrip } from "@opensteer/client/host";
import type {
  DeploymentAccessSnapshot,
  DesktopDeploymentSummary,
} from "@opensteer/protocol/desktop";
import {
  allTabs,
  browserTabStrip,
  browserSiteLabel,
  devicesElsewhere,
  placeDeviceLabels,
  sameDevicesElsewhere,
  tabListHomeId,
  tabFilterActive,
  tabFilterEmptyWords,
  type TabFilter,
  describeHostConnection,
  listedRowThreadId,
  doneDays,
  needsYouEntryKey,
  doneTaskList,
  quietlyMoved,
  quietSeenScope,
  taskList,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type PlaceDescriptor,
  type TaskRow,
} from "@opensteer/client/host";
import {
  useBrowserGroups,
  useHostSelector,
  usePlace,
  usePlaceStructure,
  useSyncingPlaceholder,
  useTabDeviceChoice,
  useTabFilterMatches,
  useVoiceValue,
} from "@opensteer/client/react";
import { LoadingRows } from "./loading-rows.js";
import { useWindowedRows } from "./workspace/windowed-rows.js";
import type { VoiceSnapshot } from "@opensteer/client/voice";
import { VoiceClock } from "./voice.js";
import { voiceRowKey } from "./voice-cursor.js";
import { deploymentNameFrom } from "./deployment-name.js";
import { selectedDeploymentFrom } from "../desktop/desktop-deployment-selection.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";
import { createPortal } from "react-dom";
import { actionErrorMessage, fromLivePage } from "../ui-utils.js";
import { useToast } from "./toast.js";
import { setAsideStagedFiles } from "./attachments/use-staged-attachments.js";
import {
  composerDraftKey,
  composerDrafts,
  useComposerDraftIndex,
  type ComposerDraftTarget,
} from "./composer-drafts.js";
import { TaskMark, TaskState, UnsentMark, taskStateWords } from "./workspace/task-mark.js";
import {
  ProfileAvatar,
  browserWords,
  useListedBrowserPresentations,
  type BrowserPresentation,
} from "./workspace/identity.js";
import { OccupantMarks, useFocusRescue } from "./workspace/occupant-marks.js";
import { PlaceMark } from "./workspace/place-mark.js";
import type { DeviceElsewhere } from "@opensteer/client/computers";
import { DeviceLabel } from "./computers/device-label.js";
import { useHereId } from "./computers/here.js";
import { useTaskDirectory, type TaskDirectory } from "./workspace/task-directory.js";
import { useTeams } from "../team/team-attachments.js";
import type { SegmentBadge } from "./team/team-sidebar.js";
import {
  useHighlightMatch,
  useWorkspace,
  type Highlight,
  type WorkspaceState,
} from "./workspace/workspace-context.js";
import {
  destinationPlaceKey,
  setupPath,
  taskAt,
  type WorkspaceNavigation,
} from "./workspace/navigation.js";
import { revealInList, useScrollEdges, useWholeRows } from "./workspace/scroll-edges.js";
import { useTabCloser } from "./workspace/tab-closer.js";
import { TabGroupHeader, tabGroupStyle } from "./workspace/tab-group.js";
import { NativeTabMenu, TabMenu, nativeTabMenuOffered } from "./workspace/tab-menu.js";
import { RowMotion } from "./workspace/row-motion.js";
import { fullHeightOf, SideSplit, useTabsHeight } from "./workspace/side-split.js";
import { DoneLine, useQuietSeen } from "./workspace/done-line.js";
import { SidebarSearch, type SidebarSearchSources } from "./sidebar-search.js";
import { TabFilterControl } from "./workspace/tab-filter.js";
import type { SortRow } from "./workspace/tab-sort.js";
import { useTabSort, type TabSortHandle } from "./workspace/use-tab-sort.js";
import { useTaskSnapshot } from "./task-rows.js";
import { useDesktopPlaces } from "../desktop/places-context.js";
import { PlaceMenuPlaces } from "./places/place-menu.js";
import { PlaceAccountFooter, SignOutDialog } from "./places/place-account.js";
import { TeamSideFor, TeamSwitch } from "../team/team-sidebar-sections.js";

export interface SidebarProps {
  collapsed: boolean;
  deploymentAccess: DeploymentAccessSnapshot | null;
  desktopDeployment: DesktopDeploymentSummary | null;
  desktopWindowChrome: boolean;
  hostClient: HostClient;
  mobileOpen: boolean;
  needsYouNotificationId?: string | null;
  mobile?: boolean;
  onCloseMobile: () => void;
  onLoadEarlierTasks: () => Promise<void>;
  onNewTab: () => void;
  onSetTaskDone: (threadId: string, done: boolean) => void;
  onToggleCollapsed: () => void;
}

/**
 * The one navigator: Needs you and Voice, the tasks by folder, each
 * team, the places open now, and a menu for everything else. A task row changes only the conversation; a tab row
 * only the middle; a mark on a tab both, as one step.
 */
export function Sidebar({
  needsYouNotificationId,
  collapsed,
  deploymentAccess,
  desktopDeployment,
  desktopWindowChrome,
  hostClient,
  mobileOpen,
  mobile = false,
  onCloseMobile,
  onLoadEarlierTasks,
  onNewTab,
  onSetTaskDone,
  onToggleCollapsed,
}: SidebarProps) {
  const workspace = useWorkspace();
  const { nav } = workspace;
  const { pathname, state: locationState } = useLocation();
  const snapshot = useTaskSnapshot(hostClient);
  const deploymentId = useHostSelector(hostClient, (current) => current.deploymentId);
  const userId = useHostSelector(hostClient, (current) => current.user?.id ?? null);
  const drafts = useComposerDraftIndex(deploymentId, userId);
  // The list arranges slots; each row reads its own place, so a title repaints one row.
  const slots = usePlaceStructure(hostClient);
  const groupList = useBrowserGroups(hostClient);
  const layout = useHostSelector(hostClient, (snapshot) => snapshot.browserTabGroups);
  const hereId = useHereId();
  const selectHome = useCallback(
    (snapshot: HostSnapshot) => tabListHomeId(snapshot, hereId),
    [hereId],
  );
  const homeId = useHostSelector(hostClient, selectHome);
  const selectElsewhere = useCallback(
    (snapshot: HostSnapshot) => devicesElsewhere(snapshot.machines, homeId),
    [homeId],
  );
  // Labels keep their identity while their devices stay the same, so rows stay undrawn.
  const elsewhere = useHostSelector(hostClient, selectElsewhere, sameDevicesElsewhere);
  const pendingTabs = useHostSelector(hostClient, (snapshot) => snapshot.pendingBrowserTabs);
  // A list still syncing with nothing to show shows its skeleton, never an empty state.
  const tabsSyncing = useSyncingPlaceholder(groupList.syncing, slots.length);
  const [chosenFilter, setFilter] = useState<TabFilter>(allTabs);
  const deviceChoice = useTabDeviceChoice(hostClient, hereId, homeId, chosenFilter);
  const filter = deviceChoice.filter;
  const filterDeviceName =
    deviceChoice.devices.find(({ id }) => id === filter.device)?.name ?? null;
  const [heldTabs, setHeldTabs] = useState<{
    readonly height: number;
    readonly rows: number;
  } | null>(null);
  useEffect(() => {
    setFilter(allTabs);
    setHeldTabs(null);
  }, [hostClient]);
  const tabsSection = useRef<HTMLElement | null>(null);
  // A filter draws fewer rows in the box all of them took, its floor included, so Tabs
  // keeps its height until the filter clears.
  const filterTabs = (next: TabFilter) => {
    if (!tabFilterActive(next)) setHeldTabs(null);
    else if (!tabFilterActive(filter) && tabsSection.current)
      setHeldTabs({ height: fullHeightOf(tabsSection.current), rows: slots.length });
    setFilter(next);
  };
  const shownPlaceKey =
    workspace.selection.kind === "place"
      ? destinationPlaceKey(workspace.selection.destination)
      : null;
  const matched = useTabFilterMatches(hostClient, filter);
  // The tab in front stays listed whatever the filter, so opening one never hides where you are.
  const filteredSlots = useMemo(
    () =>
      matched ? slots.filter((slot) => slot.key === shownPlaceKey || matched.has(slot.key)) : slots,
    [slots, matched, shownPlaceKey],
  );
  const liveStrip = browserTabStrip(filteredSlots, layout);
  const deviceLabels = useMemo(
    () => placeDeviceLabels(filteredSlots, elsewhere),
    [filteredSlots, elsewhere],
  );
  const searchDeviceLabels = useMemo(() => placeDeviceLabels(slots, elsewhere), [slots, elsewhere]);
  const toast = useToast();
  const tabsList = useRef<HTMLUListElement | null>(null);
  const motion = useRef<RowMotion | null>(null);
  const announcer = useRef<HTMLParagraphElement | null>(null);
  const sortRows = useMemo(() => sortRowsOf(liveStrip), [liveStrip]);
  const sort = useTabSort({
    strip: liveStrip,
    rows: sortRows,
    // Only a Host that keeps each person's order takes moves.
    movable: layout?.order !== undefined,
    list: tabsList,
    motion,
    move: (move) =>
      void hostClient
        .moveBrowserTabs(move)
        .catch((error: unknown) => toast.error(actionErrorMessage(error))),
    announce: (words) => {
      if (announcer.current) announcer.current.textContent = words;
    },
    title: (row) => rowTitle(hostClient, liveStrip, row),
  });
  // A lifted row must draw and take the pointer above a native page.
  useNativeBrowserOverlay(sort.lift !== null);
  // Until the drop the list stands as it was when the row lifted.
  const strip = sort.lift?.strip ?? liveStrip;
  const tabIndices = useMemo(
    () => new Map(strip.ordered.map((place, index) => [place.key, index])),
    [strip.ordered],
  );
  const [editingGroup, editGroup] = useState<string | null>(null);
  const presentations = useListedBrowserPresentations(hostClient);
  const deployment = selectedDeploymentFrom(deploymentAccess, desktopDeployment);
  const connection = describeHostConnection(snapshot);
  const placeName = deploymentNameFrom(deployment, snapshot) ?? "Opensteer";
  const [searching, setSearching] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const listsRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const searchButtonRef = useRef<HTMLButtonElement | null>(null);
  // Where the keyboard was when search opened, to go back to when it closes.
  const searchOpener = useRef<HTMLElement | null>(null);
  const searchOnOpen = useRef(false);
  const [tabsHeight, commitTabsHeight] = useTabsHeight();
  useWholeRows(listsRef, !collapsed);
  const { openDrawer } = workspace;
  const openThreadId = taskAt(pathname);
  const openRowThreadId = openThreadId === null ? null : listedRowThreadId(snapshot, openThreadId);
  const directory = useTaskDirectory(hostClient, openRowThreadId);
  const { list } = directory;
  const tasksList = useRef<HTMLUListElement | null>(null);
  const [side, setSide] = useSidebarSide(deploymentId, userId, pathname);
  // Entering a team the person just created or joined is their choice of side.
  const enteredTeam = enteredTeamOf(locationState);
  useEffect(() => {
    if (enteredTeam) setSide(enteredTeam);
  }, [enteredTeam, setSide]);
  const doneShelf = useRef<HTMLLIElement | null>(null);
  // Done takes the place of Tasks while it is open.
  const [doneView, setDoneView] = useState(false);
  const quietTasks = directory.snapshot.quietTasksAvailable === true;
  useEffect(() => {
    if (quietTasks) void hostClient.loadDoneTasks().catch(() => undefined);
  }, [hostClient, quietTasks, userId]);
  const doneList = useMemo(() => doneTaskList(directory.snapshot), [directory.snapshot]);
  const doneRows = doneList?.rows ?? list.done;
  const doneCount = doneList?.total ?? list.done.length;
  const [quietSeen, markQuietSeen] = useQuietSeen(quietSeenScope(directory.snapshot));
  const moved = useMemo(() => quietlyMoved(doneList, quietSeen, Date.now()), [doneList, quietSeen]);
  const openDone = () => {
    setDoneView(true);
    markQuietSeen(moved);
  };
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const doneActive = !doneView && doneRows.some((row) => row.threadId === openRowThreadId);
  useEffect(() => {
    if (doneActive && doneShelf.current) revealInList(doneShelf.current);
  }, [doneActive, openRowThreadId]);

  const allTasks = useMemo(() => [...list.working, ...list.ready, ...list.done], [list]);
  const searchSources = useMemo<SidebarSearchSources>(
    () => ({
      tasks: allTasks,
      attention: directory.attentionByThread,
      snapshot,
    }),
    [allTasks, directory.attentionByThread, snapshot],
  );

  const openSearch = useCallback(() => {
    const focused = document.activeElement;
    if (focused !== searchRef.current)
      searchOpener.current =
        focused instanceof HTMLElement && focused !== document.body ? focused : null;
    setSearching(true);
    queueMicrotask(() => searchRef.current?.focus());
  }, []);
  const closeSearch = () => setSearching(false);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (fromLivePage(event)) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "k") {
        event.preventDefault();
        // Search lives in the sidebar, so a hidden sidebar or a closed drawer opens to show it.
        if (collapsed) onToggleCollapsed();
        if (mobile && !mobileOpen) {
          searchOnOpen.current = true;
          openDrawer();
        }
        openSearch();
      } else if (key === "\\" && !mobile) {
        event.preventDefault();
        onToggleCollapsed();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [collapsed, mobile, mobileOpen, onToggleCollapsed, openDrawer, openSearch]);

  useEffect(() => {
    if (!mobile || !mobileOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.documentElement.classList.add("sidebar-drawer-open");
    // Opened by ⌘K, the drawer hands the keyboard to Search, not its close button.
    if (searchOnOpen.current) searchRef.current?.focus();
    else closeRef.current?.focus();
    searchOnOpen.current = false;
    return () => {
      document.documentElement.classList.remove("sidebar-drawer-open");
      if (opener?.isConnected) opener.focus();
    };
  }, [mobile, mobileOpen]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!mobile || !mobileOpen) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      onCloseMobile();
      return;
    }
    if (event.key !== "Tab") return;
    const container = sidebarRef.current;
    if (!container) return;
    const focusable = [
      ...container.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (element) =>
        // Lists searched over stand laid out but inert: the keyboard does not go there.
        !element.closest("[inert]") &&
        (element.offsetParent !== null || element === document.activeElement),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Read when pressed, so a change of place re-renders no row for these.
  const navRef = useRef(nav);
  navRef.current = nav;
  const openPlace = useCallback(
    (place: PlaceItem) => {
      onCloseMobile();
      navRef.current.showPlace(place.destination);
    },
    [onCloseMobile],
  );
  const openTask = useCallback(
    (threadId: string) => {
      onCloseMobile();
      navRef.current.openConversation(navRef.current.threadPath(threadId));
    },
    [onCloseMobile],
  );
  const openMark = useCallback(
    (place: PlaceItem, threadId: string) => {
      onCloseMobile();
      navRef.current.showPlaceWithConversation(
        place.destination,
        navRef.current.threadPath(threadId),
      );
    },
    [onCloseMobile],
  );
  const [needsYouOpen, setNeedsYouOpen] = useState(false);
  const [reviewAskKey, setReviewAskKey] = useState<string | null>(null);
  const needsYouPage = useHostSelector(hostClient, (current) => current.needsYou);
  const teamAsks = needsYouPage?.entries.filter((entry) => entry.kind === "team-ask") ?? [];
  const reviewAsk = teamAsks.find((entry) => needsYouEntryKey(entry) === reviewAskKey);
  const needsYouCount = needsYouPage?.count ?? 0;
  const openNeedsYou = useCallback(() => setNeedsYouOpen(true), []);
  const handledNeedsYouNotification = useRef<string | null>(null);
  useEffect(() => {
    if (
      !needsYouNotificationId ||
      handledNeedsYouNotification.current === needsYouNotificationId ||
      needsYouPage === null
    )
      return;
    handledNeedsYouNotification.current = needsYouNotificationId;
    openNeedsYou();
  }, [needsYouNotificationId, needsYouPage, openNeedsYou]);
  const newTask = () => {
    onCloseMobile();
    nav.openConversation("/");
  };
  const openVoice = () => {
    onCloseMobile();
    nav.openConversation("/voice");
  };
  const discardDraft = (target: ComposerDraftTarget) => {
    if (!deploymentId || !userId) return;
    const key = composerDraftKey({ deploymentId, userId }, target);
    const draft = composerDrafts.read(key);
    if (!draft) return;
    const files = setAsideStagedFiles(key);
    composerDrafts.clear(key);
    toast.success("Draft discarded", {
      label: "Undo",
      lapse: files.forget,
      run: () => {
        composerDrafts.restore(key, draft);
        files.takeBack();
      },
    });
  };
  const loadMore = () => void onLoadEarlierTasks().catch(() => undefined);
  const loadEarlier = () => {
    if (loadingEarlier) return;
    setLoadingEarlier(true);
    void (doneView && quietTasks ? hostClient.loadEarlierDoneTasks() : onLoadEarlierTasks())
      .catch(() => undefined)
      .finally(() => setLoadingEarlier(false));
  };
  // Put away, the sidebar is gone entirely; the restore control in the
  // conversation's or the place's head (with the count) and ⌘\ bring it back.
  if (collapsed)
    return (
      <nav
        aria-label="Main navigation"
        className="sidebar sidebar--collapsed"
        hidden
        id="app-sidebar"
      />
    );

  const classes = ["sidebar"];
  if (mobileOpen) classes.push("sidebar--open");
  const rows = [...list.working, ...list.ready];
  const days = doneView ? doneDays(doneRows, Date.now()) : [];
  const doneMore = doneList?.hasMore ?? list.hasMore;
  const doneLine = doneCount > 0 || moved.length > 0;
  const rowKeys = doneView
    ? [
        ...days.flatMap((day) => [`day:${day.id}`, ...day.rows.map((row) => row.threadId)]),
        ...(doneMore ? ["show-more"] : []),
      ]
    : [
        ...rows.map((row) => row.threadId),
        ...(list.hasMore ? ["show-more"] : []),
        ...(doneLine ? ["done-shelf"] : []),
      ];
  const showMore = (
    <li data-motion-key="show-more" key="show-more">
      <button
        className="sidebar__more"
        disabled={loadingEarlier}
        onClick={loadEarlier}
        type="button"
      >
        {loadingEarlier ? "Loading…" : "Show more"}
      </button>
    </li>
  );
  const taskRow = (row: TaskRow) => (
    <TaskRowItem
      hostClient={hostClient}
      ask={directory.attentionByThread.get(row.threadId)?.title ?? null}
      key={row.threadId}
      onDiscardDraft={discardDraft}
      onNavigate={onCloseMobile}
      onSetDone={onSetTaskDone}
      open={row.threadId === openRowThreadId}
      row={row}
      unsent={drafts.replies.has(row.threadId)}
      workspace={workspace}
    />
  );
  const startPageOpen = workspace.selection.kind === "launcher";
  // The order the tab list shows; a change slides its rows to their new places.
  const motionSignature = [
    ...strip.web.map((row) =>
      row.kind === "place"
        ? row.place.key
        : row.group.collapsed || row.group.id === sort.lift?.groupId
          ? row.group.id
          : `${row.group.id}:${row.places.map((place) => place.key).join(",")}`,
    ),
    ...strip.native.map((place) => place.key),
    startPageOpen ? "start" : "new",
  ].join("|");
  const newTab = () => {
    onCloseMobile();
    onNewTab();
  };
  const tabRow = (slot: PlaceDescriptor, index: number, groupColor?: BrowserTabGroupColor) => (
    <TabRowItem
      sort={slot.personalTab ? sort.handle : null}
      groupColor={groupColor}
      onEditGroup={editGroup}
      active={slot.key === shownPlaceKey}
      badges={presentations.badges}
      directory={directory}
      hostClient={hostClient}
      index={index}
      device={deviceLabels.get(slot.key) ?? null}
      hereId={hereId}
      key={slot.key}
      onOpen={openPlace}
      onOpenMark={openMark}
      placeKey={slot.key}
      highlight={workspace.highlight}
      localMachine={workspace.localMachine}
      presentation={
        slot.browser ? (presentations.bySession.get(slot.browser.sessionId) ?? null) : null
      }
    />
  );
  // Every row the tab list has, in order; the window draws those in view.
  const tabEntries: TabEntry[] = [];
  const entry = (key: string, size: number, render: () => ReactNode) =>
    tabEntries.push({ key, size, render });
  if (matched && matched.size === 0)
    entry("filter-empty", rowSize, () => (
      <li
        className="sidebar__empty"
        data-motion-key="filter-empty"
        key="filter-empty"
        role="status"
      >
        {`${tabFilterEmptyWords(filter, filterDeviceName)}.`}
      </li>
    ));
  if (tabsSyncing)
    entry("syncing", rowSize * 3, () => (
      <li className="side-list__loading" data-motion-key="syncing" key="syncing">
        <LoadingRows label="Loading tabs" />
      </li>
    ));
  for (const row of strip.web) {
    if (row.kind === "place") {
      const slot = row.place;
      entry(slot.key, rowSize, () => tabRow(slot, tabIndices.get(slot.key)!));
      continue;
    }
    // A group on the move folds its tabs under its header until it lands.
    const moving = row.group.id === sort.lift?.groupId;
    entry(row.group.id, rowSize, () => (
      <TabGroupHeader
        active={row.places.some((place) => place.key === shownPlaceKey)}
        directory={directory}
        editing={editingGroup === row.group.id}
        group={moving ? { ...row.group, collapsed: true } : row.group}
        hostClient={hostClient}
        key={row.group.id}
        onEdit={editGroup}
        onOpenMark={openMark}
        places={row.places}
        sort={sort.handle}
      />
    ));
    if (!row.group.collapsed && !moving)
      for (const slot of row.places)
        entry(slot.key, rowSize, () => tabRow(slot, tabIndices.get(slot.key)!, row.group.color));
  }
  for (const pending of pendingTabs ?? [])
    entry(`pending:${pending.idempotencyKey}`, rowSize, () => (
      <PendingBrowserTabRows
        hostClient={hostClient}
        key={`pending:${pending.idempotencyKey}`}
        onOpen={onCloseMobile}
        rows={[pending]}
      />
    ));
  if (strip.native.length > 0 && strip.web.length > 0)
    entry("divider", 0, () => (
      <li aria-hidden className="side-divider" data-motion-key="divider" key="divider" />
    ));
  for (const slot of strip.native)
    entry(slot.key, rowSize, () => tabRow(slot, tabIndices.get(slot.key)!));
  entry(startPageOpen ? "start" : "new", rowSize, () =>
    startPageOpen ? (
      <li className="side-tab side-tab--start is-active" data-motion-key="start" key="start">
        <button
          aria-current="true"
          className="side-tab__main"
          onClick={() => {
            onCloseMobile();
            newTab();
          }}
          type="button"
        >
          <span aria-hidden className="place-mark place-mark--glyph">
            <Icon name="plus" />
          </span>
          <span className="side-tab__title">New tab</span>
        </button>
        <button
          aria-label="Close New tab"
          className="side-row-action side-tab__close"
          onClick={() => workspace.startPage.leave()}
          title="Close"
          type="button"
        >
          <Icon name="close" />
        </button>
      </li>
    ) : (
      <li className="side-new" data-motion-key="new" key="new">
        <button className="side-new__main" onClick={newTab} type="button">
          <Icon name="plus" />
          <span>New tab</span>
        </button>
      </li>
    ),
  );

  return (
    <nav
      aria-hidden={mobile && !mobileOpen}
      aria-label="Main navigation"
      className={classes.join(" ")}
      id="app-sidebar"
      inert={mobile && !mobileOpen}
      onKeyDown={handleKeyDown}
      ref={sidebarRef}
    >
      {needsYouOpen && !reviewAsk ? (
        <NeedsYouList
          client={hostClient}
          onClose={() => setNeedsYouOpen(false)}
          onOpen={(entry) => {
            if (entry.kind === "team-ask") setReviewAskKey(needsYouEntryKey(entry));
            else {
              setNeedsYouOpen(false);
              onCloseMobile();
              nav.openConversation(nav.threadPath(entry.navigationThreadId), {
                focusRequest: entry.request.id,
              });
            }
          }}
        />
      ) : null}
      {reviewAsk ? (
        <TeamAskReview
          key={needsYouEntryKey(reviewAsk)}
          entry={reviewAsk}
          client={hostClient}
          onClose={() => setReviewAskKey(null)}
        />
      ) : null}
      <div className="sidebar__header">
        <h1 className="sidebar__title">Opensteer</h1>
        <VoiceButton onOpen={openVoice} />
        <button
          aria-expanded={searching}
          aria-label="Search"
          className="icon-btn"
          onClick={openSearch}
          ref={searchButtonRef}
          title="Search · ⌘K"
          type="button"
        >
          <Icon name="search" />
        </button>
        {mobileOpen ? (
          <button
            ref={closeRef}
            aria-label="Close navigation"
            className="icon-btn"
            onClick={onCloseMobile}
            type="button"
          >
            <Icon name="close" />
          </button>
        ) : (
          <button
            aria-label="Collapse sidebar"
            className="icon-btn"
            onClick={onToggleCollapsed}
            title="Collapse sidebar · ⌘\\"
            type="button"
          >
            <Icon name="panel" />
          </button>
        )}
      </div>
      <TasksBadgeSwitch
        hostClient={hostClient}
        onNavigate={onCloseMobile}
        onSide={setSide}
        side={side}
      />

      <SidebarSearch
        badges={presentations.badges}
        fallbackFocusRef={searchButtonRef}
        hasMore={list.hasMore}
        hostClient={hostClient}
        inputRef={searchRef}
        listsRef={listsRef}
        listsStyle={
          tabsHeight === null
            ? undefined
            : ({ "--side-tabs-height": `${tabsHeight}px` } as CSSProperties)
        }
        deviceLabels={searchDeviceLabels}
        onClose={closeSearch}
        onLoadMore={loadMore}
        onOpenPlace={openPlace}
        onOpenTask={openTask}
        open={searching}
        openerRef={searchOpener}
        openThreadId={openThreadId}
        shownPlaceKey={shownPlaceKey}
        sources={searchSources}
      >
        <section
          aria-labelledby={side === "tasks" ? "sidebar-tasks" : undefined}
          aria-label={side === "tasks" ? undefined : "Team"}
          className="side-section side-section--tasks"
          onKeyDown={(event) => {
            if (doneView && event.key === "Escape" && !event.defaultPrevented) setDoneView(false);
          }}
          style={sectionFloor(side === "tasks" ? rowKeys.length + 1 : 8)}
        >
          {side === "tasks" ? (
            <>
              {teamAsks.map((entry) => (
                <button
                  className="side-task"
                  type="button"
                  key={entry.requestId}
                  onClick={() => setReviewAskKey(needsYouEntryKey(entry))}
                >
                  {entry.presentation.asker.displayName}
                  {entry.presentation.asker.actor === "agent" ? "'s agent" : ""} · #
                  {entry.presentation.audience.channelName}
                </button>
              ))}
              {doneView ? (
                <div className="side-head side-head--done">
                  <button
                    aria-label="Back to Tasks"
                    className="icon-btn icon-btn--small side-head__back"
                    onClick={() => setDoneView(false)}
                    title="Back to Tasks · Esc"
                    type="button"
                  >
                    <Icon name="chevron-left" />
                  </button>
                  <h2 className="side-head__title" id="sidebar-tasks">
                    Done
                  </h2>
                  <span className="side-head__count">{doneCount}</span>
                </div>
              ) : (
                <div className="side-head">
                  <h2 className="side-head__title" id="sidebar-tasks">
                    Tasks
                  </h2>
                  {needsYouCount > 0 ? (
                    <button
                      aria-label={`${needsYouCount} need you. Open Needs you`}
                      className="side-needs"
                      onClick={openNeedsYou}
                      title="Open Needs you"
                      type="button"
                    >
                      <span aria-hidden className="side-needs__bang">
                        !
                      </span>
                      <span aria-hidden>{needsYouCount}</span>
                    </button>
                  ) : null}
                  <button
                    aria-label="New task"
                    className="icon-btn icon-btn--small side-head__action"
                    onClick={newTask}
                    title="New task · ⌘N"
                    type="button"
                  >
                    <Icon name="plus" />
                  </button>
                </div>
              )}
              <SideList labelledBy="sidebar-tasks" listRef={tasksList} whole>
                <RowMotion
                  snap={false}
                  list={tasksList}
                  signature={rowKeys.join(",")}
                  lifted={false}
                >
                  {/* One keyed run, so a row that moves keeps its element and focus,
                      and slides to its new place. */}
                  {doneView
                    ? [
                        ...days.flatMap((day) => [
                          <li
                            className="side-day"
                            data-motion-key={`day:${day.id}`}
                            key={`day:${day.id}`}
                          >
                            <h3 className="side-day__title">{day.title}</h3>
                          </li>,
                          ...day.rows.map((row) => taskRow(row)),
                        ]),
                        ...(days.length === 0
                          ? [
                              <li
                                className="sidebar__empty"
                                data-motion-key="done-empty"
                                key="done-empty"
                              >
                                Nothing in Done yet.
                              </li>,
                            ]
                          : []),
                        ...(doneMore ? [showMore] : []),
                      ]
                    : [
                        ...rows.map((row) => taskRow(row)),
                        ...(list.hasMore ? [showMore] : []),
                        ...(doneLine
                          ? [
                              <DoneLine
                                active={doneActive}
                                count={doneCount}
                                hostClient={hostClient}
                                key="done-shelf"
                                lineRef={doneShelf}
                                moved={moved}
                                onOpen={openDone}
                                onOpenTask={openTask}
                                onSeen={markQuietSeen}
                                quietTaskDays={directory.snapshot.quietTaskDays}
                              />,
                            ]
                          : []),
                      ]}
                </RowMotion>
              </SideList>
            </>
          ) : (
            <TeamSideFor onNavigate={onCloseMobile} teamId={side} />
          )}
        </section>
        <SideSplit onCommit={commitTabsHeight} />
        <section
          aria-labelledby="sidebar-tabs"
          className="side-section side-section--tabs"
          ref={tabsSection}
          style={{ ...sectionFloor(heldTabs?.rows ?? slots.length), maxHeight: heldTabs?.height }}
        >
          <div className="side-head">
            <h2 className="side-head__title" id="sidebar-tabs" tabIndex={-1}>
              Tabs
            </h2>
            <TabFilterControl
              devices={deviceChoice.devices}
              hostClient={hostClient}
              onChange={filterTabs}
              value={filter}
            />
            {slots.length > 0 ? (
              <button
                aria-label="New tab"
                className="icon-btn icon-btn--small side-head__action"
                onClick={newTab}
                title={desktopWindowChrome ? "New tab · ⌘T" : "New tab"}
                type="button"
              >
                <Icon name="plus" />
              </button>
            ) : null}
          </div>
          <SideList labelledBy="sidebar-tabs" listRef={tabsList}>
            <RowMotion
              lifted={sort.lift !== null}
              list={tabsList}
              ref={motion}
              signature={motionSignature}
            >
              <WindowedTabRows
                all={sort.lift !== null}
                entries={tabEntries}
                list={tabsList}
                pinned={[
                  shownPlaceKey ?? "",
                  editingGroup ?? "",
                  workspace.selection.kind === "pending"
                    ? `pending:${workspace.selection.idempotencyKey}`
                    : "",
                  "filter-empty",
                  "syncing",
                  startPageOpen ? "start" : "new",
                ]}
              />
            </RowMotion>
          </SideList>
          <p aria-live="polite" className="visually-hidden" ref={announcer} />
          <RowTip root={sidebarRef} />
        </section>
      </SidebarSearch>

      <SidebarFooter
        connection={connection}
        onCloseMobile={onCloseMobile}
        onThisComputer={deployment?.onThisComputer === true}
        placeName={placeName}
        workspace={workspace}
      />
    </nav>
  );
}

/** One row of the tab list, drawn only while the window holds it. */
interface TabEntry {
  readonly key: string;
  /** Its size before it is measured. */
  readonly size: number;
  readonly render: () => ReactNode;
}

/** A tab row's height and the list's gap after it, before one is measured. */
const rowSize =
  typeof window !== "undefined" && window.matchMedia?.("(any-pointer: coarse)").matches ? 45 : 33;

/**
 * The tab list's rows, windowed: a long list draws the rows in view and the
 * ones a person is on (the tab in the middle, the focused row, an open
 * editor), so scrolling renders only this and a title repaints only its row.
 */
function WindowedTabRows({
  all,
  entries,
  list,
  pinned,
}: {
  /** A drag measures every row, so all are drawn until it drops. */
  readonly all: boolean;
  readonly entries: readonly TabEntry[];
  readonly list: RefObject<HTMLUListElement | null>;
  readonly pinned: readonly string[];
}) {
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const keyOf = (target: EventTarget | null) =>
      target instanceof HTMLElement
        ? (target.closest<HTMLElement>("[data-motion-key]")?.dataset.motionKey ?? null)
        : null;
    const focus = (event: FocusEvent) => setFocused(keyOf(event.target));
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !node.contains(event.relatedTarget))
        setFocused(null);
    };
    node.addEventListener("focusin", focus);
    node.addEventListener("focusout", blur);
    return () => {
      node.removeEventListener("focusin", focus);
      node.removeEventListener("focusout", blur);
    };
  }, [list]);
  const keys = useMemo(() => entries.map(({ key }) => key), [entries]);
  const plan = useWindowedRows({
    list,
    keys,
    estimate: (index) => entries[index]!.size,
    pinned: focused === null ? pinned : [...pinned, focused],
    all,
  });
  return plan.map((item, order) =>
    "index" in item ? (
      entries[item.index]!.render()
    ) : (
      <li
        aria-hidden
        className="side-list__spacer"
        key={`spacer:${order}`}
        style={{ height: item.spacer }}
      />
    ),
  );
}

/** Neither section shrinks below its first few rows (or all of them, when fewer). */
function sectionFloor(rows: number): CSSProperties {
  return { "--side-floor-rows": Math.min(rows, 3) } as CSSProperties;
}

/**
 * A section's rows: they scroll on their own, a hairline only at an edge with
 * more beyond; `whole` lists show only whole rows. Tabs, last, is not one: it
 * runs to the footer, its rows snapping to its top, but at its end, where its
 * last row stands whole on the footer's line.
 */
function SideList({
  children,
  labelledBy,
  listRef,
  whole = false,
}: {
  readonly children: ReactNode;
  readonly labelledBy?: string;
  readonly listRef?: RefObject<HTMLUListElement | null>;
  readonly whole?: boolean;
}) {
  const ownRef = useRef<HTMLUListElement | null>(null);
  const ref = listRef ?? ownRef;
  useScrollEdges(ref);
  return (
    <ul
      aria-labelledby={labelledBy}
      className="side-list"
      data-scroll-edges=""
      data-whole-rows={whole ? "" : undefined}
      ref={ref}
    >
      {children}
    </ul>
  );
}

const selectSince = ({ since }: VoiceSnapshot) => since;

/** Voice, in the header: its clock while a call is live. */
function VoiceButton({ onOpen }: { readonly onOpen: () => void }) {
  const since = useVoiceValue(selectSince);
  return (
    <button
      aria-label={since !== null ? "Voice, call live" : "Voice"}
      className={since !== null ? "icon-btn sidebar__voice is-live" : "icon-btn sidebar__voice"}
      onClick={onOpen}
      title="Voice"
      type="button"
    >
      <Icon name="waveform" />
      {since !== null ? <VoiceClock /> : null}
    </button>
  );
}

/**
 * Which side of the switch shows. On load it follows the address (a channel
 * opens on its team, a task on Tasks), else what this person last chose here;
 * after that only the person changes it.
 */
function useSidebarSide(
  deploymentId: string | null,
  userId: string | null,
  pathname: string,
): readonly [string, (side: string) => void] {
  const key = `opensteer.sidebar.side:${deploymentId ?? ""}:${userId ?? ""}`;
  const loadedAt = useRef(pathname).current;
  const [chosen, setChosen] = useState<{ readonly key: string; readonly side: string } | null>(
    null,
  );
  const loaded = useMemo(() => routeSide(loadedAt) ?? storedSide(key), [key, loadedAt]);
  const side = chosen?.key === key ? chosen.side : loaded;
  const { teams } = useTeams();
  const choose = useCallback(
    (next: string) => {
      setChosen({ key, side: next });
      try {
        localStorage.setItem(key, next);
      } catch {
        // The choice still holds for this window.
      }
    },
    [key],
  );
  // A team that is gone leaves its side; Tasks is what remains.
  return [side === "tasks" || teams.some((team) => team.teamId === side) ? side : "tasks", choose];
}

/** The team a navigation entered, as `TeamDialogsProvider` marks it. */
export function enteredTeamOf(state: unknown): string | null {
  return typeof state === "object" &&
    state !== null &&
    "enteredTeam" in state &&
    typeof state.enteredTeam === "string"
    ? state.enteredTeam
    : null;
}

function routeSide(pathname: string): string | null {
  const team = /^\/teams\/([^/]+)\//u.exec(pathname);
  if (team) return decodeURIComponent(team[1]!);
  return pathname.startsWith("/tasks/") ? "tasks" : null;
}

function storedSide(key: string): string {
  try {
    return localStorage.getItem(key) ?? "tasks";
  } catch {
    return "tasks";
  }
}

const selectTasksBadge = (snapshot: HostSnapshot): SegmentBadge => {
  const needs = snapshot.needsYou?.count ?? 0;
  if (needs > 0) return { kind: "needs-you", count: needs };
  return taskList(snapshot).ready.some((row) => row.unread) ? { kind: "new" } : null;
};
const sameBadge = (left: SegmentBadge, right: SegmentBadge) =>
  JSON.stringify(left) === JSON.stringify(right);

/** The switch, with the Tasks badge read here so it never redraws the lists. */
function TasksBadgeSwitch({
  hostClient,
  onNavigate,
  onSide,
  side,
}: {
  readonly hostClient: HostClient;
  readonly onNavigate: () => void;
  readonly onSide: (side: string) => void;
  readonly side: string;
}) {
  const badge = useHostSelector(hostClient, selectTasksBadge, sameBadge);
  return <TeamSwitch onNavigate={onNavigate} onSide={onSide} side={side} tasksBadge={badge} />;
}

/**
 * A conversation row's plain click opens it beside the place the address
 * shows now, not the one the row last rendered with: a tab chosen a moment
 * ago, still rendering, stays in the middle. Other clicks keep the link's own.
 */
function openConversationRow(
  event: MouseEvent<HTMLAnchorElement>,
  nav: WorkspaceNavigation,
  path: string,
  draftId?: string,
): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  nav.openConversation(path, draftId ? { draftId } : undefined);
}

/* ---- Tasks ---- */

const TaskRowItem = memo(function TaskRowItem({
  hostClient,
  ask,
  onDiscardDraft,
  onNavigate,
  onSetDone,
  open,
  row,
  unsent,
  workspace,
}: {
  readonly hostClient: HostClient;
  readonly ask: string | null;
  readonly onDiscardDraft: (target: ComposerDraftTarget) => void;
  readonly onNavigate: () => void;
  readonly onSetDone: (threadId: string, done: boolean) => void;
  readonly open: boolean;
  readonly row: TaskRow;
  /** A reply is waiting here, unsent. */
  readonly unsent: boolean;
  readonly workspace: WorkspaceState;
}) {
  const { highlight, nav, work } = workspace;
  const threadId = row.threadId;
  const canRename = useHostSelector(hostClient, (snapshot) => snapshot.threadRenameAvailable);
  const [editing, setEditing] = useState(false);
  const [changingIcon, setChangingIcon] = useState(false);
  const canChangeIcon = useHostSelector(hostClient, (snapshot) => snapshot.taskMarksAvailable);
  const [menuAt, setMenuAt] = useState<{ readonly x: number; readonly y: number } | null>(null);

  const matches = useCallback((value: Highlight) => value.threadIds.includes(threadId), [threadId]);
  const lit = useHighlightMatch(highlight, matches);
  const needsYou = row.tone === "needs-you" && ask !== null;
  const classes = [
    "side-task",
    `side-task--${row.tone}`,
    open ? (work ? "is-open" : "is-filled") : "",
    lit ? "is-match" : "",
    needsYou ? "has-ask" : "",
  ];
  const words = taskStateWords(row.tone);
  const mainRef = useRef<HTMLAnchorElement | null>(null);
  // The conversation beside the list is never out of sight in it.
  useEffect(() => {
    if (open && mainRef.current) revealInList(mainRef.current.closest("li") ?? mainRef.current);
  }, [open]);
  const label = [
    row.unread && row.tone !== "needs-you" ? `${row.title}, unread` : row.title,
    words ? `${words}${needsYou && ask ? `: ${ask}` : ""}` : null,
    unsent ? "unsent draft" : null,
  ]
    .filter(Boolean)
    .join(" — ");
  const hasMenu = canRename || canChangeIcon || row.canBeDone || unsent;
  return (
    <li
      data-motion-key={row.threadId}
      className={classes.filter(Boolean).join(" ")}
      data-thread-id={threadId}
      data-voice-row={threadId}
      onContextMenu={(event) => {
        if (!hasMenu) return;
        event.preventDefault();
        setMenuAt({ x: event.clientX, y: event.clientY });
      }}
      onPointerEnter={() => highlight.set({ placeKey: null, threadId, threadIds: [] })}
      onPointerLeave={() => highlight.set(null)}
    >
      {editing && canRename ? (
        <ThreadTitleEditor
          hostClient={hostClient}
          threadId={threadId}
          title={row.title}
          onClose={() => {
            setEditing(false);
            requestAnimationFrame(() => mainRef.current?.focus());
          }}
        />
      ) : (
        <Link
          aria-current={open ? "page" : undefined}
          aria-label={label}
          className="side-task__main"
          onBlur={() => highlight.set(null)}
          onClick={(event) => {
            onNavigate();
            openConversationRow(event, nav, nav.threadPath(threadId));
          }}
          onKeyDown={(event) => {
            if (
              hasMenu &&
              (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))
            ) {
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              setMenuAt({ x: box.left, y: box.bottom });
            }
          }}
          onFocus={() => highlight.set({ placeKey: null, threadId, threadIds: [] })}
          ref={mainRef}
          title={needsYou ? `${row.title}\n${ask}` : row.title}
          to={nav.conversationHref(nav.threadPath(threadId))}
        >
          <TaskMark size={20} mark={taskMark(row)} quiet={taskMarkQuiet(row, row.done)} />
          <span className="side-task__text">
            <span className="side-task__title">{row.title}</span>
            {needsYou ? <span className="side-task__ask">{ask}</span> : null}
          </span>
          {unsent ? <UnsentMark /> : null}
          <TaskState state={row.tone} unread={row.unread} />
        </Link>
      )}
      {changingIcon && mainRef.current && canChangeIcon ? (
        <TaskIconEditor
          anchor={mainRef.current}
          hostClient={hostClient}
          threadId={threadId}
          onClose={() => setChangingIcon(false)}
        />
      ) : null}
      {menuAt && mainRef.current && hasMenu ? (
        <Popover
          anchor={mainRef.current}
          at={menuAt}
          label="Task actions"
          onClose={() => setMenuAt(null)}
        >
          {canRename ? (
            <button
              className="picker__row"
              role="menuitem"
              data-action="rename"
              type="button"
              onClick={() => {
                setMenuAt(null);
                setEditing(true);
              }}
            >
              Rename
            </button>
          ) : null}
          {canChangeIcon ? (
            <button
              className="picker__row"
              role="menuitem"
              data-action="change-icon"
              type="button"
              onClick={() => {
                setMenuAt(null);
                setChangingIcon(true);
              }}
            >
              Change icon…
            </button>
          ) : null}
          {row.canBeDone ? (
            <button
              className="picker__row"
              role="menuitem"
              type="button"
              onClick={() => {
                setMenuAt(null);
                onSetDone(threadId, !row.done);
              }}
            >
              {row.done ? "Reopen" : "Mark Done"}
            </button>
          ) : null}
          {unsent ? (
            <button
              className="picker__row"
              role="menuitem"
              type="button"
              onClick={() => {
                setMenuAt(null);
                onDiscardDraft({ kind: "thread", threadId });
              }}
            >
              Discard draft
            </button>
          ) : null}
        </Popover>
      ) : null}
      {row.canBeDone ? (
        <button
          aria-label={`${row.done ? "Reopen" : "Mark Done"}: ${row.title}`}
          className="side-row-action"
          onClick={() => onSetDone(threadId, !row.done)}
          title={row.done ? "Reopen" : "Mark Done"}
          type="button"
        >
          <Icon name={row.done ? "undo" : "check"} />
        </button>
      ) : null}
    </li>
  );
});

/* ---- Tabs ---- */

type TabRowProps = Omit<Parameters<typeof TabRow>[0], "badge" | "place"> & {
  /** Two or more identities are in use: site icons wear profile badges. */
  readonly badges: boolean;
  readonly placeKey: string;
};

/** A tab row reads its own place, so one tab's title or loading repaints only it. */
const TabRowItem = memo(function TabRowItem({ badges, placeKey, ...props }: TabRowProps) {
  const place = usePlace(props.hostClient, placeKey);
  return place ? <TabRow {...props} badge={badges ? place.identity : null} place={place} /> : null;
});

const TabRow = memo(function TabRow({
  sort,
  active,
  badge,
  groupColor,
  onEditGroup,
  device,
  directory,
  hereId,
  highlight,
  hostClient,
  index,
  localMachine,
  onOpen,
  onOpenMark,
  place,
  presentation,
}: {
  /** Drag-and-drop and ⌘↑/⌘↓, for a saved web tab. */
  readonly sort: TabSortHandle | null;
  readonly groupColor?: BrowserTabGroupColor | undefined;
  readonly onEditGroup: (id: string | null) => void;
  /** The place in the middle: it wears the place card's material. */
  readonly active: boolean;
  /** The profile badge on the site's icon, when two or more identities are in use. */
  readonly badge: PlaceItem["identity"];
  /** The device it runs on, beside its title, while the list names devices. */
  readonly device: DeviceElsewhere | null;
  readonly directory: TaskDirectory;
  /** The device this window is on, which the row's words never name. */
  readonly hereId: string | null;
  readonly highlight: WorkspaceState["highlight"];
  readonly hostClient: HostClient;
  readonly index: number;
  /** This Mac, for a menu that can bring one of its apps forward. */
  readonly localMachine: WorkspaceState["localMachine"];
  readonly onOpen: (place: PlaceItem) => void;
  readonly onOpenMark: (place: PlaceItem, threadId: string) => void;
  readonly place: PlaceItem;
  /** Who the tab browses as, in words, for its name and tooltip. */
  readonly presentation: BrowserPresentation | null;
}) {
  const occupantIds = useMemo<readonly string[]>(
    () => place.occupants.map((occupant) => occupant.threadId),
    [place.occupants],
  );
  const placeKey = place.key;
  const matches = useCallback(
    (value: Highlight) =>
      value.placeKey === placeKey ||
      (value.threadId !== null && occupantIds.includes(value.threadId)),
    [occupantIds, placeKey],
  );
  const lit = useHighlightMatch(highlight, matches);
  const requestClose = useTabCloser();
  const [menuAt, setMenuAt] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const pressed = useRef(false);
  const mainRef = useRef<HTMLButtonElement | null>(null);
  // The place the person just put in the middle is never out of sight in the list.
  useEffect(() => {
    if (active && mainRef.current) revealInList(mainRef.current.closest("li") ?? mainRef.current);
  }, [active]);
  useEffect(() => () => window.clearTimeout(press.current?.timer), []);
  // Only a web tab has a browser's menu; a Mac app's Stop stays in its own bar.
  const browserTab = place.kind === "browser";
  const group = browserTab ? "web" : "native";
  const fallbackRef = useRef(() => neighbourRow(index, group));
  // The tab in the middle leaving hands the middle to its successor: focus follows it there.
  fallbackRef.current = () => (active ? activeRow() : null) ?? neighbourRow(index, group);
  useFocusRescue(mainRef, fallbackRef);
  const unavailable = place.availability === "unavailable";
  const site = place.site ? browserSiteLabel(place.site) : null;
  // A phone's row is its name already.
  const elsewhere =
    place.kind !== "phone" && place.device && place.device.machineId !== hereId
      ? place.device.name
      : null;
  // The whole destination in words, label or not: "Q4 numbers – Notion — Work · Mac mini · Offline".
  const where =
    [
      presentation ? browserWords(presentation, hereId) : elsewhere,
      // Marked though it is this device (not the main computer): the label overrides the mark's name.
      device?.id === hereId ? device.name : null,
      !presentation && place.ownerView ? "View only" : null,
      device && !device.online ? "Offline" : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;
  const tip = where ? `${place.title} — ${where}` : place.title;
  const label = [tip, place.loading ? "loading" : null, unavailable ? "unavailable" : null]
    .filter(Boolean)
    .join(", ");
  const classes = [
    "side-tab",
    groupColor ? "side-tab--grouped" : "",
    active ? "is-active" : "",
    lit ? "is-match" : "",
    unavailable ? "is-unavailable" : "",
  ];
  const nativeMenu = !browserTab && nativeTabMenuOffered(place, localMachine);
  const openMenu = (at: { readonly x: number; readonly y: number }) => {
    if (browserTab || nativeMenu) setMenuAt(at);
  };
  const cancelPress = () => {
    window.clearTimeout(press.current?.timer);
    press.current = null;
  };
  return (
    <li
      className={classes.filter(Boolean).join(" ")}
      style={groupColor ? tabGroupStyle(groupColor) : undefined}
      data-group={group}
      data-motion-key={placeKey}
      data-place-key={placeKey}
      data-row-index={index}
      data-voice-row={voiceRowKey({ kind: "place", destination: place.destination })}
      // The wheel button closes a tab, as on a browser's tab strip, and never starts autoscroll.
      onAuxClick={(event) => {
        if (event.button === 1 && place.closable) requestClose(place);
      }}
      onClickCapture={(event) => {
        // A long press opened the menu; the finger lifting is not a click on the row.
        if (!pressed.current) return;
        pressed.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        if (!browserTab && !nativeMenu) return;
        event.preventDefault();
        openMenu({ x: event.clientX, y: event.clientY });
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onKeyDown={sort ? (event) => sort.keyMove(event, placeKey) : undefined}
      onPointerCancel={cancelPress}
      onPointerDown={(event) => {
        sort?.press(event, placeKey);
        pressed.current = false;
        if (event.pointerType !== "touch" || (!browserTab && !nativeMenu)) return;
        const { clientX: x, clientY: y } = event;
        // Under a finger the menu hangs below the row, never under the finger itself.
        const row = event.currentTarget.getBoundingClientRect();
        cancelPress();
        press.current = {
          x,
          y,
          timer: window.setTimeout(() => {
            press.current = null;
            pressed.current = true;
            openMenu({ x: row.left + 12, y: row.bottom });
          }, 500),
        };
      }}
      onPointerEnter={() => highlight.set({ placeKey, threadId: null, threadIds: occupantIds })}
      onPointerLeave={() => highlight.set(null)}
      onPointerMove={(event) => {
        const start = press.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10)
          cancelPress();
      }}
      onPointerUp={cancelPress}
    >
      <button
        aria-current={active ? "true" : undefined}
        aria-haspopup={browserTab || nativeMenu ? "menu" : undefined}
        aria-label={label}
        className="side-tab__main"
        data-tip={tip}
        onBlur={() => highlight.set(null)}
        onClick={() => onOpen(place)}
        onFocus={() => highlight.set({ placeKey, threadId: null, threadIds: occupantIds })}
        onKeyDown={(event) => {
          if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
          if (!browserTab && !nativeMenu) return;
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          openMenu({ x: box.left + 12, y: box.bottom });
        }}
        ref={mainRef}
        title={site && site !== place.title ? `${tip}\n${site}` : tip}
        type="button"
      >
        <span aria-hidden className="place-mark-badged">
          <PlaceMark hostClient={hostClient} icon={place.icon} />
          {badge ? (
            <span className="pbadge">
              <ProfileAvatar identity={badge} size={14} />
            </span>
          ) : null}
        </span>
        <span className="side-tab__title">{place.title}</span>
        {device ? <DeviceLabel className="side-tab__device" device={device} iconOnly /> : null}
      </button>
      <OccupantMarks
        className="side-tab__marks"
        directory={directory}
        fallbackFocus={() =>
          mainRef.current?.isConnected ? mainRef.current : neighbourRow(index, group)
        }
        onOpen={(threadId) => onOpenMark(place, threadId)}
        occupants={place.occupants}
        placeTitle={place.title}
        size={16}
      />
      {place.closable ? <CloseTabButton fallback={fallbackRef} place={place} /> : null}
      {menuAt && mainRef.current ? (
        browserTab ? (
          <TabMenu
            anchor={mainRef.current}
            at={menuAt}
            hostClient={hostClient}
            onEditGroup={onEditGroup}
            onClose={() => setMenuAt(null)}
            place={place}
            presentation={presentation}
          />
        ) : (
          <NativeTabMenu
            anchor={mainRef.current}
            at={menuAt}
            onClose={() => setMenuAt(null)}
            place={place}
          />
        )
      ) : null}
    </li>
  );
});

/**
 * The tooltip a row's pointer gets, for the keyboard too: a focused row says
 * its whole destination beside the list. One for the whole sidebar.
 */
function RowTip({ root }: { readonly root: { readonly current: HTMLElement | null } }) {
  const native = useNativeBrowserLayer().live;
  const [tip, setTip] = useState<{
    readonly text: string;
    readonly left: number;
    readonly top: number;
  } | null>(null);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const show = (event: FocusEvent) => {
      const target = event.target;
      const text = target instanceof HTMLElement ? target.dataset.tip : undefined;
      if (!text || !(target instanceof HTMLElement) || !target.matches(":focus-visible")) {
        setTip(null);
        return;
      }
      const box = target.getBoundingClientRect();
      const list = target.closest(".sidebar")?.getBoundingClientRect();
      setTip({ text, left: (list?.right ?? box.right) + 8, top: box.top + box.height / 2 });
    };
    const hide = () => setTip(null);
    node.addEventListener("focusin", show);
    node.addEventListener("focusout", hide);
    node.addEventListener("scroll", hide, true);
    return () => {
      node.removeEventListener("focusin", show);
      node.removeEventListener("focusout", hide);
      node.removeEventListener("scroll", hide, true);
    };
  }, [root]);
  return tip && !native
    ? createPortal(
        <div aria-hidden className="row-tip" style={{ left: tip.left, top: tip.top }}>
          {tip.text}
        </div>,
        document.body,
      )
    : null;
}

/** The row of the place in the middle now, the start page's included. */
function activeRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".side-tab.is-active .side-tab__main");
}

/** The row that takes focus when the focused one leaves the list. */
function neighbourRow(index: number, group: "web" | "native"): HTMLElement | null {
  // A browser's next tab, else its previous one; never across into the Mac apps.
  const rows = [...document.querySelectorAll<HTMLElement>(`.side-tab[data-group="${group}"]`)];
  const next =
    rows.find((row) => Number(row.dataset.rowIndex) >= index) ?? rows[rows.length - 1] ?? null;
  return (
    next?.querySelector<HTMLElement>(".side-tab__main") ??
    document.querySelector<HTMLElement>(".side-new__main")
  );
}

/**
 * Closes exactly this tab; the Host decides what the last tab takes with it.
 * Its row leaves with it, so focus on it goes on to the neighbouring row.
 */
function CloseTabButton({
  fallback,
  place,
}: {
  readonly fallback: { readonly current: () => HTMLElement | null };
  readonly place: PlaceItem;
}) {
  const requestClose = useTabCloser();
  const ref = useRef<HTMLButtonElement | null>(null);
  useFocusRescue(ref, fallback);
  return (
    <button
      aria-label={`Close ${place.title}`}
      className="side-row-action side-tab__close"
      onClick={() => requestClose(place)}
      ref={ref}
      title="Close tab"
      type="button"
    >
      <Icon name="close" />
    </button>
  );
}

/* ---- Footer: where the work runs, the other places it could, and everything else ---- */

function SidebarFooter({
  connection,
  onCloseMobile,
  onThisComputer,
  placeName,
  workspace,
}: {
  readonly connection: ReturnType<typeof describeHostConnection>;
  readonly onCloseMobile: () => void;
  readonly onThisComputer: boolean;
  readonly placeName: string;
  readonly workspace: WorkspaceState;
}) {
  const navigate = useNavigate();
  const places = useDesktopPlaces();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  // An Account sign-in that ended on its own is worth a mark, not a banner:
  // the place in use is unaffected, and the menu says what to do.
  const signInEnded = places?.snapshot.account.status === "error";
  const go = (path: string, keepPlace: boolean) => {
    setOpen(false);
    onCloseMobile();
    if (keepPlace) workspace.nav.openConversation(path);
    else void navigate(path);
  };
  const items: readonly {
    readonly icon: Parameters<typeof Icon>[0]["name"];
    readonly label: string;
    readonly onSelect: () => void;
  }[] = [
    // Setup is this computer's, so it is offered only on it.
    ...(onThisComputer && places
      ? [{ icon: "check-circle" as const, label: "Setup", onSelect: () => go(setupPath, false) }]
      : []),
    { icon: "bolt", label: "Automations", onSelect: () => go("/automations", true) },
    { icon: "settings", label: "Settings", onSelect: () => go("/settings", false) },
  ];
  return (
    <div className="sidebar__footer">
      <div className="sidebar__place-row">
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`${placeName}: ${connection.label}.${signInEnded ? " Sign in again." : ""} ${places ? "Places and menu" : "Menu"}`}
          className="sidebar__place"
          onClick={() => setOpen((value) => !value)}
          ref={anchorRef}
          type="button"
        >
          <span aria-hidden className="sidebar__place-mark">
            <Icon name={onThisComputer ? "desktop" : "server"} />
            {signInEnded ? <span className="sidebar__place-alert" /> : null}
          </span>
          <span className="sidebar__place-text">
            <span className="sidebar__place-name">{placeName}</span>
            <span className="sidebar__place-status">
              <span
                aria-hidden
                className={`sidebar__status-dot sidebar__status-dot--${connection.tone}`}
              />
              {connection.label}
            </span>
          </span>
          <Icon className="sidebar__place-settings" name="chevron-down" />
        </button>
        <DesktopUpdateButton />
      </div>
      {open && anchorRef.current ? (
        <Popover
          anchor={anchorRef.current}
          className="popover--surface"
          label={places ? "Places and menu" : "Menu"}
          onClose={() => setOpen(false)}
        >
          <div className="picker__section">
            {items.map((item) => (
              <button
                className="picker__row"
                key={item.label}
                onClick={item.onSelect}
                role="menuitem"
                type="button"
              >
                <span className="picker__check picker__check--icon">
                  <Icon name={item.icon} />
                </span>
                <span className="picker__label">{item.label}</span>
              </button>
            ))}
          </div>
          {places ? <PlaceMenuPlaces onClose={() => setOpen(false)} places={places} /> : null}
          {places ? (
            <PlaceAccountFooter
              account={places.snapshot.account}
              onSignOut={() => {
                setOpen(false);
                setSigningOut(true);
              }}
            />
          ) : null}
        </Popover>
      ) : null}
      {signingOut && places ? (
        <SignOutDialog
          bridge={places.bridge}
          onClose={() => setSigningOut(false)}
          onConfirm={() => places.bridge.signOut()}
          snapshot={places.snapshot}
        />
      ) : null}
    </div>
  );
}

/** The tab list's saved web tabs and group headers, as drag-and-drop sees them. */
function sortRowsOf(strip: BrowserTabStrip<PlaceDescriptor>): SortRow[] {
  const tab = (place: PlaceDescriptor, group: (SortRow & { kind: "group" }) | null): SortRow[] =>
    place.personalTab && place.destination.kind === "browser" && place.destination.tabId
      ? [
          {
            kind: "tab",
            key: place.key,
            tabId: place.destination.tabId,
            group: group ? { id: group.groupId, color: group.color } : null,
          },
        ]
      : [];
  return strip.web.flatMap((row): SortRow[] => {
    if (row.kind === "place") return tab(row.place, null);
    const header = {
      kind: "group",
      key: row.group.id,
      groupId: row.group.id,
      color: row.group.color,
      collapsed: row.group.collapsed,
    } as const;
    return [
      header,
      ...(row.group.collapsed ? [] : row.places.flatMap((place) => tab(place, header))),
    ];
  });
}

function rowTitle(
  hostClient: HostClient,
  strip: BrowserTabStrip<PlaceDescriptor>,
  row: SortRow,
): string {
  if (row.kind === "group") {
    const group = strip.web.find(
      (entry) => entry.kind === "group" && entry.group.id === row.groupId,
    );
    return (group?.kind === "group" && group.group.title) || "Untitled group";
  }
  return placeByKey(hostClient.getSnapshot(), row.key)?.title ?? "tab";
}
