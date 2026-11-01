import { PendingBrowserTabRows } from "./workspace/pending-browser-tab.js";
import { taskMark } from "@opensteer/client/host";
import { TaskIconEditor } from "./task-icon-editor.js";
import { ThreadTitleEditor } from "./thread-title-editor.js";
import { useNativeBrowserLayer, useNativeBrowserOverlay } from "./native-browser-overlays.js";
import {
  memo,
  useCallback,
  useEffect,
  useId,
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
  browserTabStrip,
  browserSiteLabel,
  describeHostConnection,
  listedRowThreadId,
  taskRowLabel,
  type HostClient,
  type PlaceItem,
  type TaskRow,
} from "@opensteer/client/host";
import { CHAT_THREAD_TITLE } from "@opensteer/core";
import { useHostSelector, usePlaceList } from "@opensteer/client/react";
import { deploymentNameFrom } from "./deployment-name.js";
import { selectedDeploymentFrom } from "../desktop/desktop-deployment-selection.js";
import { Icon } from "./icon.js";
import { Dialog } from "./dialog.js";
import { Popover } from "./popover.js";
import { createPortal } from "react-dom";
import { actionErrorMessage, fromLivePage } from "../ui-utils.js";
import { useToast } from "./toast.js";
import { TaskMark, TaskState, ChatOrb, taskStateWords } from "./workspace/task-mark.js";
import {
  ProfileAvatar,
  browserWords,
  useBrowserPresentations,
  type BrowserPresentation,
} from "./workspace/identity.js";
import { OccupantMarks, useFocusRescue } from "./workspace/occupant-marks.js";
import { DeviceGlyph, PlaceMark } from "./workspace/place-mark.js";
import {
  homeThreadKind,
  useTaskDirectory,
  type TaskDirectory,
} from "./workspace/task-directory.js";
import {
  useHighlightMatch,
  useWorkspace,
  type Highlight,
  type WorkspaceState,
} from "./workspace/workspace-context.js";
import { destinationPlaceKey, type WorkspaceNavigation } from "./workspace/navigation.js";
import { revealInList, useScrollEdges, useWholeRows } from "./workspace/scroll-edges.js";
import { useTabCloser } from "./workspace/tab-closer.js";
import { TabGroupHeader, tabGroupStyle } from "./workspace/tab-group.js";
import { NativeTabMenu, TabMenu, nativeTabMenuOffered } from "./workspace/tab-menu.js";
import { RowMotion } from "./workspace/row-motion.js";
import { SideSplit, useTasksShare } from "./workspace/side-split.js";
import { SidebarSearch, type SidebarSearchSources } from "./sidebar-search.js";
import {
  TabFilter,
  allTabs,
  tabFilterActive,
  tabFilterEmptyWords,
  tabMatchesFilter,
  type TabFilterValue,
} from "./workspace/tab-filter.js";
import type { SortRow } from "./workspace/tab-sort.js";
import { useTabSort, type TabSortHandle } from "./workspace/use-tab-sort.js";
import { useTaskSnapshot } from "./task-rows.js";
import { useDesktopPlaces } from "../desktop/places-context.js";
import { PlaceMenuPlaces } from "./places/place-menu.js";
import { PlaceAccountFooter, SignOutDialog } from "./places/place-account.js";

export interface SidebarProps {
  collapsed: boolean;
  deploymentAccess: DeploymentAccessSnapshot | null;
  desktopDeployment: DesktopDeploymentSummary | null;
  desktopWindowChrome: boolean;
  hostClient: HostClient;
  mobileOpen: boolean;
  mobile?: boolean;
  onCloseMobile: () => void;
  onLoadEarlierTasks: () => Promise<void>;
  onNewTab: () => void;
  onSetTaskDone: (threadId: string, done: boolean) => void;
  onToggleCollapsed: () => void;
}

