import { useCallback, useEffect, useRef } from "react";
import { usePersistedPaneSize, type PaneSizeRange } from "../pane-resize-handle.js";
import { fitWholeRows, wholeRowSteps } from "./scroll-edges.js";

/**
 * Tasks' share of the height Tasks and Tabs divide, in ten-thousandths: the
 * weight its section grows by, Tabs growing by the rest. Whole weights let
 * either section take all the room the other leaves (flex factors summing
 * under one take only that fraction of it), and are fine enough that a share
 * lands Tasks within the half pixel a whole row allows.
 */
const shares = 10_000;
const tasksShareRange: PaneSizeRange = {
  defaultValue: shares / 2,
  max: shares - 1,
  min: 1,
  step: 1,
};

/** Tasks' share, as this device keeps it, and the commit that keeps a new one. */
export function useTasksShare() {
  const [share, , commit] = usePersistedPaneSize("opensteer.sidebar-tasks-share", tasksShareRange);
  return [share, commit] as const;
}

/** Where the line can stop, read from the layout as it stands. */
interface Reach {
  readonly sidebar: HTMLElement;
  readonly tasks: HTMLElement;
  /** The height Tasks and Tabs divide: from Tasks' top to their container's end. */
  readonly room: number;
  /** Where the line stands: Tasks' height. */
  readonly start: number;
  /**
   * Tasks' height to the foot of its last row in view: where the line
   * stands, or above it while a scroll's rest leaves a taller row's gap.
   */
  readonly foot: number;
  /**
   * The heights Tasks can stop at, lowest first, each ending its list at a
   * row's foot: from its floor, or what all of Tabs' rows leave, to all its
   * rows, or what Tabs' floor leaves.
   */
  readonly stops: readonly number[];
}

/**
 * The line between Tasks and Tabs. It stops at the row edge nearest the
 * pointer, and only as far as the rows go; the share it keeps is the one that
 * gives Tasks exactly what it then shows. While it moves it reads where it can
 * stop each frame (a move scrolls Tasks to keep its open row, the window may
 * change), writes the share straight to the sidebar and fits the lists in the
 * same frame, so the sidebar renders only at the release.
 */
export function SideSplit({
  onCommit,
  share,
}: {
  readonly onCommit: (share: number) => void;
  readonly share: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  // A release, a cancel or the line going away mid-drag keeps where it got to.
  const finish = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    ref.current?.removeAttribute("data-resizing");
    document.documentElement.classList.remove("is-resizing-split");
    if (!current) return;
    cancelAnimationFrame(current.frame);
    if (ref.current) follow(ref.current, current);
    if (current.latest !== current.from) commit.current(current.latest);
  }, []);
  useEffect(() => finish, [finish]);
  // Reached for, it says whether it can move; a line that cannot never lights.
  const probe = (divider: HTMLDivElement) =>
    divider.toggleAttribute("data-fixed", reachOf(divider) === null);
  const percent = Math.round((share / shares) * 100);

  return (
    <div
      aria-label="Resize Tasks and Tabs"
      aria-orientation="horizontal"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
      aria-valuetext={`Tasks ${percent}%, Tabs ${100 - percent}%`}
      className="side-split"
      onDoubleClick={() => {
        const sidebar = ref.current?.parentElement;
        if (!sidebar) return;
        apply(sidebar, tasksShareRange.defaultValue);
        onCommit(tasksShareRange.defaultValue);
      }}
      onFocus={(event) => probe(event.currentTarget)}
      onKeyDown={(event) => {
        const reach = reachOf(event.currentTarget);
        const height = reach ? keyedHeight(reach, event.key) : null;
        if (!reach || height === null) return;
        event.preventDefault();
        onCommit(place(reach, height));
      }}
      onLostPointerCapture={finish}
      onPointerCancel={finish}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const reach = reachOf(event.currentTarget);
        if (!reach) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.setAttribute("data-resizing", "");
        document.documentElement.classList.add("is-resizing-split");
        drag.current = {
          anchor: reach.start - event.clientY,
          frame: 0,
          from: share,
          latest: share,
          pointerId: event.pointerId,
          y: event.clientY,
        };
      }}
      onPointerEnter={(event) => probe(event.currentTarget)}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        current.y = event.clientY;
        // The lists follow the pointer at most once a frame.
        const divider = event.currentTarget;
        if (current.frame === 0)
          current.frame = requestAnimationFrame(() => {
            current.frame = 0;
            if (drag.current === current) follow(divider, current);
          });
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) finish();
      }}
      ref={ref}
      role="separator"
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
    />
  );
}

/** A held line: the share it was pressed at and the one it keeps now. */
interface Drag {
  readonly pointerId: number;
  /** Tasks' height where the line was pressed, less the pointer's height then. */
  readonly anchor: number;
  readonly from: number;
  frame: number;
  latest: number;
  y: number;
}

