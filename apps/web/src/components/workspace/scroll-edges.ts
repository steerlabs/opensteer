import { useEffect, type RefObject } from "react";

/** How long the slim scrollbar stays after the list stops moving. */
const scrollingLinger = 800;
/** A list that has had no scroll event for this long has come to rest. */
const restAfter = 120;

/** Lists the person has scrolled since their selection last changed. */
const scrolledByPerson = new WeakSet<HTMLElement>();

/**
 * Marks a scrolling list's edges that have more beyond them
 * (`data-more-above`, `data-more-below`), so its stylesheet draws a hairline
 * at only those, and marks it `data-scrolling` while it moves.
 * Until the person scrolls it, the list keeps its current row (`aria-current`)
 * in view as the lists around it load and resize. Written straight to the
 * element: scrolling never renders React. How tall the list is belongs to
 * `useWholeRows` alone.
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
 * The one owner of how tall each `[data-whole-rows]` list is, so neither of
 * its edges shows part of a row (its rows snap to the top edge). A list is
 * cut at a row's foot so the list after it can use the rest; the last list
 * (Tabs) has none after it, so it is no whole-row list: it runs to the
 * container's end and snaps its rows to its top, but at its end, where its
 * last row stands whole at the container's end instead.
 *
 * - When the shape of what it lays out changes — the container's size (the
 *   window, zoom), anything around the lists taking its height (the search
 *   field, a heading, the footer), the box each list is given, any list's
 *   rows (one coming, going, growing an ask line, a font size) — every list
 *   is measured again from the space flexbox gives it with no window set:
 *   each ends at the foot of its last whole row, and the space below is the
 *   next list's to use.
 * - When one list's scroll comes to rest, only that list is measured again,
 *   from the space it has; a taller row across its foot shortens its window
 *   inside its own section (`--side-cut`), so nothing else moves under the
 *   pointer.
 *
 * Either way a window starts at a row's top: one that stopped between rows
 * (at the list's end, where snapping stops short of a row) moves on to the
 * next whole row, as its snap would.
 */
