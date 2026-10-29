import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

export interface PaneSizeRange {
  defaultValue: number;
  max: number;
  min: number;
  step: number;
}

export type PaneSide = "left" | "right";

export function clampPaneSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function paneSizeFromPointer({
  clientX,
  max,
  min,
  side,
  startSize,
  startX,
}: {
  clientX: number;
  max: number;
  min: number;
  side: PaneSide;
  startSize: number;
  startX: number;
}): number {
  const direction = side === "left" ? 1 : -1;
  return clampPaneSize(startSize + (clientX - startX) * direction, min, max);
}

export function paneSizeFromKey({
  key,
  max,
  min,
  side,
  step,
  value,
}: {
  key: string;
  max: number;
  min: number;
  side: PaneSide;
  step: number;
  value: number;
}): number | null {
  if (key === "Home") return min;
  if (key === "End") return max;
  if (key === "ArrowLeft") {
    return clampPaneSize(value + (side === "right" ? step : -step), min, max);
  }
  if (key === "ArrowRight") {
    return clampPaneSize(value + (side === "left" ? step : -step), min, max);
  }
  return null;
}

export function readPersistedPaneSize(
  key: string,
  range: PaneSizeRange,
  storage: Pick<Storage, "getItem"> = localStorage,
): number {
  const stored = Number(storage.getItem(key));
  return Number.isFinite(stored) && stored > 0
    ? clampPaneSize(stored, range.min, range.max)
    : range.defaultValue;
}

/**
 * A pane's width: `update` follows a gesture as it moves, `commit` keeps the
 * width it ended at — once per gesture, never on every pointer move.
 */
export function usePersistedPaneSize(key: string, range: PaneSizeRange) {
  const [value, setValue] = useState(() => readPersistedPaneSize(key, range));
  const update = useCallback(
    (nextValue: number) => setValue(clampPaneSize(nextValue, range.min, range.max)),
    [range.max, range.min],
  );
  const commit = useCallback(
    (nextValue: number) => {
      const next = clampPaneSize(nextValue, range.min, range.max);
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // A preference only: the width still applies for this window.
      }
    },
    [key, range.max, range.min],
  );
  return [value, update, commit] as const;
}

export function PaneResizeHandle({
  ariaControls,
  ariaLabel,
  max,
  min,
  onCommit,
  onDragChange,
  onResize,
  range,
  side,
  value,
}: {
  ariaControls: string;
  ariaLabel: string;
  max: number;
  min: number;
  /** The width a gesture ended at: a release, a key, a double-click. */
  onCommit: (value: number) => void;
  /** A drag began or ended, for what follows the pane's size to slow down meanwhile. */
  onDragChange?: ((dragging: boolean) => void) | undefined;
  onResize: (value: number) => void;
  range: PaneSizeRange;
  side: PaneSide;
  value: number;
}) {
  const handleRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startSize: number;
    startX: number;
    latest: number;
    frame: number | null;
  } | null>(null);
  const callbacks = useRef({ onCommit, onDragChange, onResize });
  callbacks.current = { onCommit, onDragChange, onResize };

  const finishResize = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    handleRef.current?.removeAttribute("data-resizing");
    document.documentElement.classList.remove("is-resizing-pane");
    if (!current) return;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    callbacks.current.onCommit(current.latest);
    callbacks.current.onDragChange?.(false);
  }, []);

  useEffect(() => finishResize, [finishResize]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = {
      frame: null,
      latest: value,
      pointerId: event.pointerId,
      startSize: value,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.setAttribute("data-resizing", "true");
    document.documentElement.classList.add("is-resizing-pane");
    onDragChange?.(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.latest = paneSizeFromPointer({
      clientX: event.clientX,
      max,
      min,
      side,
      startSize: current.startSize,
      startX: current.startX,
    });
    // The pane follows the pointer at most once a frame.
    if (current.frame !== null) return;
    current.frame = requestAnimationFrame(() => {
      current.frame = null;
      if (drag.current === current) callbacks.current.onResize(current.latest);
    });
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishResize();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = paneSizeFromKey({
      key: event.key,
      max,
      min,
      side,
      step: range.step,
      value,
    });
    if (next === null) return;
    event.preventDefault();
    onCommit(next);
  };

  return (
    <div
      aria-controls={ariaControls}
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      className="pane-resize-handle"
      data-pane-side={side}
      onDoubleClick={() => onCommit(clampPaneSize(range.defaultValue, min, max))}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={finishResize}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      ref={handleRef}
      role="separator"
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
    />
  );
}