/**
 * Moves the line to the row edge nearest the pointer, once one is nearer than
 * where it stands. Once it has moved, what it keeps is what Tasks shows now,
 * in the room there is now: the window may change while the line is held.
 */
function follow(divider: HTMLElement, drag: Drag): void {
  const reach = reachOf(divider);
  if (!reach) return;
  const height = drag.anchor + drag.y;
  const stop = nearestStop(reach, height);
  if (Math.abs(height - reach.start) > Math.abs(height - stop)) drag.latest = place(reach, stop);
  else if (drag.latest !== drag.from) drag.latest = shareOf(reach, reach.foot);
}

/**
 * Gives Tasks `height` and returns the share that gives it exactly what it
 * then shows, written to the sidebar: the fit, not the reading, decides which
 * row ends it.
 */
function place(reach: Reach, height: number): number {
  const aimed = shareOf(reach, height);
  apply(reach.sidebar, aimed);
  const shown = shareOf(reach, reach.tasks.getBoundingClientRect().height);
  if (shown !== aimed) apply(reach.sidebar, shown);
  return shown;
}

function apply(sidebar: HTMLElement, share: number): void {
  fitWholeRows(sidebar, () => sidebar.style.setProperty("--side-tasks-share", String(share)));
}

function nearestStop(reach: Reach, height: number): number {
  return reach.stops.reduce((best, stop) =>
    Math.abs(stop - height) < Math.abs(best - height) ? stop : best,
  );
}

/** The row edge above or below the last row in view, or as far as Tasks goes. */
function keyedHeight({ foot, stops }: Reach, key: string): number | null {
  switch (key) {
    case "ArrowUp":
      return stops.findLast((stop) => stop < foot - 0.5) ?? stops[0]!;
    case "ArrowDown":
      return stops.find((stop) => stop > foot + 0.5) ?? stops.at(-1)!;
    case "Home":
      return stops[0]!;
    case "End":
      return stops.at(-1)!;
    default:
      return null;
  }
}

/**
 * The share that gives Tasks `height`, aimed a quarter pixel past it: within
 * what the fit lets either list overrun, and more than rounding the share can
 * take back, so a row the line stopped below is never lost.
 */
function shareOf(reach: Reach, height: number): number {
  return Math.min(shares - 1, Math.max(1, Math.round(((height + 0.25) / reach.room) * shares)));
}

/** Null when Tasks can neither grow nor shrink: every row of both fits, or a floor holds. */
function reachOf(divider: HTMLElement): Reach | null {
  // The sections' container: Tabs, last, runs to its end.
  const sidebar = divider.parentElement;
  const tasks = divider.previousElementSibling;
  const tabs = divider.nextElementSibling;
  const list = tasks?.querySelector<HTMLElement>("[data-whole-rows]");
  if (!sidebar || !(tasks instanceof HTMLElement) || !(tabs instanceof HTMLElement)) return null;
  // A Tasks heading with no rows under it has nothing to give or take.
  if (!list) return null;
  const box = tasks.getBoundingClientRect();
  const room = sidebar.getBoundingClientRect().bottom - box.top;
  const foot = list.getBoundingClientRect().bottom - box.top;
  const feet = wholeRowSteps(list).map((step) => foot + step);
  const below = (limit: number) => Math.max(...feet.filter((stop) => stop <= limit + 0.5));
  const above = (limit: number) => Math.min(...feet.filter((stop) => stop >= limit - 0.5));
  // Its floor is three short rows' pitch: where taller rows end it, the next
  // row's foot, so no gap opens that no row fills. Below what all of Tabs'
  // rows leave, Tabs would take nothing more.
  const least = Math.max(above(floorOf(tasks)), below(room - fullHeightOf(tabs)));
  const most = below(Math.min(fullHeightOf(tasks), room - floorOf(tabs)));
  if (most - least < 1) return null;
  return {
    sidebar,
    tasks,
    room,
    start: box.height,
    foot,
    stops: feet.filter((stop) => stop >= least - 0.5 && stop <= most + 0.5).sort((a, b) => a - b),
  };
}

function floorOf(section: HTMLElement): number {
  return parseFloat(getComputedStyle(section).minHeight) || 0;
}

/** The section's height with every row in view, or what a tab filter holds Tabs to. */
export function fullHeightOf(section: HTMLElement): number {
  const held = parseFloat(section.style.maxHeight);
  if (!Number.isNaN(held)) return held;
  const box = section.getBoundingClientRect();
  const list = section.querySelector<HTMLElement>(".side-list");
  if (!list) return box.height;
  return (
    list.getBoundingClientRect().top -
    box.top +
    list.offsetHeight -
    list.clientHeight +
    list.scrollHeight
  );
}
