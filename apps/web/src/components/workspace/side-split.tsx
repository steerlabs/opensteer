import { useCallback, useEffect, useRef, useState } from "react";
import { fitWholeRows } from "./scroll-edges.js";

const tabsHeightKey = "opensteer.sidebar-tabs-height";

/**
 * Tabs' height in pixels, as this device keeps it, and the commit that keeps a
 * new one. Null until the person moves the line: the stylesheet's default then
 * holds. Tabs owns its height, so what shows above it (Tasks, Done, a team)
 * never moves it.
 */
export function useTabsHeight() {
  const [height, setHeight] = useState(readTabsHeight);
  const commit = useCallback((next: number | null) => {
    setHeight(next);
    try {
      if (next === null) localStorage.removeItem(tabsHeightKey);
      else localStorage.setItem(tabsHeightKey, String(next));
    } catch {
      // A preference only: the height still applies for this window.
    }
  }, []);
  return [height, commit] as const;
}

function readTabsHeight(): number | null {
  try {
    const stored = Number(localStorage.getItem(tabsHeightKey));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** How far the line can move, read from the layout as it stands. */
interface Reach {
  /** The sections' container, which carries `--side-tabs-height`. */
  readonly lists: HTMLElement;
  /** The height the pane above and Tabs divide. */
  readonly room: number;
  /** Where the line stands: Tabs' height. */
  readonly start: number;
  /** Tabs' least height, its floor, and its most: all its rows, or what the pane above's floor leaves. */
  readonly least: number;
  readonly most: number;
  /** One tab row and the gap after it: a key's step. */
  readonly row: number;
}

/**
 * The line along Tabs' top. It follows the pointer, as far as Tabs' floor
 * and its rows go; a row in part at Tabs' foot says there is more. While it
 * moves it writes Tabs' height straight to the sections' container and fits
 * the lists in the same frame, so the sidebar renders only at the release.
 */
export function SideSplit({ onCommit }: { readonly onCommit: (height: number | null) => void }) {
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
  // Reached for, it says where it stands and whether it can move; a line that cannot never lights.
  const probe = (divider: HTMLDivElement) => {
    const reach = reachOf(divider);
    divider.toggleAttribute("data-fixed", reach === null);
    if (reach) describe(divider, reach.start, reach.room);
  };

  return (
    <div
      aria-label="Resize Tabs"
      aria-orientation="horizontal"
      aria-valuemax={100}
      aria-valuemin={0}
      className="side-split"
      onDoubleClick={(event) => {
        const lists = event.currentTarget.parentElement;
        if (!lists) return;
        fitWholeRows(lists, () => lists.style.removeProperty("--side-tabs-height"));
        onCommit(null);
      }}
      onFocus={(event) => probe(event.currentTarget)}
      onKeyDown={(event) => {
        const reach = reachOf(event.currentTarget);
        const height = reach ? keyedHeight(reach, event.key) : null;
        if (!reach || height === null) return;
        event.preventDefault();
        place(event.currentTarget, reach, height);
        onCommit(height);
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
          anchor: reach.start + event.clientY,
          frame: 0,
          from: reach.start,
          latest: reach.start,
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

/** A held line: Tabs' height where it was pressed and the one it keeps now. */
interface Drag {
  readonly pointerId: number;
  /** Tabs' height where the line was pressed, plus the pointer's height then. */
  readonly anchor: number;
  readonly from: number;
  frame: number;
  latest: number;
  y: number;
}

/** Gives Tabs the height the pointer asks for, within its reach (which the window may change). */
function follow(divider: HTMLElement, drag: Drag): void {
  const reach = reachOf(divider);
  if (!reach) return;
  const height = within(reach, drag.anchor - drag.y);
  if (height === reach.start) return;
  place(divider, reach, height);
  drag.latest = height;
}

function place(divider: HTMLElement, reach: Reach, height: number): void {
  fitWholeRows(reach.lists, () =>
    reach.lists.style.setProperty("--side-tabs-height", `${height}px`),
  );
  describe(divider, height, reach.room);
}

/** The line's value for assistive technology: the part of the room Tabs takes. */
function describe(divider: HTMLElement, height: number, room: number): void {
  const percent = Math.round((height / room) * 100);
  divider.setAttribute("aria-valuenow", String(percent));
  divider.setAttribute("aria-valuetext", `Tabs ${percent}%`);
}

function within({ least, most }: Reach, height: number): number {
  return Math.min(most, Math.max(least, height));
}

/** A row up or down, or as far as Tabs goes; up grows Tabs. */
function keyedHeight(reach: Reach, key: string): number | null {
  switch (key) {
    case "ArrowUp":
      return within(reach, reach.start + reach.row);
    case "ArrowDown":
      return within(reach, reach.start - reach.row);
    case "Home":
      return within(reach, reach.most);
    case "End":
      return within(reach, reach.least);
    default:
      return null;
  }
}

/** Null when Tabs can neither grow nor shrink: it is at its floor and shows every row. */
function reachOf(divider: HTMLElement): Reach | null {
  const lists = divider.parentElement;
  const above = divider.previousElementSibling;
  const tabs = divider.nextElementSibling;
  if (!lists || !(above instanceof HTMLElement) || !(tabs instanceof HTMLElement)) return null;
  const list = tabs.querySelector<HTMLElement>(".side-list");
  if (!list) return null;
  const start = tabs.getBoundingClientRect().height;
  const room = above.getBoundingClientRect().height + start;
  const least = floorOf(tabs);
  const most = Math.max(least, Math.min(fullHeightOf(tabs), room - floorOf(above)));
  if (most - least < 1) return null;
  return { lists, room, start, least, most, row: rowOf(list) };
}

/** The first drawn row's height and the gap after it. */
function rowOf(list: HTMLElement): number {
  const row = [...list.children].find(
    (child) => !child.classList.contains("side-list__spacer") && child.clientHeight >= 2,
  );
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  return (
    (row?.getBoundingClientRect().height ??
      parseFloat(getComputedStyle(list).getPropertyValue("--side-pitch"))) + gap
  );
}

function floorOf(section: HTMLElement): number {
  return parseFloat(getComputedStyle(section).minHeight) || 0;
}

/** The section's height with every row in view, or what a tab filter holds Tabs to. */
export function fullHeightOf(section: HTMLElement): number {
  const held = parseFloat(section.style.maxHeight);
  if (!Number.isNaN(held)) return held;
  const list = section.querySelector<HTMLElement>(".side-list");
  if (!list) return section.getBoundingClientRect().height;
  return section.getBoundingClientRect().height - list.clientHeight + list.scrollHeight;
}
