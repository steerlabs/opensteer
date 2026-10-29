import { Component, type ReactNode, type RefObject } from "react";
import { snapTop } from "./scroll-edges.js";

/** Where each keyed row of a list stands on screen, from the list's top edge. */
export type RowPositions = ReadonlyMap<string, number>;

/** A slide's starting points, and the row it must land in view. */
interface Held {
  readonly positions: RowPositions;
  readonly keep: string | null;
}

const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
const slide = 240;
const enter = 200;

/**
 * Slides a list's rows (`[data-motion-key]`) from where they stood to where a
 * new order puts them, however the order changed: a drop, a keyboard move,
 * another device, a tab opening or closing. Rows are read only when the
 * `signature` (the order) changes, just before React moves them, so the
 * slide starts from where each row really was on screen — mid-slide or
 * mid-drag included. A row that arrives fades in; one that leaves is simply
 * gone.
 *
 * The list snaps its rows to its top edge. From just before React moves its
 * rows until they stand still on a row top it is `data-moving`, so it does
 * not snap (a snapped list follows its row through the new order and the
 * slide), and nothing measures its rows. It lands on a row top before the
 * slide reads where rows end, so the landing is part of the slide; a person's
 * scroll during the slide glides it back onto a row top before it snaps again. While a row is
 * `lifted` its drag owns the list's scroll, and its drop lands the list.
 */
export class RowMotion extends Component<{
  readonly list: RefObject<HTMLElement | null>;
  readonly signature: string;
  readonly lifted: boolean;
  readonly children: ReactNode;
}> {
  #held: Held | null = null;

  /**
   * Takes the next slide's starting points now (a drop clears its own
   * transforms before React renders), and the row it must land in view.
   */
  hold(positions: RowPositions, keep: string | null): void {
    this.#held = { positions, keep };
  }

  override getSnapshotBeforeUpdate(previous: { readonly signature: string }): Held | null {
    const held = this.#held;
    this.#held = null;
    const list = this.props.list.current;
    if (!list) return null;
    const before =
      held ??
      (previous.signature !== this.props.signature
        ? { positions: rowPositions(list), keep: null }
        : null);
    if (before) list.setAttribute("data-moving", "");
    return before;
  }

  override componentDidUpdate(_props: unknown, _state: unknown, before: Held | null): void {
    const list = this.props.list.current;
    if (list && before) slideRows(list, before.positions, before.keep, () => this.props.lifted);
  }

  override render(): ReactNode {
    return this.props.children;
  }
}

export function rowPositions(list: HTMLElement): Map<string, number> {
  const origin = list.getBoundingClientRect().top;
  const positions = new Map<string, number>();
  for (const row of list.querySelectorAll<HTMLElement>(":scope > [data-motion-key]"))
    positions.set(row.dataset.motionKey!, row.getBoundingClientRect().top - origin);
  return positions;
}

const slides = new WeakMap<HTMLElement, object>();

/**
 * Lands the list on a row top with `keep` in view, then animates every keyed
 * row from its position in `before` to where it stands now. The list stays
 * `data-moving` until they stand still on a row top: what measures rows on
 * screen (the whole-row windows beside it) waits until then.
 */
function slideRows(
  list: HTMLElement,
  before: RowPositions,
  keep: string | null,
  lifted: () => boolean,
): void {
  const rows = [...list.querySelectorAll<HTMLElement>(":scope > [data-motion-key]")];
  for (const row of rows)
    for (const animation of row.getAnimations())
      if (animation.id === "row-motion") animation.cancel();
  // A reorder lands on a row top at once, `keep` in view; while a row is lifted, its drag owns the scroll.
  if (!lifted()) {
    const top = snapTop(list, rows.find((row) => row.dataset.motionKey === keep) ?? null);
    if (Math.abs(list.scrollTop - top) > 0.5) list.scrollTop = top;
  }
  const still = () => {
    slides.delete(list);
    list.removeAttribute("data-moving");
  };
  if (!before.size || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return still();
  const after = rowPositions(list);
  const started: Animation[] = [];
  const arrivals = rows.filter((row) => !before.has(row.dataset.motionKey!));
  for (const row of rows) {
    const from = before.get(row.dataset.motionKey!);
    if (from === undefined) {
      // A whole list arriving at once (a sign-in, a reload) appears; a few rows fade in.
      if (arrivals.length > 3) continue;
      started.push(
        row.animate(
          [
            { opacity: 0, transform: "translateY(-4px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: enter, easing, id: "row-motion" },
        ),
      );
      continue;
    }
    const dy = from - after.get(row.dataset.motionKey!)!;
    if (Math.abs(dy) < 0.5) continue;
    started.push(
      row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration: slide,
        easing,
        id: "row-motion",
      }),
    );
  }
  if (!started.length) return still();
  const token = {};
  slides.set(list, token);
  // Unsnapped while rows slide, a person's scroll can end between rows.
  let scrolling = false;
  const scrolled = () => (scrolling = true);
  const ended = () => (scrolling = false);
  list.addEventListener("scroll", scrolled);
  list.addEventListener("scrollend", ended);
  const land = () => {
    if (slides.get(list) !== token) return stop();
    const top = snapTop(list);
    if (lifted() || Math.abs(top - list.scrollTop) <= 0.5) {
      stop();
      return still();
    }
    // It glides onto a row top as a snap would, once the person's scroll has ended.
    list.addEventListener("scrollend", land, { once: true });
    if (!scrolling) list.scrollTo({ top, behavior: "smooth" });
  };
  const stop = () => {
    list.removeEventListener("scroll", scrolled);
    list.removeEventListener("scrollend", ended);
  };
  void Promise.allSettled(started.map((animation) => animation.finished)).then(land);
}
