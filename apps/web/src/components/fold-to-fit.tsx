import { observeResize } from "@opensteer/shared/resizeObserver";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { textWidth } from "./text-width.js";

/** The field moves above the toolbar before its controls give up their labels. */
export const composerFold = {
  field: 0,
  assignee: 1,
  access: 2,
  reasoning: 3,
  reasoningMeter: 4,
  model: 5,
} as const;

/**
 * A line of controls holding one row that fits itself into whatever the
 * line's other controls leave it, by folding marked parts in stages instead of
 * letting the browser squeeze every label at once.
 *
 * A part of the line marked `data-fold="n"` receives `data-folded` once the
 * row (see `FoldRow`) does not fit with only the stages below n folded;
 * CSS decides what folding means for it. A part that also declares
 * `data-fold-floor="px"` is first shortened, to no less than that width, and
 * folded only when shortening is not enough. A part that declares
 * `data-fold-text` keeps room for that text whole on one line, in its own
 * font, until its stage folds; text of more than one line needs the whole
 * line, so it always folds. That room is measured in the same pass as the
 * row, so the row is never fitted against a room that has since changed.
 * Nothing in the row may shrink on its own: overflow has to show at the row's
 * edge, where it is measured, not as one control sliding under the next. The
 * row is one line, always; it never wraps or stacks.
 *
 * The line's width is measured, never the viewport's: the same composer sits
 * in a full window, a split pane and a phone, and only its own width says what
 * fits. Each pass starts unfolded, so the result depends on nothing but the
 * width and the content and cannot oscillate; resize-triggered fitting runs in
 * the next animation frame, so its writes cannot resize another observer's box
 * during notification delivery.
 */
export function FoldToFit({ children, className }: { children: ReactNode; className: string }) {
  const lineRef = useRef<HTMLDivElement | null>(null);
  const gaugeRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const line = lineRef.current;
    const gauge = gaugeRef.current;
    if (!line || !gauge) return;
    const fit = () => fitLine(line);
    fit();
    // The gauge spans the line's width at no height. Stacking and wrapping
    // change the line's height and the row's width, so observing either would
    // feed the observer its own result; the gauge changes only when the width
    // the line is given does.
    const stopResize = observeResize([gauge], fit);
    // A new model name, an account pill arriving, Stop appearing beside Send,
    // a field's words changing: the width is unchanged but what has to fit in
    // it is not. Folding writes no attribute watched here, so it never
    // retriggers itself.
    const mutation = new MutationObserver(fit);
    mutation.observe(line, {
      attributeFilter: ["data-fold-text"],
      characterData: true,
      childList: true,
      subtree: true,
    });
    // Labels measured in a fallback face are the wrong width once the real one
    // arrives. A document that loads no fonts (a test DOM) has none to wait for.
    const fonts = "fonts" in document ? document.fonts : null;
    fonts?.addEventListener("loadingdone", fit);
    return () => {
      stopResize();
      mutation.disconnect();
      fonts?.removeEventListener("loadingdone", fit);
    };
  }, []);

  return (
    <div className={`fold-to-fit ${className}`} ref={lineRef}>
      <span aria-hidden className="fold-to-fit__gauge" ref={gaugeRef} />
      {children}
    </div>
  );
}

/** The row a `FoldToFit` line fits. */
export function FoldRow({ children, className }: { children: ReactNode; className: string }) {
  return (
    <div className={className} data-fold-row="">
      {children}
    </div>
  );
}

/**
 * Folds stage by stage, from nothing folded, until the row fits. A stage with
 * a floor is first shortened, and folded only when shortening is not enough.
 */
function fitLine(line: HTMLElement): void {
  const row = line.querySelector<HTMLElement>("[data-fold-row]");
  if (!row) return;
  const parts = [...line.querySelectorAll<HTMLElement>("[data-fold]")];
  const stages = [...new Set(parts.map(stageOf))].sort((left, right) => left - right);
  const fits = () => row.scrollWidth <= row.clientWidth;
  for (const part of parts) {
    delete part.dataset.folded;
    part.style.removeProperty("max-width");
    const room = textRoom(part);
    if (room === null) part.style.removeProperty("min-width");
    else part.style.minWidth = room === wholeLine ? "100%" : `${room}px`;
  }
  for (const stage of stages) {
    if (fits()) return;
    const members = parts.filter((part) => stageOf(part) === stage);
    for (const part of members) shorten(row, part);
    if (fits()) return;
    for (const part of members) {
      part.style.removeProperty("max-width");
      part.style.removeProperty("min-width");
      part.dataset.folded = "";
    }
  }
}

/**
 * Takes the row's overflow out of one part's width, down to no less than its
 * floor; whether that was enough is the caller's next measurement. The extra
 * pixel absorbs the rounding in the row's integer measurements.
 */
function shorten(row: HTMLElement, part: HTMLElement): void {
  const floor = Number(part.dataset.foldFloor);
  if (!floor) return;
  const width = part.getBoundingClientRect().width;
  if (width <= floor) return;
  const target = Math.floor(width - (row.scrollWidth - row.clientWidth) - 1);
  part.style.maxWidth = `${Math.max(target, floor)}px`;
}

/** The room asked for by text that cannot be one line. */
const wholeLine = Number.POSITIVE_INFINITY;

/**
 * The border-box width that shows a part's `data-fold-text` whole on one line
 * in its own font, `wholeLine` for text of several lines, or null when it
 * declares none or nothing can measure it.
 */
function textRoom(part: HTMLElement): number | null {
  const text = part.dataset.foldText;
  if (!text) return null;
  if (text.includes("\n")) return wholeLine;
  const style = getComputedStyle(part);
  const width = textWidth(style.font, text);
  if (width === null) return null;
  const edges = [
    style.paddingLeft,
    style.paddingRight,
    style.borderLeftWidth,
    style.borderRightWidth,
  ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
  return Math.ceil(width + edges);
}

function stageOf(part: HTMLElement): number {
  return Number(part.dataset.fold);
}
