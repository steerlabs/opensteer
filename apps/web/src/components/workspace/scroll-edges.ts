import { useEffect, type RefObject } from "react";

/** How long the slim scrollbar stays after the list stops moving. */
const scrollingLinger = 800;

/** Lists the person has scrolled since their selection last changed. */
const scrolledByPerson = new WeakSet<HTMLElement>();

/**
 * Marks a scrolling list's edges that have more beyond them
 * (`data-more-above`, `data-more-below`), so its stylesheet draws a hairline
 * at only those, and marks it `data-scrolling` while it moves.
 * Until the person scrolls it, the list keeps its current row (`aria-current`)
 * in view as the lists around it load and resize. Written straight to the
 * element: scrolling never renders React, and nothing here moves a list the
 * person is scrolling.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const list = ref.current;
    if (!list) return;
    let frame = 0;
    let height = list.clientHeight;
    const measure = () => {
      frame = 0;
      if (list.clientHeight !== height) {
        height = list.clientHeight;
        // Rows on the move are not where layout puts them; a drag or slide keeps the view.
        if (!scrolledByPerson.has(list) && !moving(list)) {
          const current = list.querySelector<HTMLElement>("[aria-current]");
          if (current) placeInView(list, current.closest("li") ?? current);
        }
      }
      const above = list.scrollTop > 1;
      const below = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
      list.toggleAttribute("data-more-above", above);
      list.toggleAttribute("data-more-below", below);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    let still = 0;
    const scrolled = () => {
      schedule();
      list.setAttribute("data-scrolling", "");
      window.clearTimeout(still);
      still = window.setTimeout(() => list.removeAttribute("data-scrolling"), scrollingLinger);
    };
    const personScrolls = (event: Event) => {
      if (event.type !== "pointerdown" || event.target === list) scrolledByPerson.add(list);
    };
    measure();
    list.addEventListener("scroll", scrolled, { passive: true });
    for (const type of ["wheel", "touchmove", "keydown", "pointerdown"])
      list.addEventListener(type, personScrolls, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(list);
    // Rows coming, going or growing an ask line change what is beyond an edge.
    const rows = new MutationObserver(schedule);
    rows.observe(list, { childList: true, subtree: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.clearTimeout(still);
      list.removeEventListener("scroll", scrolled);
      for (const type of ["wheel", "touchmove", "keydown", "pointerdown"])
        list.removeEventListener(type, personScrolls);
      resize?.disconnect();
      rows.disconnect();
    };
  }, [ref]);
}

/**
 * The snap position nearest `near` (where a snapped list stands, unless
 * given) — a row's top, or the list's end for a row past it — among those
 * that keep `keep` whole in its window and, given a `direction` (down 1, up
 * -1), lie that way from where it stands. Rows count where layout puts them
 * in the list (their offset parent): a drag or a slide drawing one elsewhere
 * does not move its snap.
 */
export function snapTop(
  list: HTMLElement,
  keep: HTMLElement | null = null,
  near = list.scrollTop,
  direction = 0,
): number {
  const view = windowHeight(list);
  const end = list.scrollHeight - list.clientHeight;
  let best = list.scrollTop;
  let distance = Infinity;
  for (const row of list.children) {
    if (!(row instanceof HTMLElement) || getComputedStyle(row).scrollSnapAlign === "none") continue;
    const top = row.offsetTop;
    if (
      keep &&
      (keep.offsetTop < top - 0.5 || keep.offsetTop + keep.offsetHeight > top + view + 0.5)
    )
      continue;
    const at = Math.min(top, end);
    if ((at - list.scrollTop) * direction < -0.5) continue;
    if (Math.abs(at - near) < distance) {
      best = at;
      distance = Math.abs(at - near);
    }
  }
  return best;
}

/**
 * A scroll lands on a whole pixel while rows stand on fractions of one: a row
 * within this much of the window's edges is in it.
 */
const landing = 1;

/** A list a drag or a slide is moving: its rows are not where layout puts them. */
function moving(list: HTMLElement): boolean {
  return list.hasAttribute("data-sorting") || list.hasAttribute("data-moving");
}

/** The list's window inside its edge lines, to the fraction of a pixel rows are laid out in. */
function windowHeight(list: HTMLElement): number {
  const { top, bottom } = windowEdges(list);
  return bottom - top;
}

/** Where the list's window starts and ends on screen, inside its edge lines. */
function windowEdges(list: HTMLElement): { readonly top: number; readonly bottom: number } {
  const box = list.getBoundingClientRect();
  const style = getComputedStyle(list);
  return {
    top: box.top + (parseFloat(style.borderTopWidth) || 0),
    bottom: box.bottom - (parseFloat(style.borderBottomWidth) || 0),
  };
}

/**
 * Brings a row fully into its list's view, flush with the edge it comes in
 * at, so it lands on the list's snap to whole rows; moving only that list
 * (never the page or the sidebar around it).
 */
export function revealInList(row: HTMLElement): void {
  const list = row.closest<HTMLElement>("[data-scroll-edges]");
  if (!list) return;
  scrolledByPerson.delete(list);
  placeInView(list, row);
}

function placeInView(list: HTMLElement, row: HTMLElement): void {
  const { top, bottom } = windowEdges(list);
  const box = row.getBoundingClientRect();
  if (box.top < top - landing) list.scrollTop -= top - box.top;
  else if (box.bottom > bottom + landing) list.scrollTop += box.bottom - bottom;
}
