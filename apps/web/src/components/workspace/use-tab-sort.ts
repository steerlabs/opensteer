import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { BrowserTabMove } from "@opensteer/protocol";
import type { BrowserTabStrip } from "@opensteer/client/host";
import { rowPositions, type RowMotion } from "./row-motion.js";
import { snapTop } from "./scroll-edges.js";
import {
  homeSlot,
  nearestSlot,
  slotMove,
  slotWords,
  sortSlots,
  stepSlot,
  type SortRow,
  type SortSlot,
} from "./tab-sort.js";

/** How far a press travels before it lifts the row, as Chrome waits before dragging a tab. */
const liftAfter = 6;
/** How fast a lifted row pushed a whole row past the list's edge scrolls it, per frame. */
const scrollMax = 18;
/** How much of the way left to a whole row a gliding list goes each frame. */
const glide = 0.3;

/** A lift in progress: the list shows the strip as it was until the drop. */
export interface TabSortLift {
  readonly strip: BrowserTabStrip;
  readonly rows: readonly SortRow[];
  readonly key: string;
  /** The group being moved; its tabs fold under its header while it moves. */
  readonly groupId: string | null;
}

/** What rows call: stable for the life of the list, so memoized rows never re-render for it. */
export interface TabSortHandle {
  readonly press: (event: ReactPointerEvent<HTMLElement>, key: string) => void;
  readonly keyMove: (event: ReactKeyboardEvent<HTMLElement>, key: string) => void;
}

interface Drag {
  readonly pointerId: number;
  readonly row: HTMLElement;
  readonly key: string;
  readonly startX: number;
  readonly startY: number;
  /** How far below the row's centre the press caught it. */
  readonly grab: number;
  x: number;
  y: number;
  lifted: boolean;
  geometry: {
    readonly rows: readonly SortRow[];
    readonly from: number;
    readonly elements: readonly HTMLElement[];
    readonly slots: readonly SortSlot[];
    /** The lifted row's centre where layout puts it, in the list's scrolled content. */
    readonly centre: number;
    /**
     * How far the lifted row's centre is drawn: inside the list's content,
     * since a row drawn past its end would lengthen what the list scrolls,
     * and a drag at the foot would scroll on into empty space.
     */
    readonly reach: readonly [number, number];
    readonly step: number;
    readonly bounds: DOMRect;
  } | null;
  slot: number;
  away: boolean;
  frame: number;
  /**
   * How far the push at an edge last scrolled the list in a frame, up or
   * down; the glide after it goes no faster. 0 while the drag moves no scroll.
   */
  velocity: number;
  /** The whole row the list glides to, its scroll having stopped between rows. */
  aim: number | null;
  /** Where the glide last left the list's scroll: anywhere else, the person has scrolled it. */
  wrote: number;
  readonly stop: AbortController;
}

/**
 * Drag-and-drop and ⌘↑/⌘↓ for the tab list. While a row is lifted nothing
 * renders: the pointer moves the row and its neighbours by `translate`
 * alone, and React renders twice — when the row lifts and when it drops. The
 * drop commits one move; `RowMotion` slides every row from where it stood.
 *
 * A lifted row turns the list's snap off (its neighbours move under it), so
 * the drag lands the list on whole rows itself whenever its scroll stops —
 * a push at an edge, or the person's own scroll — as the snap would: the
 * drop then moves only the rows the new order moves.
 */
