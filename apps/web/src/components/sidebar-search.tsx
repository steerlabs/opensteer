import {
  matchSearch,
  placeSearchFields,
  rankSearch,
  searchQuery,
  taskMark,
  threadSearchFields,
  type BrowserTabStrip,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type SearchField,
  type SearchMatch,
  type SearchRange,
  type TaskAttention,
  type TaskRow,
} from "@opensteer/client/host";
import type { BrowserTabGroup } from "@opensteer/protocol";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { ProfileAvatar } from "./workspace/identity.js";
import { DeviceGlyph, PlaceMark } from "./workspace/place-mark.js";
import { useScrollEdges } from "./workspace/scroll-edges.js";
import { tabGroupStyle } from "./workspace/tab-group.js";
import { TaskMark, TaskState } from "./workspace/task-mark.js";

/** What search can find, as the sidebar holds it. */
export interface SidebarSearchSources {
  /** Every task row the sidebar has loaded, in its order: Working, Ready, Done. */
  readonly tasks: readonly TaskRow[];
  readonly attention: ReadonlyMap<string, TaskAttention>;
  /** Where each task's harness and runner labels come from. */
  readonly snapshot: Pick<HostSnapshot, "tasks" | "workspaces">;
  readonly strip: BrowserTabStrip;
}

interface Found<T> {
  readonly key: string;
  readonly item: T;
  readonly fields: readonly SearchField[];
}

type Result =
  | {
      readonly kind: "task";
      readonly key: string;
      readonly row: TaskRow;
      readonly ask: string | null;
      readonly fields: readonly SearchField[];
      readonly match: SearchMatch;
    }
  | {
      readonly kind: "tab";
      readonly key: string;
      readonly place: PlaceItem;
      readonly group: BrowserTabGroup | null;
      readonly fields: readonly SearchField[];
      readonly match: SearchMatch;
    };

/**
 * ⌘K's field and what it finds: the tasks and tabs whose words match, best
 * first, in place of the lists while there is a query. The lists stay laid
 * out underneath, inert and unseen, so closing search shows them as they
 * stand, scrolled where they were, and none of their rows renders while a
 * person types: the query lives here, and the lists come in as `children`.
 */