/**
 * The one navigator: Chat, the tasks, the places open now, and a menu
 * for everything else. A task row changes only the conversation; a tab row
 * only the middle; a mark on a tab both, as one step.
 */
export function Sidebar({
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
  const { pathname } = useLocation();
  const snapshot = useTaskSnapshot(hostClient);
  const directory = useTaskDirectory(hostClient);
  const places = usePlaceList(hostClient);
  const layout = useHostSelector(hostClient, (snapshot) => snapshot.browserTabGroups);
  const [filter, setFilter] = useState<TabFilterValue>(allTabs);
  useEffect(() => setFilter(allTabs), [hostClient]);
  const shownPlaceKey =
    workspace.selection.kind === "place"
      ? destinationPlaceKey(workspace.selection.destination)
      : null;
  // The tab in front stays listed whatever the filter, so opening one never hides where you are.
  const filteredPlaces = useMemo(
    () =>
      tabFilterActive(filter)
        ? places.filter((place) => place.key === shownPlaceKey || tabMatchesFilter(place, filter))
        : places,
    [places, filter, shownPlaceKey],
  );
  const liveStrip = browserTabStrip(filteredPlaces, layout);
  const searchStrip = browserTabStrip(places, layout);
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
    title: (row) => rowTitle(liveStrip, row),
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
  const presentations = useBrowserPresentations(places);
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
  const [tasksShare, commitTasksShare] = useTasksShare();
  useWholeRows(listsRef, !collapsed);
  const { openDrawer } = workspace;
  const { list, homeThreadId } = directory;
  const openThreadId =
    pathname === "/"
      ? homeThreadId
      : pathname.startsWith("/threads/")
        ? decodeURIComponent(pathname.slice("/threads/".length))
        : null;
  // A helper has no row, so the task it works for, or Chat, is where the reader is.
  const openRowThreadId = openThreadId === null ? null : listedRowThreadId(snapshot, openThreadId);

  const allTasks = useMemo(() => [...list.working, ...list.ready, ...list.done], [list]);
  const searchSources = useMemo<SidebarSearchSources>(
    () => ({
      tasks: allTasks,
      attention: directory.attentionByThread,
      snapshot,
      strip: searchStrip,
    }),
    [allTasks, directory.attentionByThread, snapshot, searchStrip],
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
  const needsYou = directory.attention;
  const openNeedsYou = () => {
    const first = needsYou[0];
    if (!first) return;
    onCloseMobile();
    nav.openConversation(nav.threadPath(first.threadId), { focusRequest: first.requestId });
  };
  const newTask = () => {
    onCloseMobile();
    nav.openConversation("/new");
  };
  const loadMore = () => void onLoadEarlierTasks().catch(() => undefined);

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
  const hasTasksSection = rows.length > 0 || list.done.length > 0 || list.hasMore;
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
  const tabRow = (place: PlaceItem, index: number, groupColor?: BrowserTabGroupColor) => {
    const presentation = place.browser
      ? (presentations.bySession.get(place.browser.sessionId) ?? null)
      : null;
    return (
      <TabRowItem
        sort={place.workspaceTab ? sort.handle : null}
        groupColor={groupColor}
        onEditGroup={editGroup}
        active={place.key === shownPlaceKey}
        badge={presentations.badges ? place.identity : null}
        directory={directory}
        hostClient={hostClient}
        index={index}
        key={place.key}
        namedDevice={namedDevices}
        onOpen={openPlace}
        onOpenMark={openMark}
        place={place}
        highlight={workspace.highlight}
        localMachine={workspace.localMachine}
        presentation={presentation}
      />
    );
  };
  const devices = new Set(
    places.flatMap((place) => (place.device ? [place.device.machineId] : [])),
  );
  const namedDevices = devices.size >= 2;

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
      <div className="sidebar__header">
        <button
          aria-expanded={searching}
          aria-label="Search tasks and tabs"
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

      <SidebarSearch
        badges={presentations.badges}
        fallbackFocusRef={searchButtonRef}
        hasMore={list.hasMore}
        hostClient={hostClient}
        inputRef={searchRef}
        listsRef={listsRef}
        listsStyle={{ "--side-tasks-share": tasksShare } as CSSProperties}
        namedDevices={namedDevices}
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
        <ChatRow
          ask={homeThreadId ? (directory.attentionByThread.get(homeThreadId) ?? null) : null}
          onNavigate={onCloseMobile}
          open={openRowThreadId !== null && openRowThreadId === homeThreadId}
          row={list.chat}
          workspace={workspace}
        />
        {/* No tasks yet, no heading: ⌘N and Chat are the ways to start
                  one, and the heading arrives with the first. */}
        {!hasTasksSection ? null : (
          <section
            aria-labelledby="sidebar-tasks"
            className="side-section side-section--tasks"
            style={sectionFloor(rows.length)}
          >
            <div className="side-head">
              <h2 className="side-head__title" id="sidebar-tasks">
                Tasks
              </h2>
              {needsYou.length > 0 ? (
                <button
                  aria-label={`${needsYou.length} ${needsYou.length === 1 ? "task needs" : "tasks need"} you. Open the first`}
                  className="side-needs"
                  onClick={openNeedsYou}
                  title="Open the first task that needs you"
                  type="button"
                >
                  <span aria-hidden className="side-needs__bang">
                    !
                  </span>
                  <span aria-hidden>{needsYou.length}</span>
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
              <Link
                aria-current={pathname === "/tasks" ? "page" : undefined}
                aria-label="All tasks"
                className="icon-btn icon-btn--small side-head__action"
                onClick={onCloseMobile}
                title="All tasks"
                to={nav.conversationHref("/tasks")}
              >
                <Icon name="chevron-right" />
              </Link>
            </div>
            {rows.length > 0 ? (
              <SideList labelledBy="sidebar-tasks" whole>
                {rows.map((row) => (
                  <TaskRowItem
                    hostClient={hostClient}
                    ask={directory.attentionByThread.get(row.threadId)?.title ?? null}
                    key={row.threadId}
                    onNavigate={onCloseMobile}
                    onSetDone={onSetTaskDone}
                    open={row.threadId === openRowThreadId}
                    row={row}
                    workspace={workspace}
                  />
                ))}
              </SideList>
            ) : null}
          </section>
        )}
        {hasTasksSection ? <SideSplit onCommit={commitTasksShare} share={tasksShare} /> : null}
        <section
          aria-labelledby="sidebar-tabs"
          className="side-section side-section--tabs"
          style={sectionFloor(filteredPlaces.length)}
        >
          <div className="side-head">
            <h2 className="side-head__title" id="sidebar-tabs" tabIndex={-1}>
              Tabs
            </h2>
            <TabFilter onChange={setFilter} places={places} value={filter} />
            {places.length > 0 ? (
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
              {tabFilterActive(filter) &&
              !filteredPlaces.some((place) => tabMatchesFilter(place, filter)) ? (
                <li className="sidebar__empty" data-motion-key="filter-empty" role="status">
                  {tabFilterEmptyWords(filter)}
                </li>
              ) : null}
              {strip.web.flatMap((row) => {
                if (row.kind === "place")
                  return [tabRow(row.place, tabIndices.get(row.place.key)!)];
                // A group on the move folds its tabs under its header until it lands.
                const folded = row.group.id === sort.lift?.groupId;
                return [
                  <TabGroupHeader
                    active={row.places.some((place) => place.key === shownPlaceKey)}
                    directory={directory}
                    editing={editingGroup === row.group.id}
                    group={folded ? { ...row.group, collapsed: true } : row.group}
                    hostClient={hostClient}
                    key={row.group.id}
                    onEdit={editGroup}
                    onOpenMark={openMark}
                    places={row.places}
                    sort={sort.handle}
                  />,
                  ...(row.group.collapsed || folded
                    ? []
                    : row.places.map((place) =>
                        tabRow(place, tabIndices.get(place.key)!, row.group.color),
                      )),
                ];
              })}
              <PendingBrowserTabRows hostClient={hostClient} onOpen={onCloseMobile} />
              {strip.native.length > 0 && strip.web.length > 0 ? (
                <li aria-hidden className="side-divider" data-motion-key="divider" />
              ) : null}
              {strip.native.map((place) => tabRow(place, tabIndices.get(place.key)!))}
              {startPageOpen ? (
                <li className="side-tab side-tab--start is-active" data-motion-key="start">
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
                <li className="side-new" data-motion-key="new">
                  <button className="side-new__main" onClick={newTab} type="button">
                    <Icon name="plus" />
                    <span>New tab</span>
                  </button>
                </li>
              )}
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

/* ---- Chat ---- */

function ChatRow({
  ask,
  onNavigate,
  open,
  row,
  workspace,
}: {
  readonly ask: { readonly title: string } | null;
  readonly onNavigate: () => void;
  readonly open: boolean;
  readonly row: TaskRow | null;
  readonly workspace: WorkspaceState;
}) {
  // Its state in words, for the row's name; the orb and its mark say it to the eye.
  const label = row === null ? CHAT_THREAD_TITLE : taskRowLabel(row, { chat: true });
  const classes = ["side-home", open ? (workspace.work ? "is-open" : "is-filled") : ""];
  return (
    <div className={classes.filter(Boolean).join(" ")}>
      <Link
        aria-current={open ? "page" : undefined}
        aria-label={label}
        className="side-home__main"
        onClick={(event) => {
          onNavigate();
          openConversationRow(event, workspace.nav, "/");
        }}
        title={ask?.title}
        to={workspace.nav.conversationHref("/")}
      >
        <ChatOrb size={20} />
        <span className="side-home__title">{CHAT_THREAD_TITLE}</span>
        {row === null ? null : row.tone === "needs-you" ? (
          <span aria-hidden className="side-bang">
            !
          </span>
        ) : row.tone === "working" ? (
          <span aria-hidden className="spinner side-home__spinner" />
        ) : row.unread ? (
          <span aria-hidden className="task-row__unread" />
        ) : null}
      </Link>
    </div>
  );
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
  nav.openConversation(path);
}

/* ---- Tasks ---- */

const TaskRowItem = memo(function TaskRowItem({
  hostClient,
  ask,
  onNavigate,
  onSetDone,
  open,
  row,
  workspace,
}: {
  readonly hostClient: HostClient;
  readonly ask: string | null;
  readonly onNavigate: () => void;
  readonly onSetDone: (threadId: string, done: boolean) => void;
  readonly open: boolean;
  readonly row: TaskRow;
  readonly workspace: WorkspaceState;
}) {
  const { highlight, nav, work } = workspace;
  const threadId = row.threadId;
  const canRename = useHostSelector(
    hostClient,
    (snapshot) => snapshot.threadRenameAvailable && homeThreadKind(threadId, snapshot) === null,
  );
  const [editing, setEditing] = useState(false);
  const [changingIcon, setChangingIcon] = useState(false);
  const canChangeIcon = useHostSelector(
    hostClient,
    (snapshot) => snapshot.taskMarksAvailable && homeThreadKind(threadId, snapshot) === null,
  );
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
  ]
    .filter(Boolean)
    .join(" — ");
  return (
    <li
      className={classes.filter(Boolean).join(" ")}
      data-thread-id={threadId}
      onContextMenu={(event) => {
        if (!canRename && !canChangeIcon && !row.canBeDone) return;
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
              (canRename || canChangeIcon || row.canBeDone) &&
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
          <TaskMark size={20} mark={taskMark(row)} quiet={row.tone === "finished" && !row.unread} />
          <span className="side-task__text">
            <span className="side-task__title">{row.title}</span>
            {needsYou ? <span className="side-task__ask">{ask}</span> : null}
          </span>
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
      {menuAt && mainRef.current && (canRename || canChangeIcon || row.canBeDone) ? (
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

const TabRowItem = memo(function TabRowItem({
  sort,
  active,
  badge,
  groupColor,
  onEditGroup,
  directory,
  highlight,
  hostClient,
  index,
  localMachine,
  namedDevice,
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
  readonly directory: TaskDirectory;
  readonly highlight: WorkspaceState["highlight"];
  readonly hostClient: HostClient;
  readonly index: number;
  /** This Mac, for a menu that can bring one of its apps forward. */
  readonly localMachine: WorkspaceState["localMachine"];
  readonly namedDevice: boolean;
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
  const deviceName = place.kind === "app" ? (place.device?.name ?? null) : null;
  const site = place.site ? browserSiteLabel(place.site) : null;
  // The whole destination in words, badge or not: "Q4 numbers – Notion — Work · Q4 numbers · Mac mini".
  const where = presentation
    ? browserWords(presentation)
    : place.ownerView
      ? `${place.kind === "phone" ? "" : `${place.device?.name ?? ""} · `}View only`
      : (place.device?.name ?? null);
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
        {deviceName ? (
          namedDevice ? (
            <span className="side-tab__device">{deviceName}</span>
          ) : (
            <DeviceGlyph name={deviceName} />
          )
        ) : null}
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
      {place.closable ? (
        <CloseTabButton fallback={fallbackRef} place={place} />
      ) : (
        // Every row keeps the close column, so the marks stand in one column.
        <span aria-hidden className="side-tab__close-slot" />
      )}
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
  const [switchingComputer, setSwitchingComputer] = useState(false);
  const switchTitleId = useId();
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
    { icon: "users", label: "Specialists", onSelect: () => go("/specialists", true) },
    { icon: "bolt", label: "Automations", onSelect: () => go("/automations", true) },
    { icon: "settings", label: "Settings", onSelect: () => go("/settings", false) },
  ];
  return (
    <div className="sidebar__footer">
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
          {places ? (
            <div className="picker__section">
              <button
                className="picker__row"
                onClick={() => {
                  setOpen(false);
                  setSwitchingComputer(true);
                }}
                role="menuitem"
                type="button"
              >
                <span aria-hidden className="picker__check picker__check--icon">
                  <Icon name="repeat" />
                </span>
                <span className="picker__label-stack">
                  <span className="picker__label">Switch computer…</span>
                  {signInEnded ? <span className="picker__detail">Sign in again</span> : null}
                </span>
              </button>
            </div>
          ) : null}
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
      {switchingComputer && places ? (
        <Dialog
          labelledBy={switchTitleId}
          onClose={() => setSwitchingComputer(false)}
          returnFocusTo={anchorRef.current}
          title="Switch computer"
        >
          <PlaceMenuPlaces onClose={() => setSwitchingComputer(false)} places={places} />
        </Dialog>
      ) : null}
      {signingOut && places ? (
        <SignOutDialog
          onClose={() => setSigningOut(false)}
          onConfirm={() => places.bridge.signOut()}
        />
      ) : null}
    </div>
  );
}

/** The tab list's saved web tabs and group headers, as drag-and-drop sees them. */
function sortRowsOf(strip: BrowserTabStrip): SortRow[] {
  const tab = (place: PlaceItem, group: (SortRow & { kind: "group" }) | null): SortRow[] =>
    place.workspaceTab && place.destination.kind === "browser" && place.destination.tabId
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

function rowTitle(strip: BrowserTabStrip, row: SortRow): string {
  if (row.kind === "group") {
    const group = strip.web.find(
      (entry) => entry.kind === "group" && entry.group.id === row.groupId,
    );
    return (group?.kind === "group" && group.group.title) || "Untitled group";
  }
  return strip.ordered.find((place) => place.key === row.key)?.title ?? "tab";
}
