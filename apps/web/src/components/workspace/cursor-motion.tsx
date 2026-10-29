import type { WorkspaceIconName } from "@opensteer/core";
import { WorkspaceIconGlyph } from "../workspace-orb.js";
import { memo, useCallback, type CSSProperties } from "react";

/**
 * Agents' cursors in motion. React renders each cursor's static markup once
 * and hands its element here; this module alone writes a cursor's transform
 * and state classes, so a render never moves a cursor or wipes its state, and
 * motion never renders. A layer's one frame loop runs only while one of its
 * cursors moves, and only transform and opacity ever change.
 */

/** Critically damped at this stiffness (rad/s): a quick approach that never overshoots. */
const omega = 17;
/** The longest step one frame takes, so a stalled tab does not throw its cursors. */
const maxStepSeconds = 1 / 30;
/** Closer than this (px) and slower than this (px/s), a cursor is at rest. */
const restDistance = 0.25;
const restSpeed = 6;
/** A cursor's name stays up this long after it comes to rest. */
const cursorLabelQuietMs = 2_600;
/** How long a removed cursor fades before its element goes. */
export const cursorFadeMs = 180;
/** Under reduced motion, how long a cursor is gone between its old and new point. */
const swapMs = 90;
/** The name's offset from the tip; it must match `.acur__name`. */
const labelOffset = { x: 11, y: 15 };
/** Where a cursor with no known point waits, as fractions of the picture. */
export const neutralCursorPoint = { x: 0.5, y: 0.3 } as const;

interface CursorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The picture in layer pixels, which a name never leaves, and what a point
 * is: a `fraction` of the picture, or a `pixel` of the layer.
 */
interface CursorSpace {
  readonly picture: CursorRect;
  readonly unit: "fraction" | "pixel";
}

/** A point; `hidden` to hide it; `null` to keep it where it is, or new at the neutral spot. */
type CursorTarget = { readonly x: number; readonly y: number } | "hidden" | null;

interface Cursor {
  readonly element: HTMLElement;
  readonly label: HTMLElement | null;
  labelText: string | null;
  labelWidth: number;
  labelHeight: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  placed: boolean;
  moving: boolean;
  swapping: boolean;
  flipX: boolean;
  flipY: boolean;
  leaving: boolean;
  quietTimer: ReturnType<typeof setTimeout> | undefined;
  swapTimer: ReturnType<typeof setTimeout> | undefined;
  fadeTimer: ReturnType<typeof setTimeout> | undefined;
}

export class CursorMotion {
  readonly #cursors = new Map<string, Cursor>();
  #layer: HTMLElement | null = null;
  #space: CursorSpace = { picture: { left: 0, top: 0, width: 0, height: 0 }, unit: "pixel" };
  #reduced = false;
  #frame: number | null = null;
  #last = 0;