export function useWholeRows(ref: RefObject<HTMLElement | null>, shown: boolean): void {
  useEffect(() => {
    const container = ref.current;
    if (!container || !shown) return;
    const lists = () => wholeRowLists(container);
    let frame = 0;
    // Shown again, its lists are new: they are fitted whatever shape was fitted before.
    fittedShapes.delete(container);
    const fit = () => {
      frame = 0;
      if (rowsMoving(container) || shapeOf(container, lists()) === fittedShapes.get(container))
        return;
      fitWholeRows(container);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(fit);
    };
    const rest = (list: HTMLElement) => {
      // A rest queued before a drag or a slide began, in any list, waits for the rows to stand still.
      if (rowsMoving(container)) return;
      const cut = parseFloat(list.style.getPropertyValue("--side-cut")) || 0;
      const full = windowHeight(list) + cut;
      if (list.scrollHeight <= full + 0.5) {
        if (cut !== 0) list.style.setProperty("--side-cut", "0px");
        return;
      }
      const { top, whole } = wholeWindow(list, full);
      if (whole <= 0) return;
      const next = Math.round((full - whole) * 100) / 100;
      if (Math.abs(next - cut) > 0.01) list.style.setProperty("--side-cut", `${next}px`);
      if (Math.abs(list.scrollTop - top) > 0.5) list.scrollTop = top;
    };
    const resting = new Map<HTMLElement, number>();
    const scrolled = (event: Event) => {
      const list = event.target;
      if (
        !(list instanceof HTMLElement) ||
        !list.hasAttribute("data-whole-rows") ||
        rowsMoving(container)
      )
        return;
      window.clearTimeout(resting.get(list));
      resting.set(
        list,
        window.setTimeout(() => {
          resting.delete(list);
          rest(list);
        }, restAfter),
      );
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    // Every box the shape reads, so a font, an ask line or a field opening refits too.
    const observeRows = () => {
      resize?.disconnect();
      resize?.observe(container);
      const all = lists();
      for (const element of chromeOf(container, all)) resize?.observe(element);
      for (const list of all) {
        resize?.observe(list);
        for (const row of list.children) resize?.observe(row);
      }
    };
    const rows = new MutationObserver((records) => {
      observeRows();
      schedule();
      if (rowsMoving(container)) return;
      // A list whose rows changed, or that waited for rows anywhere to stand still, lands on
      // whole rows again.
      for (const list of lists())
        if (records.some((record) => record.type === "attributes" || record.target === list))
          rest(list);
    });
    fit();
    observeRows();
    rows.observe(container, {
      childList: true,
      subtree: true,
      attributeFilter: ["data-sorting", "data-moving"],
    });
    container.addEventListener("scroll", scrolled, { capture: true, passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      for (const timer of resting.values()) window.clearTimeout(timer);
      container.removeEventListener("scroll", scrolled, { capture: true });
      resize?.disconnect();
      rows.disconnect();
    };
  }, [ref, shown]);
}

/** The shape each container's lists were last fitted to, so an unchanged one is not fitted again. */
const fittedShapes = new WeakMap<HTMLElement, string>();

/**
 * Fits the container's `[data-whole-rows]` lists to the space they are given
 * now, as `useWholeRows` does a frame after their shape changes. A gesture
 * that changes how the space is shared passes its `change` in, to be made
 * here: no frame paints part of a row, a list that grows is not held at the
 * window it was cut to, and what each window keeps is read as it was shown,
 * before the change moves anything.
 */
export function fitWholeRows(container: HTMLElement, change?: () => void): void {
  // Rows on the move, in any list, stand where nothing lays them out; the fit waits until they rest.
  if (rowsMoving(container)) {
    change?.();
    return;
  }
  const all = wholeRowLists(container);
  const kept = all.map(keptRow);
  change?.();
  for (const list of all) {
    list.style.maxHeight = "";
    list.style.setProperty("--side-cut", "0px");
  }
  // In order: the space one list leaves is the next one's to use.
  all.forEach((list, index) => fitWindow(list, kept[index]!));
  // As it now is, so the windows this fit set are not a change to fit again.
  fittedShapes.set(container, shapeOf(container, all));
}

/**
 * How much a fit can change the list's window from where it stands, by whole
 * rows, no change first: rows leave as a fit takes them (from the foot, then,
 * once only the row it keeps is left at the foot, from the top), and rows
 * come from below, then (a list scrolled to its end grows upward) from above.
 */
export function wholeRowSteps(list: HTMLElement): number[] {
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  const { top, bottom } = windowEdges(list);
  const rows = [...list.children]
    .map((row) => ({ box: row.getBoundingClientRect(), row }))
    .filter(({ box }) => box.height >= 2);
  const shown = rows.filter(
    ({ box }) => box.top >= top - landing && box.bottom <= bottom + landing,
  );
  const kept = keptRow(list);
  const keptAt = shown.findIndex(({ row }) => row === kept);
  const leaving =
    keptAt < 0
      ? shown.reverse()
      : [...shown.slice(keptAt + 1).reverse(), ...shown.slice(0, keptAt)];
  const coming = [
    ...rows.filter(({ box }) => box.top >= bottom - landing),
    ...rows.filter(({ box }) => box.bottom <= top + landing).reverse(),
  ];
  const steps = [0];
  let fewer = 0;
  for (const { box } of leaving) steps.push((fewer -= box.height + gap));
  let more = 0;
  for (const { box } of coming) steps.push((more += box.height + gap));
  return steps;
}

/**
 * Ends a list's window, from the space it is given with no window set, at the
 * foot of its last whole row, from the row top its scroll stands at (or the
 * next one, where it stopped between rows at the list's end), moved only as
 * far as keeps `kept` whole.
 */
function fitWindow(list: HTMLElement, kept: Element | null): void {
  const view = windowHeight(list);
  if (list.scrollHeight <= view + 0.5) return;
  const { top, whole } = wholeWindow(list, view, kept);
  if (whole > 0 && whole < view - 0.01)
    list.style.maxHeight = `${whole + list.getBoundingClientRect().height - view}px`;
  if (whole > 0) list.scrollTop = top;
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

function wholeRowLists(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-whole-rows]")];
}

/**
 * Until the person scrolls the list, its current row, while in its window,
 * stays there as the window shrinks; a row out of view is not brought back.
 */
function keptRow(list: HTMLElement): Element | null {
  if (scrolledByPerson.has(list)) return null;
  const row = list.querySelector("[aria-current]")?.closest("li");
  if (!row) return null;
  const { top, bottom } = windowEdges(list);
  const box = row.getBoundingClientRect();
  return box.top >= top - landing && box.bottom <= bottom + landing ? row : null;
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

/** Whether any list in the container is moving: a fit then would move rows under the pointer. */
function rowsMoving(container: HTMLElement): boolean {
  return container.querySelector("[data-sorting], [data-moving]") !== null;
}

/**
 * Everything a fit depends on: the container's height, the height everything
 * around the lists takes from it, the box each list is given (as it would be
 * without the shortening a scroll's rest made), and every list's rows, in
 * order and size.
 */
function shapeOf(container: HTMLElement, lists: readonly HTMLElement[]): string {
  return [
    container.clientHeight,
    chromeOf(container, lists).map(outerHeight).join(","),
    lists
      .map(
        (list) =>
          Math.round(
            (list.getBoundingClientRect().height +
              (parseFloat(list.style.getPropertyValue("--side-cut")) || 0)) *
              4,
          ) / 4,
      )
      .join(","),
    ...lists.map((list) => [...list.children].map(outerHeight).join(",")),
  ].join("|");
}

/** What shares the container's height with the lists: its other children, and their sections' headings. */
function chromeOf(container: HTMLElement, lists: readonly HTMLElement[]): HTMLElement[] {
  return [...container.children].flatMap((child) => {
    if (!(child instanceof HTMLElement)) return [];
    if (!lists.some((list) => child.contains(list))) return [child];
    return [...child.children].filter(
      (part): part is HTMLElement => part instanceof HTMLElement && !lists.includes(part),
    );
  });
}

function outerHeight(element: Element): string {
  const style = getComputedStyle(element);
  return [
    Math.round(element.getBoundingClientRect().height * 4) / 4,
    style.marginTop,
    style.marginBottom,
  ].join(" ");
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
 * The window of whole rows a list shows from where it is scrolled: it starts
 * at the first row whose top is in view (scroll position `top`) and reaches
 * the foot of the last row that fits a window this tall, the gap a row keeps
 * below itself included (the space between two browsers' tabs belongs to the
 * rows beside it). A `kept` row the window would miss moves it, to start at
 * that row or to end at its foot.
 */
function wholeWindow(
  list: HTMLElement,
  view: number,
  kept: Element | null = null,
): { readonly top: number; readonly whole: number } {
  const origin = list.getBoundingClientRect().top + list.clientTop - list.scrollTop;
  const rows = [...list.children]
    .map((row) => ({ box: row.getBoundingClientRect(), row }))
    .filter(({ box }) => box.height >= 2)
    .map(({ box, row }) => ({
      row,
      top: box.top - origin - (parseFloat(getComputedStyle(row).scrollMarginTop) || 0),
      foot: box.bottom - origin,
      gap: parseFloat(getComputedStyle(row).marginBottom) || 0,
    }));
  let first = rows.find((row) => row.top >= list.scrollTop - 0.5);
  const keep = rows.find((row) => row.row === kept);
  if (first && keep) {
    if (keep.top < first.top - 0.5) first = keep;
    else if (keep.foot - first.top > view + 0.01)
      first = rows.find((row) => row.top >= keep.foot - view - 0.01) ?? keep;
  }
  const top = first ? first.top : list.scrollTop;
  let whole = 0;
  for (const row of rows) {
    if (row.foot <= top + 0.5) continue;
    if (row.foot - top > view + 0.01) break;
    whole = Math.max(whole, Math.min(view, row.foot - top + row.gap));
  }
  return { top: Math.max(0, top), whole };
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