export function SidebarSearch({
  badges,
  children,
  fallbackFocusRef,
  hasMore,
  hostClient,
  inputRef,
  listsRef,
  listsStyle,
  namedDevices,
  onClose,
  openerRef,
  onLoadMore,
  onOpenPlace,
  onOpenTask,
  open,
  openThreadId,
  shownPlaceKey,
  sources,
}: {
  /** Site icons wear profile badges, as in the list. */
  readonly badges: boolean;
  readonly children: ReactNode;
  /** Takes the keyboard when where it was, or the row chosen, cannot: the search button. */
  readonly fallbackFocusRef: RefObject<HTMLElement | null>;
  readonly hasMore: boolean;
  readonly hostClient: HostClient;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly listsRef: RefObject<HTMLDivElement | null>;
  readonly listsStyle: CSSProperties;
  readonly namedDevices: boolean;
  readonly onClose: () => void;
  /** Where the keyboard was when search opened. */
  readonly openerRef: RefObject<HTMLElement | null>;
  readonly onLoadMore: () => void;
  readonly onOpenPlace: (place: PlaceItem) => void;
  readonly onOpenTask: (threadId: string) => void;
  readonly open: boolean;
  readonly openThreadId: string | null;
  readonly shownPlaceKey: string | null;
  readonly sources: SidebarSearchSources;
}) {
  const [query, setQuery] = useState("");
  // The chosen result by key, and by place for when its row goes.
  const [selection, setSelection] = useState<{ key: string | null; index: number }>({
    key: null,
    index: 0,
  });
  const words = useMemo(() => searchQuery(query), [query]);
  const showing = open && words.length > 0;
  const { attention, snapshot, strip, tasks } = sources;
  // Prepared once each time what it reads changes, and only while there is a query.
  const index = useMemo(
    () => (showing ? searchIndex(tasks, attention, snapshot, strip) : null),
    [showing, tasks, attention, snapshot, strip],
  );
  const groups = useMemo(() => (index ? rankedGroups(index, words) : []), [index, words]);
  const results = groups.flat();
  const at = results.findIndex((result) => result.key === selection.key);
  const selected = at >= 0 ? at : Math.min(selection.index, results.length - 1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const reveal = useRef(false);
  useScrollEdges(scrollRef);

  // As results change, the chosen one's place follows it; gone, the one now in its place is
  // chosen, and shown.
  useEffect(() => {
    if (selection.key === null || results.length === 0) return;
    if (at >= 0) {
      if (at !== selection.index) setSelection({ key: selection.key, index: at });
      return;
    }
    reveal.current = true;
    setSelection({ key: results[selected]!.key, index: selected });
  }, [at, results, selected, selection]);

  useEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    const scroller = scrollRef.current;
    const row = scroller?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!scroller || !row) return;
    // Only the results move: never the sidebar or the page around them.
    if (selected === 0) scroller.scrollTop = 0;
    else {
      const view = scroller.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      if (box.top < view.top) scroller.scrollTop -= view.top - box.top;
      else if (box.bottom > view.bottom) scroller.scrollTop += box.bottom - view.bottom;
    }
  });

  const close = () => {
    setQuery("");
    setSelection({ key: null, index: 0 });
    onClose();
  };
  const choose = (result: Result, keyboard: boolean) => {
    close();
    if (result.kind === "task") onOpenTask(result.row.threadId);
    else onOpenPlace(result.place);
    // The keyboard goes on from the row chosen, in the list it now shows; a Done task has none.
    if (keyboard)
      requestAnimationFrame(() => focusFirst(rowInList(result), fallbackFocusRef.current));
  };
  const select = (index: number, key: string) => {
    if (key !== selection.key || index !== selection.index) setSelection({ key, index });
  };

  return (
    <>
      {open ? (
        <div className="sidebar__search">
          <input
            aria-activedescendant={showing && selected >= 0 ? resultId(selected) : undefined}
            aria-autocomplete="list"
            aria-controls="sidebar-results"
            aria-expanded={showing}
            aria-label="Search tasks and tabs"
            autoComplete="off"
            className="text-input"
            id="sidebar-search"
            onBlur={() => {
              if (!query.trim()) close();
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              // A new query chooses its best match, at the top of the results.
              setSelection({ key: null, index: 0 });
              reveal.current = true;
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Search takes this Escape; the drawer around it stays open. The keyboard goes
                // back where it was, unless that is out of reach now (behind an open drawer).
                event.preventDefault();
                event.stopPropagation();
                const opener = openerRef.current;
                close();
                requestAnimationFrame(() => focusFirst(opener, fallbackFocusRef.current));
                return;
              }
              if (!showing || results.length === 0) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const next = Math.max(
                  0,
                  Math.min(results.length - 1, selected + (event.key === "ArrowDown" ? 1 : -1)),
                );
                reveal.current = true;
                select(next, results[next]!.key);
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                choose(results[selected]!, true);
              }
            }}
            placeholder="Search tasks and tabs"
            ref={inputRef}
            role="combobox"
            spellCheck={false}
            type="search"
            value={query}
          />
        </div>
      ) : null}
      <div className="sidebar__body">
        <div className="sidebar__lists" inert={showing} ref={listsRef} style={listsStyle}>
          {children}
        </div>
        {showing ? (
          <section aria-label="Search results" className="side-results">
            <div className="side-results__scroll" data-scroll-edges="" ref={scrollRef}>
              {results.length === 0 ? (
                <p className="sidebar__empty">
                  {hasMore
                    ? `Nothing in your tabs or loaded tasks matches “${query.trim()}”.`
                    : `Nothing matches “${query.trim()}”.`}
                </p>
              ) : (
                <div id="sidebar-results" role="listbox">
                  {groups.map((group, order) => {
                    const offset = groups
                      .slice(0, order)
                      .reduce((sum, each) => sum + each.length, 0);
                    const kind = group[0]!.kind;
                    return (
                      <div
                        aria-labelledby={`sidebar-results-${kind}`}
                        className="side-results__group"
                        key={kind}
                        role="group"
                      >
                        <div className="side-head" id={`sidebar-results-${kind}`}>
                          <span className="side-head__title">
                            {kind === "task" ? "Tasks" : "Tabs"}
                          </span>
                        </div>
                        {group.map((result, place) => {
                          const position = offset + place;
                          const row = {
                            id: resultId(position),
                            selected: position === selected,
                            onChoose: () => choose(result, false),
                            onPoint: () => select(position, result.key),
                          };
                          return result.kind === "task" ? (
                            <TaskResult
                              key={result.key}
                              open={result.row.threadId === openThreadId}
                              result={result}
                              {...row}
                            />
                          ) : (
                            <TabResult
                              badges={badges}
                              hostClient={hostClient}
                              key={result.key}
                              namedDevices={namedDevices}
                              shown={result.place.key === shownPlaceKey}
                              result={result}
                              {...row}
                            />
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
              {hasMore ? (
                <button className="sidebar__more" onClick={onLoadMore} type="button">
                  Show more
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}

interface Index {
  readonly tasks: readonly Found<{ readonly row: TaskRow; readonly ask: string | null }>[];
  readonly tabs: readonly Found<{
    readonly place: PlaceItem;
    readonly group: BrowserTabGroup | null;
  }>[];
}

function searchIndex(
  tasks: readonly TaskRow[],
  attention: ReadonlyMap<string, TaskAttention>,
  snapshot: Pick<HostSnapshot, "tasks" | "workspaces">,
  strip: BrowserTabStrip,
): Index {
  const threads = new Map(snapshot.tasks?.entries.map(({ thread }) => [thread.id, thread]));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const tabs: Index["tabs"][number][] = [];
  const add = (place: PlaceItem, group: BrowserTabGroup | null) =>
    tabs.push({
      key: `tab:${place.key}`,
      item: { place, group },
      fields: placeSearchFields(place, group?.title ?? null),
    });
  // Every tab, a folded group's too, in the list's order.
  for (const row of strip.web)
    if (row.kind === "place") add(row.place, null);
    else for (const place of row.places) add(place, row.group);
  for (const place of strip.native) add(place, null);
  return {
    tasks: tasks.map((row) => {
      const thread = threads.get(row.threadId);
      const ask = row.tone === "needs-you" ? (attention.get(row.threadId)?.title ?? null) : null;
      return {
        key: `task:${row.threadId}`,
        item: { row, ask },
        fields: threadSearchFields(
          {
            title: row.title,
            harnessLabel: thread?.harnessLabel ?? "",
            runnerLabel: thread?.runnerLabel ?? "",
          },
          workspaces.get(row.workspaceId)?.name ?? null,
          ask,
        ),
      };
    }),
    tabs,
  };
}

/** Tasks and Tabs, each best first, the group with the better best match first. */
function rankedGroups(index: Index, words: readonly string[]): Result[][] {
  const tasks: Result[] = rankSearch(index.tasks, (entry) => matchSearch(entry.fields, words)).map(
    ({ item: entry, match }) => ({
      kind: "task",
      key: entry.key,
      row: entry.item.row,
      ask: entry.item.ask,
      fields: entry.fields,
      match,
    }),
  );
  const tabs: Result[] = rankSearch(index.tabs, (entry) => matchSearch(entry.fields, words)).map(
    ({ item: entry, match }) => ({
      kind: "tab",
      key: entry.key,
      place: entry.item.place,
      group: entry.item.group,
      fields: entry.fields,
      match,
    }),
  );
  const groups = [tasks, tabs].filter((group) => group.length > 0);
  return groups.length === 2 && tabs[0]!.match.score > tasks[0]!.match.score
    ? [tabs, tasks]
    : groups;
}

/**
 * Hands the keyboard, if search's going left it nowhere, to the first of
 * `targets` that can take it now. Wherever it already went (search opened
 * again, a conversation taking it), it stays.
 */
function focusFirst(...targets: ReadonlyArray<HTMLElement | null>): void {
  if (document.activeElement && document.activeElement !== document.body) return;
  for (const target of targets) {
    if (!target?.isConnected || target.closest("[inert]")) continue;
    target.focus();
    if (document.activeElement === target) return;
  }
}

function resultId(position: number): string {
  return `sidebar-result-${position}`;
}

/** The chosen task's or tab's own row in the list, or its folded group's header. */
function rowInList(result: Result): HTMLElement | null {
  const lists = document.querySelector(".sidebar__lists");
  if (!lists) return null;
  if (result.kind === "task")
    return lists.querySelector<HTMLElement>(
      `[data-thread-id="${CSS.escape(result.row.threadId)}"] .side-task__main`,
    );
  return (
    lists.querySelector<HTMLElement>(
      `[data-place-key="${CSS.escape(result.place.key)}"] .side-tab__main`,
    ) ??
    (result.group
      ? lists.querySelector<HTMLElement>(
          `[data-motion-key="${CSS.escape(result.group.id)}"] .side-tab-group__main`,
        )
      : null)
  );
}

interface ResultRow {
  readonly id: string;
  readonly selected: boolean;
  readonly onChoose: () => void;
  readonly onPoint: () => void;
}

/** A row that keeps the keyboard in the field: pointing chooses it as the arrows do. */
function optionProps({ id, selected, onChoose, onPoint }: ResultRow) {
  return {
    "aria-selected": selected,
    id,
    onClick: onChoose,
    onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
    onPointerMove: onPoint,
    role: "option" as const,
  };
}

function TaskResult({
  open,
  result,
  ...row
}: ResultRow & {
  readonly open: boolean;
  readonly result: Extract<Result, { kind: "task" }>;
}) {
  const { ask, match, row: task } = result;
  const hint = match.hint;
  const classes = [
    "side-task",
    "side-result",
    `side-task--${task.tone}`,
    ask || hint ? "has-ask" : "",
    open ? "is-filled" : "",
    row.selected ? "is-selected" : "",
  ];
  return (
    <div className={classes.filter(Boolean).join(" ")} {...optionProps(row)}>
      <span className="side-task__main">
        <TaskMark
          size={20}
          mark={taskMark(task)}
          quiet={task.tone === "finished" && !task.unread}
        />
        <span className="side-task__text">
          <span className="side-task__title">
            <Lit ranges={match.ranges} text={task.title} />
          </span>
          {/* The line under the title says why it matched when the title does not. */}
          {hint && result.fields[hint.field]!.name !== "ask" ? (
            <span className="side-result__hint">
              <Lit ranges={hint.ranges} text={result.fields[hint.field]!.text.source} />
            </span>
          ) : ask ? (
            <span className="side-task__ask">
              <Lit
                ranges={hint && result.fields[hint.field]!.name === "ask" ? hint.ranges : []}
                text={ask}
              />
            </span>
          ) : null}
        </span>
        <TaskState state={task.tone} unread={task.unread} />
      </span>
    </div>
  );
}

function TabResult({
  badges,
  hostClient,
  namedDevices,
  result,
  shown,
  ...row
}: ResultRow & {
  readonly badges: boolean;
  readonly hostClient: HostClient;
  readonly namedDevices: boolean;
  readonly result: Extract<Result, { kind: "tab" }>;
  readonly shown: boolean;
}) {
  const { group, match, place } = result;
  const hint = match.hint;
  const profileMatch = hint != null && result.fields[hint.field]!.name === "profile";
  const deviceName = place.kind === "app" ? (place.device?.name ?? null) : null;
  const classes = [
    "side-tab",
    "side-result",
    group ? "side-tab--grouped" : "",
    shown ? "is-active" : "",
    place.availability === "unavailable" ? "is-unavailable" : "",
    row.selected ? "is-selected" : "",
  ];
  return (
    <div
      className={classes.filter(Boolean).join(" ")}
      style={group ? tabGroupStyle(group.color) : undefined}
      {...optionProps(row)}
    >
      <span className="side-tab__main">
        <span aria-hidden className="place-mark-badged">
          <PlaceMark hostClient={hostClient} icon={place.icon} site={place.site} />
          {(badges || profileMatch) && place.identity ? (
            <span className={profileMatch ? "pbadge side-result__profile-match" : "pbadge"}>
              <ProfileAvatar identity={place.identity} size={14} />
            </span>
          ) : null}
        </span>
        <span className="side-tab__title">
          <Lit ranges={match.ranges} text={place.title} />
        </span>
        {/* The badge says who the tab browses as to the eye; this says it to a screen reader. */}
        {(badges || profileMatch) && place.identity ? (
          <span className="visually-hidden">{`, ${place.identity.name}`}</span>
        ) : null}
        {hint && !profileMatch ? (
          <span className="side-result__hint">
            <Lit ranges={hint.ranges} text={result.fields[hint.field]!.text.source} />
          </span>
        ) : !profileMatch && deviceName ? (
          namedDevices ? (
            <span className="side-tab__device">{deviceName}</span>
          ) : (
            <DeviceGlyph name={deviceName} />
          )
        ) : null}
      </span>
    </div>
  );
}

/** `text` with the parts a query matched marked. */
function Lit({ ranges, text }: { readonly ranges: readonly SearchRange[]; readonly text: string }) {
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { start, end } of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark className="side-result__lit" key={start}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