  /** The layer says whether its loop runs, so a resting layer can be seen to ask for no frames. */
  readonly layerRef = (layer: HTMLElement | null): void => {
    this.#layer = layer;
    if (layer) layer.dataset.animating = String(this.#frame !== null);
  };

  /**
   * A cursor's timers end when its element goes, and the loop ends on the
   * next frame with nothing to move: a layer has nothing else to stop, so an
   * effect that re-runs never strands a fade or a quiet name.
   */
  attach(id: string, element: HTMLElement | null): void {
    const existing = this.#cursors.get(id);
    if (existing?.element === element) return;
    if (existing) this.#forget(id, existing);
    if (!element) return;
    element.addEventListener("animationend", () => element.classList.remove("acur--arrive"));
    this.#cursors.set(id, {
      element,
      label: element.querySelector<HTMLElement>(".acur__name"),
      labelText: null,
      labelWidth: 0,
      labelHeight: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      tx: 0,
      ty: 0,
      placed: false,
      moving: false,
      swapping: false,
      flipX: false,
      flipY: false,
      leaving: false,
      quietTimer: undefined,
      swapTimer: undefined,
      fadeTimer: undefined,
    });
  }

  setReducedMotion(reduced: boolean): void {
    if (reduced === this.#reduced) return;
    this.#reduced = reduced;
    if (!reduced) return;
    this.#halt();
    for (const cursor of this.#cursors.values())
      if (cursor.moving) {
        this.#arrive(cursor);
        this.#quietSoon(cursor);
      }
  }

  /** A new space redraws every cursor at once: a resize never glides. */
  setSpace(space: CursorSpace): void {
    const { picture, unit } = this.#space;
    if (
      unit === space.unit &&
      picture.left === space.picture.left &&
      picture.top === space.picture.top &&
      picture.width === space.picture.width &&
      picture.height === space.picture.height
    )
      return;
    this.#space = space;
    for (const cursor of this.#cursors.values()) if (cursor.placed) this.#render(cursor);
  }

  /**
   * `snap` moves a cursor without gliding. `arrive: false` shows a new cursor
   * without its arrival, for cursors that were there before this layer was.
   */
  place(
    id: string,
    target: CursorTarget,
    { arrive = true, snap = false }: { readonly arrive?: boolean; readonly snap?: boolean } = {},
  ): void {
    const cursor = this.#cursors.get(id);
    if (!cursor) return;
    this.#measure(cursor);
    if (cursor.leaving) {
      cursor.leaving = false;
      clearTimeout(cursor.fadeTimer);
      cursor.element.classList.remove("acur--leaving");
    }
    if (target === "hidden") {
      this.#hide(cursor);
      return;
    }
    if (target === null && cursor.placed) return;
    const point = target ?? (this.#space.unit === "fraction" ? neutralCursorPoint : null);
    if (!point) return;
    if (!cursor.placed) {
      this.#appear(cursor, point, arrive);
      return;
    }
    if (snap) {
      const settling = cursor.moving || cursor.swapping;
      cursor.tx = point.x;
      cursor.ty = point.y;
      this.#arrive(cursor);
      if (settling) this.#quietSoon(cursor);
      return;
    }
    if (point.x === cursor.tx && point.y === cursor.ty) {
      if (cursor.moving) this.#wake();
      return;
    }
    cursor.tx = point.x;
    cursor.ty = point.y;
    this.#speak(cursor);
    if (this.#reduced) this.#swap(cursor);
    else {
      cursor.moving = true;
      this.#wake();
    }
  }

  /**
   * Fades a cursor out; `done` runs when it has gone. Its motion carries on
   * under the fade, so a cursor that comes back in time is where it would be.
   */
  leave(id: string, done?: () => void): void {
    const cursor = this.#cursors.get(id);
    if (!cursor || !cursor.placed) {
      done?.();
      return;
    }
    if (cursor.leaving) return;
    cursor.leaving = true;
    cursor.element.classList.add("acur--leaving");
    cursor.fadeTimer = setTimeout(() => done?.(), cursorFadeMs);
  }

  #forget(id: string, cursor: Cursor): void {
    clearTimeout(cursor.quietTimer);
    clearTimeout(cursor.swapTimer);
    clearTimeout(cursor.fadeTimer);
    this.#cursors.delete(id);
  }

  #measure(cursor: Cursor): void {
    const text = cursor.label?.textContent ?? "";
    // A name measured before the page laid it out, or renamed since, is measured again.
    if (text === cursor.labelText && (cursor.labelWidth > 0 || !text)) return;
    cursor.labelText = text;
    cursor.labelWidth = cursor.label?.offsetWidth ?? 0;
    cursor.labelHeight = cursor.label?.offsetHeight ?? 0;
  }

  #appear(cursor: Cursor, point: { readonly x: number; readonly y: number }, arrive: boolean) {
    cursor.tx = point.x;
    cursor.ty = point.y;
    this.#arrive(cursor);
    cursor.placed = true;
    cursor.element.classList.add("acur--on");
    if (arrive && !this.#reduced) cursor.element.classList.add("acur--arrive");
    this.#quietSoon(cursor);
  }

  /** Puts a cursor at its target, at rest. */
  #arrive(cursor: Cursor): void {
    cursor.x = cursor.tx;
    cursor.y = cursor.ty;
    cursor.vx = 0;
    cursor.vy = 0;
    cursor.moving = false;
    cursor.swapping = false;
    clearTimeout(cursor.swapTimer);
    cursor.element.classList.remove("acur--swap");
    this.#render(cursor);
  }

  #hide(cursor: Cursor): void {
    if (!cursor.placed) return;
    cursor.placed = false;
    cursor.moving = false;
    cursor.swapping = false;
    clearTimeout(cursor.swapTimer);
    clearTimeout(cursor.quietTimer);
    cursor.element.classList.remove("acur--on", "acur--swap", "acur--arrive");
  }

  /** Reduced motion: gone from the old point, back at the new one. */
  #swap(cursor: Cursor): void {
    cursor.swapping = true;
    cursor.element.classList.add("acur--swap");
    clearTimeout(cursor.swapTimer);
    cursor.swapTimer = setTimeout(() => {
      this.#arrive(cursor);
      this.#quietSoon(cursor);
    }, swapMs);
  }

  /** The name shows while a cursor moves. */
  #speak(cursor: Cursor): void {
    clearTimeout(cursor.quietTimer);
    cursor.element.classList.remove("acur--quiet");
  }

  #quietSoon(cursor: Cursor): void {
    this.#speak(cursor);
    cursor.quietTimer = setTimeout(
      () => cursor.element.classList.add("acur--quiet"),
      cursorLabelQuietMs,
    );
  }

  #render(cursor: Cursor): void {
    const { picture, unit } = this.#space;
    const x = unit === "fraction" ? picture.left + cursor.x * picture.width : cursor.x;
    const y = unit === "fraction" ? picture.top + cursor.y * picture.height : cursor.y;
    cursor.element.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    // The name turns back toward the picture where it would cross its right or bottom edge.
    const flipX = x + labelOffset.x + cursor.labelWidth > picture.left + picture.width;
    const flipY = y + labelOffset.y + cursor.labelHeight > picture.top + picture.height;
    if (flipX !== cursor.flipX) cursor.element.classList.toggle("acur--flip-x", flipX);
    if (flipY !== cursor.flipY) cursor.element.classList.toggle("acur--flip-y", flipY);
    cursor.flipX = flipX;
    cursor.flipY = flipY;
  }

  #wake(): void {
    if (this.#frame !== null || this.#reduced) return;
    this.#last = performance.now();
    this.#frame = requestAnimationFrame(this.#tick);
    if (this.#layer) this.#layer.dataset.animating = "true";
  }

  #halt(): void {
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    if (this.#layer) this.#layer.dataset.animating = "false";
  }

  readonly #tick = (): void => {
    const now = performance.now();
    const dt = Math.min(maxStepSeconds, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    const { picture, unit } = this.#space;
    const scaleX = unit === "fraction" ? picture.width : 1;
    const scaleY = unit === "fraction" ? picture.height : 1;
    let moving = false;
    for (const cursor of this.#cursors.values()) {
      if (!cursor.moving) continue;
      const [ex, vx] = spring(cursor.x - cursor.tx, cursor.vx, dt);
      const [ey, vy] = spring(cursor.y - cursor.ty, cursor.vy, dt);
      cursor.x = cursor.tx + ex;
      cursor.y = cursor.ty + ey;
      cursor.vx = vx;
      cursor.vy = vy;
      if (
        Math.abs(ex * scaleX) < restDistance &&
        Math.abs(ey * scaleY) < restDistance &&
        Math.hypot(vx * scaleX, vy * scaleY) < restSpeed
      ) {
        this.#arrive(cursor);
        this.#quietSoon(cursor);
      } else {
        moving = true;
        this.#render(cursor);
      }
    }
    this.#frame = null;
    if (moving) this.#frame = requestAnimationFrame(this.#tick);
    else if (this.#layer) this.#layer.dataset.animating = "false";
  };
}

/**
 * One step of a critically damped spring, solved exactly rather than
 * integrated, so no frame rate makes it overshoot from rest; a new target
 * keeps the velocity, which bends the path instead of restarting it.
 */
function spring(offset: number, velocity: number, dt: number): readonly [number, number] {
  const decay = Math.exp(-omega * dt);
  const drift = velocity + omega * offset;
  return [(offset + drift * dt) * decay, (velocity - omega * drift * dt) * decay];
}

/** One agent's cursor: a small arrow in its colour and its name, nothing else. */
export const CursorMark = memo(function CursorMark({
  color,
  icon,
  id,
  motion,
  title,
}: {
  readonly color: string;
  readonly icon: WorkspaceIconName | null;
  readonly id: string;
  readonly motion: CursorMotion;
  readonly title: string;
}) {
  const ref = useCallback(
    (element: HTMLDivElement | null) => motion.attach(id, element),
    [id, motion],
  );
  return (
    <div
      className="acur"
      data-thread-id={id}
      ref={ref}
      style={{ "--acur-color": color } as CSSProperties}
    >
      <svg className="acur__ptr" viewBox="0 0 16 18">
        <path
          d="M2 2 2 15.2 5.6 11.9 8.1 17.3 10.4 16.3 8 11 13 10.7Z"
          fill="currentColor"
          stroke="#fff"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      </svg>
      <span className="acur__name">
        {icon ? <WorkspaceIconGlyph icon={icon} /> : null}
        <span>{title}</span>
      </span>
    </div>
  );
});
