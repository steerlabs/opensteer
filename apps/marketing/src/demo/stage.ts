import { clamp, find, reducedMotion, restart } from "../dom.js";
import { CROP, PHONE_ONLY, STAGE_SIZE } from "./geometry.js";

export type Side = "L" | "R" | "T" | "B";
export type Point = readonly [number, number];

const { width: WIDTH, height: HEIGHT } = STAGE_SIZE;

export const STAGE = `<div class="scene-wrap"><div class="scene" data-view="list">
  <div class="view">
    <div class="floor" aria-hidden="true"></div>
    <!--mac-->
    <svg class="beam" viewBox="0 0 ${WIDTH} ${HEIGHT}" aria-hidden="true"><defs><linearGradient id="beam-fade" gradientUnits="userSpaceOnUse" x1="350" y1="0" x2="780" y2="0"><stop offset="0" stop-opacity="0.36"/><stop offset="1" stop-opacity="0.03"/></linearGradient></defs><polygon fill="url(#beam-fade)" points="0,0 0,0 0,0"/></svg>
    <span class="spark"></span><span class="spark-ring"></span>
    <!--phone-->
  </div>
  <div class="notes" aria-hidden="true"></div>
</div></div>`;

export interface Stage {
  readonly scene: HTMLElement;
  /** The stage is cropped to the phone. */
  readonly narrow: boolean;
  /** A point on an element, in stage units. */
  pos(el: Element, fx?: number, fy?: number): Point;
  /** One short callout pinned to a point. Showing one retires the others. */
  label(text: string, anchor: Element, fx: number, fy: number, side: Side, gap: number): Element;
  retire(label: Element): void;
  clearLabels(): void;
  /** A spark that carries a decision from one element to another. */
  spark(from: Element, to: Element): void;
  /** Ties the phone's live view to the region of the Mac it shows, for as long as `on` holds. */
  runBeam(on: boolean): void;
}

export interface StageParts {
  /** The phone's live view and the region of the Mac it frames. */
  readonly live: Element;
  readonly region: Element;
  /** Runs `run` after `ms` of unpaused time. */
  later(ms: number, run: () => void): void;
}

export function createStage(wrap: HTMLElement, parts: StageParts): Stage {
  const scene = find(wrap, ".scene");
  const notes = find(wrap, ".notes");
  const beam = find<SVGPolygonElement>(scene, ".beam polygon");
  const narrowQuery = matchMedia(PHONE_ONLY);
  let scale = 1;
  let narrow = false;
  let beamWanted = false;
  let frame = 0;

  const drawBeam = (): void => {
    frame = 0;
    if (!beamWanted || narrow) return;
    const origin = scene.getBoundingClientRect();
    const corner = (el: Element, fx: number, fy: number): string => {
      const at = el.getBoundingClientRect();
      const x = (at.left - origin.left + at.width * fx) / scale;
      const y = (at.top - origin.top + at.height * fy) / scale;
      return `${x},${y}`;
    };
    const { live, region } = parts;
    const corners = [
      corner(live, 1, 0.04),
      corner(region, 0, 0),
      corner(region, 0, 1),
      corner(live, 1, 0.96),
    ];
    beam.setAttribute("points", corners.join(" "));
    frame = requestAnimationFrame(drawBeam);
  };
  const syncBeam = (): void => {
    if (beamWanted && !narrow && !frame) frame = requestAnimationFrame(drawBeam);
  };
  const fit = (): void => {
    narrow = narrowQuery.matches;
    scale = wrap.clientWidth / (narrow ? CROP.width : WIDTH);
    scene.style.transform = narrow
      ? `scale(${scale}) translate(${-CROP.x}px, 0)`
      : `scale(${scale})`;
    syncBeam();
  };
  new ResizeObserver(fit).observe(wrap);
  fit();

  const pos = (el: Element, fx = 0.5, fy = 0.5): Point => {
    const at = el.getBoundingClientRect();
    const origin = scene.getBoundingClientRect();
    return [
      (at.left - origin.left + at.width * fx) / scale,
      (at.top - origin.top + at.height * fy) / scale,
    ];
  };
  const retire = (label: Element): void => {
    label.classList.add("is-off");
    parts.later(500, () => label.remove());
  };

  return {
    scene,
    get narrow() {
      return narrow;
    },
    pos,
    retire,
    clearLabels() {
      notes.replaceChildren();
    },
    label(text, anchor, fx, fy, side, gap) {
      notes.querySelectorAll(".note").forEach(retire);
      const note = document.createElement("div");
      note.className = narrow ? "note note--caption" : "note";
      note.innerHTML = `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}"><polyline pathLength="1"/></svg><i class="note__dot"></i><span class="note__label"></span>`;
      const box = find(note, ".note__label");
      box.textContent = text;
      notes.appendChild(note);
      const width = box.offsetWidth;
      const height = box.offsetHeight;
      if (narrow) {
        box.style.left = `${CROP.x + (CROP.width - width) / 2}px`;
        box.style.top = "6px";
      } else {
        const [x, y] = pos(anchor, fx, fy);
        let left = x - width / 2;
        let top = y - height / 2;
        if (side === "L") left = x - gap - width;
        else if (side === "R") left = x + gap;
        else if (side === "T") top = y - gap - height;
        else top = y + gap;
        left = clamp(left, 8, WIDTH - 8 - width);
        top = clamp(top, 6, HEIGHT - 8 - height);
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        const dot = find(note, ".note__dot");
        dot.style.left = `${x}px`;
        dot.style.top = `${y}px`;
        find<SVGPolylineElement>(note, "polyline").setAttribute(
          "points",
          `${x},${y} ${clamp(x, left, left + width)},${clamp(y, top, top + height)}`,
        );
      }
      void note.offsetWidth;
      note.classList.add("is-on");
      return note;
    },
    spark(from, to) {
      if (reducedMotion || narrow) return;
      const [x0, y0] = pos(from);
      const [x1, y1] = pos(to);
      const cx = (x0 + x1) / 2;
      const cy = Math.min(y0, y1) - 140;
      const frames = Array.from({ length: 25 }, (_, index) => {
        const t = index / 24;
        const u = 1 - t;
        const x = u * u * x0 + 2 * u * t * cx + t * t * x1;
        const y = u * u * y0 + 2 * u * t * cy + t * t * y1;
        return {
          transform: `translate(${x}px, ${y}px) scale(${1 + Math.sin(t * Math.PI) * 0.8})`,
          opacity: index === 0 || index === 24 ? 0 : 1,
        };
      });
      find(scene, ".spark").animate(frames, {
        duration: 760,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      });
      const ring = find(scene, ".spark-ring");
      ring.style.left = `${x1}px`;
      ring.style.top = `${y1}px`;
      parts.later(700, () => restart(ring, "is-on"));
    },
    runBeam(on) {
      beamWanted = on && !reducedMotion;
      syncBeam();
    },
  };
}