export function useTabSort(input: {
  readonly strip: BrowserTabStrip;
  readonly rows: readonly SortRow[];
  readonly movable: boolean;
  readonly list: RefObject<HTMLElement | null>;
  readonly motion: RefObject<RowMotion | null>;
  readonly move: (move: BrowserTabMove) => void;
  readonly announce: (words: string) => void;
  readonly title: (row: SortRow) => string;
}): { readonly lift: TabSortLift | null; readonly handle: TabSortHandle } {
  const [lift, setLift] = useState<TabSortLift | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const drag = useRef<Drag | null>(null);
  const refocus = useRef<string | null>(null);

  const finish = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    current.stop.abort();
    cancelAnimationFrame(current.frame);
    if (current.row.hasPointerCapture(current.pointerId))
      current.row.releasePointerCapture(current.pointerId);
    document.documentElement.removeAttribute("data-tab-sorting");
    const geometry = current.geometry;
    const list = latest.current.list.current;
    if (!current.lifted) return;
    // The click that ends a drag is not a click on the row.
    const swallow = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    // The release point decides, even when no frame has painted it yet.
    if (commit && geometry && list) follow(current, geometry, list);
    const chosen =
      commit && geometry && !current.away
        ? slotMove(geometry.rows, geometry.from, geometry.slots, current.slot)
        : null;
    if (list) {
      const positions = rowPositions(list);
      // Released while its scroll moves, the list lands where that scroll was taking it,
      // in the drop's slide; still unsnapped, so it lands exactly there.
      giveWay(current, list);
      const aim = current.aim ?? (current.velocity ? landing(list, current.velocity) : null);
      if (aim !== null) list.scrollTop = aim;
      latest.current.motion.current?.hold(positions, chosen ? current.key : null);
      list.removeAttribute("data-sorting");
      list.style.minHeight = "";
      for (const element of geometry?.elements ?? []) {
        element.style.translate = "";
        element.removeAttribute("data-sort");
        element.removeAttribute("data-sort-place");
        element.style.removeProperty("--sort-group-color");
      }
    }
    if (chosen && geometry)
      latest.current.announce(
        slotWords(
          geometry.rows,
          geometry.from,
          geometry.slots[current.slot]!,
          latest.current.title,
        ),
      );
    setLift(null);
    if (chosen) latest.current.move(chosen);
  };

  const paint = () => {
    const current = drag.current;
    const geometry = current?.geometry;
    const list = latest.current.list.current;
    if (!current || !geometry || !list) return;
    current.frame = 0;
    // A lifted row pushed past the list's edge scrolls it, faster the further it is
    // pushed (as Chrome's vertical tabs do); a row grabbed at the edge does not.
    const view = list.getBoundingClientRect();
    const centre = current.y - current.grab;
    const reach = geometry.step / 2;
    const past = Math.max(view.top - (centre - reach), centre + reach - view.bottom, 0);
    const speed = Math.ceil(scrollMax * Math.min(1, past / geometry.step) ** 2);
    const from = list.scrollTop;
    if (speed) {
      list.scrollTop += view.top > centre - reach ? -speed : speed;
      current.velocity = list.scrollTop - from;
      current.aim = null;
    } else {
      giveWay(current, list);
      // The push stopped: the list glides on to the whole row it would come to rest at.
      if (current.aim === null && current.velocity) current.aim = landing(list, current.velocity);
      if (current.aim !== null) {
        const left = current.aim - from;
        // No faster than the push had it moving, slowing as the row nears.
        const step = Math.min(
          Math.abs(current.velocity) || Infinity,
          Math.max(1, Math.abs(left) * glide),
        );
        list.scrollTop = Math.abs(left) <= step ? current.aim : from + Math.sign(left) * step;
        current.wrote = list.scrollTop;
        if (Math.abs(left) <= step) {
          current.aim = null;
          current.velocity = 0;
        }
      }
    }
    follow(current, geometry, list);
    const moving = speed ? current.velocity !== 0 : current.aim !== null;
    if (moving) current.frame = requestAnimationFrame(paint);
  };

  /** A scroll of the person's own that stopped between rows lands on whole rows, gliding. */
  const rested = () => {
    const current = drag.current;
    const list = latest.current.list.current;
    if (!current || !list) return;
    giveWay(current, list);
    // The drag's own scroll lands where it was going.
    if (current.velocity || current.aim !== null) return;
    const aim = snapTop(list);
    if (Math.abs(aim - list.scrollTop) <= 0.5) return;
    current.aim = aim;
    current.wrote = list.scrollTop;
    schedule();
  };

  /**
   * Puts the lifted row under the pointer, as far as the list's content
   * reaches, and the others where the pointer's slot puts them. Where the
   * list's content stands is read afresh each time, so the list scrolling for
   * any reason (a group folding, the drag pushing past an edge) never parts
   * the row from the pointer.
   */
  const follow = (current: Drag, geometry: NonNullable<Drag["geometry"]>, list: HTMLElement) => {
    const origin = list.getBoundingClientRect().top + list.clientTop - list.scrollTop;
    const centre = current.y - current.grab - origin;
    const [first, last] = geometry.reach;
    const dy = Math.min(Math.max(centre, first), last) - geometry.centre;
    geometry.elements[geometry.from]!.style.translate = `0 ${dy}px`;
    const away = current.x < geometry.bounds.left - 32 || current.x > geometry.bounds.right + 32;
    const slot = away
      ? homeSlot(geometry.rows, geometry.from, geometry.slots)
      : nearestSlot(geometry.slots, current.slot, centre, geometry.step);
    if (slot === current.slot && away === current.away) return;
    current.slot = slot;
    current.away = away;
    arrange(geometry, slot, away);
  };

  const schedule = () => {
    const current = drag.current;
    if (current && current.geometry && current.frame === 0)
      current.frame = requestAnimationFrame(paint);
  };

  const begin = (current: Drag) => {
    const { rows, strip } = latest.current;
    const from = rows.findIndex((row) => row.key === current.key);
    const lifted = rows[from];
    if (!lifted) {
      finish(false);
      return;
    }
    current.lifted = true;
    current.row.setPointerCapture(current.pointerId);
    // A row still sliding from the last reorder lands now, so it sits exactly under the pointer.
    for (const animation of current.row.getAnimations())
      if (animation.id === "row-motion") animation.finish();
    // The list keeps its height while a row is lifted: a group folding away never
    // shortens it, so nothing below moves and the list has nothing to scroll. Its
    // exact height: a rounded one would resize it, and refit its window under the pointer.
    const list = latest.current.list.current;
    if (list) list.style.minHeight = `${list.getBoundingClientRect().height}px`;
    // A drag moves a row, never selects the text it passes.
    window.getSelection()?.removeAllRanges();
    document.documentElement.setAttribute("data-tab-sorting", "");
    // A moving group's tabs fold under its header for the whole drag.
    const shown =
      lifted.kind === "group"
        ? rows.filter((row) => row.kind !== "tab" || row.group?.id !== lifted.groupId)
        : rows;
    setLift({
      strip,
      rows: shown,
      key: lifted.key,
      groupId: lifted.kind === "group" ? lifted.groupId : null,
    });
  };

  // Measured once the lift has rendered (a group's tabs folded away), before it paints.
  useLayoutEffect(() => {
    const current = drag.current;
    const list = input.list.current;
    if (!lift || !current || current.geometry || !list) return;
    const elements = lift.rows.map((row) =>
      list.querySelector<HTMLElement>(`:scope > [data-motion-key="${CSS.escape(row.key)}"]`),
    );
    const from = lift.rows.findIndex((row) => row.key === lift.key);
    if (from < 0 || elements.some((element) => element === null)) {
      finish(false);
      return;
    }
    const present = elements as HTMLElement[];
    const boxes = present.map((element) => ({
      top: element.offsetTop,
      height: element.offsetHeight,
    }));
    const rowGap = parseFloat(getComputedStyle(list).rowGap) || 0;
    const slots = sortSlots(lift.rows, from, { boxes, rowGap });
    // Where layout ends the content: rows still sliding (a moving group's tabs folding
    // away) would overstate it. The lifted row is in the list, so it has a last row.
    const foot = list.lastElementChild as HTMLElement;
    current.geometry = {
      rows: lift.rows,
      from,
      elements: present,
      slots,
      centre: boxes[from]!.top + boxes[from]!.height / 2,
      reach: [
        boxes[from]!.height / 2,
        foot.offsetTop + foot.offsetHeight - boxes[from]!.height / 2,
      ],
      step: boxes[from]!.height + rowGap,
      bounds: (list.closest("nav") ?? list).getBoundingClientRect(),
    };
    current.slot = homeSlot(lift.rows, from, slots);
    // However the list scrolls, the row stays under the pointer, and the list lands on whole rows.
    list.addEventListener("scroll", schedule, { signal: current.stop.signal });
    list.addEventListener("scrollend", rested, { signal: current.stop.signal });
    list.setAttribute("data-sorting", "");
    present[from]!.setAttribute("data-sort", "lifted");
    arrange(current.geometry, current.slot, false);
    paint();
  }, [lift, input.list]);

  // A keyboard move keeps the moved row focused (the list re-sorted it under the focus);
  // its slide has brought it into view.
  useLayoutEffect(() => {
    const key = refocus.current;
    const list = input.list.current;
    if (!key || !list) return;
    refocus.current = null;
    const row = list.querySelector<HTMLElement>(`:scope > [data-motion-key="${CSS.escape(key)}"]`);
    const target = row?.querySelector<HTMLElement>(".side-tab__main");
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
  });

  const handle = useRef<TabSortHandle>({
    press: (event, key) => {
      if (!latest.current.movable || drag.current) return;
      if (event.button !== 0 || event.pointerType === "touch") return;
      if (!(event.target as Element).closest(".side-tab__main")) return;
      const stop = new AbortController();
      const current: Drag = {
        pointerId: event.pointerId,
        row: event.currentTarget,
        key,
        startX: event.clientX,
        startY: event.clientY,
        grab: (() => {
          const box = event.currentTarget.getBoundingClientRect();
          return event.clientY - (box.top + box.height / 2);
        })(),
        x: event.clientX,
        y: event.clientY,
        lifted: false,
        geometry: null,
        slot: -1,
        away: false,
        frame: 0,
        velocity: 0,
        aim: null,
        wrote: 0,
        stop,
      };
      drag.current = current;
      const options = { signal: stop.signal } as const;
      window.addEventListener(
        "pointermove",
        (move) => {
          if (move.pointerId !== current.pointerId) return;
          current.x = move.clientX;
          current.y = move.clientY;
          if (!current.lifted) {
            if (Math.hypot(current.x - current.startX, current.y - current.startY) >= liftAfter)
              begin(current);
            return;
          }
          schedule();
        },
        options,
      );
      window.addEventListener(
        "pointerup",
        (up) => {
          if (up.pointerId !== current.pointerId) return;
          current.x = up.clientX;
          current.y = up.clientY;
          finish(true);
        },
        options,
      );
      window.addEventListener(
        "pointercancel",
        (cancel) => {
          if (cancel.pointerId === current.pointerId) finish(false);
        },
        options,
      );
      window.addEventListener(
        "keydown",
        (key) => {
          if (key.key !== "Escape" || !current.lifted) return;
          key.preventDefault();
          key.stopPropagation();
          finish(false);
        },
        { capture: true, signal: stop.signal },
      );
      window.addEventListener("blur", () => finish(false), options);
      current.row.addEventListener(
        "lostpointercapture",
        () => {
          if (drag.current === current && current.lifted) finish(false);
        },
        options,
      );
    },
    keyMove: (event, key) => {
      if (!latest.current.movable || drag.current) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      const { rows } = latest.current;
      const lifted = rows.find((row) => row.key === key);
      if (!lifted) return;
      const shown =
        lifted.kind === "group"
          ? rows.filter((row) => row.kind !== "tab" || row.group?.id !== lifted.groupId)
          : rows;
      const from = shown.indexOf(lifted);
      const step = stepSlot(shown, from, event.key === "ArrowUp" ? -1 : 1);
      if (!step) return;
      const chosen = slotMove(shown, from, step.slots, step.slot);
      if (!chosen) return;
      refocus.current = key;
      const list = latest.current.list.current;
      if (list) latest.current.motion.current?.hold(rowPositions(list), key);
      latest.current.announce(slotWords(shown, from, step.slots[step.slot]!, latest.current.title));
      latest.current.move(chosen);
    },
  }).current;

  return { lift, handle };
}

/**
 * The whole row a list scrolling `velocity` a frame comes to rest at, gliding
 * on as `paint` does: of those ahead of it, the one nearest where that glide
 * would carry it. It never turns back on the scroll.
 */
function landing(list: HTMLElement, velocity: number): number {
  return snapTop(list, null, list.scrollTop + velocity / glide, Math.sign(velocity));
}

/** A glide the person's own scroll has moved the list under gives way to it: its end lands the list. */
function giveWay(current: Drag, list: HTMLElement): void {
  if (current.aim === null || Math.abs(list.scrollTop - current.wrote) <= 0.5) return;
  current.aim = null;
  current.velocity = 0;
}

/**
 * Stands every row where `slot` puts it: the rows between the lifted row's
 * place and its slot shift by one row, the lifted row wears the look of where
 * it would land, and a collapsed header it would drop onto lights up.
 */
function arrange(geometry: NonNullable<Drag["geometry"]>, slot: number, away: boolean): void {
  const target = geometry.slots[slot]!;
  const gap = away || target.gap === null ? geometry.from : target.gap;
  for (const [index, element] of geometry.elements.entries()) {
    if (index === geometry.from) continue;
    const rest = index > geometry.from ? index - 1 : index;
    const shift = (rest >= gap ? geometry.step : 0) - (index > geometry.from ? geometry.step : 0);
    element.style.translate = shift ? `0 ${shift}px` : "";
    element.toggleAttribute("data-sort", target.onto === element.dataset.motionKey && !away);
    if (target.onto === element.dataset.motionKey && !away) element.dataset.sort = "target";
  }
  const lifted = geometry.elements[geometry.from]!;
  lifted.dataset.sort = away ? "away" : "lifted";
  if (geometry.rows[geometry.from]!.kind !== "tab") return;
  const inside = !away && target.onto === null && target.group !== null;
  lifted.dataset.sortPlace = inside ? "group" : "root";
  if (inside)
    lifted.style.setProperty("--sort-group-color", `var(--tab-group-${target.group!.color})`);
}
