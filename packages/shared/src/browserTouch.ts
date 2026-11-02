interface Contact {
  readonly x: number;
  readonly y: number;
}
interface TouchStart<Point> extends Contact {
  readonly point: Point;
  /** Page CSS pixels per local screen point, including the viewer's zoom. */
  readonly scale: number;
  readonly drag: boolean;
}
interface TouchOptions<Point> {
  readonly platform: "ios" | "android";
  readonly usable: () => boolean;
  readonly pointer: (
    point: Point,
    action: "down" | "move" | "up",
    button: "left" | "right" | "none",
  ) => boolean;
  readonly wheel: (point: Point, dx: number, dy: number) => boolean;
  readonly cancelPointer: (point: Point) => void;
  readonly contact: (contact: Contact | null) => void;
  readonly onTap?: () => void;
  readonly onScroll?: () => void;
  readonly onDragEnd?: () => void;
  readonly schedule?: (callback: () => void) => () => void;
}

/** Finger-only arbitration. OS wheels and the viewer's two-finger transform have other owners. */
export function createBrowserTouchGesture<Point>(options: TouchOptions<Point>) {
  let held:
    | (TouchStart<Point> & {
        lastPoint: Point;
        lastX: number;
        lastY: number;
        time: number;
        mode: "tap" | "scroll" | "menu" | "drag";
        vx: number;
        vy: number;
      })
    | null = null;
  let blocked = false;
  let generation = 0;
  let longPress: ReturnType<typeof setTimeout> | null = null;
  let stopFrame: (() => void) | null = null;
  const schedule =
    options.schedule ??
    ((callback: () => void) => {
      const id = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(id);
    });
  const stopLongPress = () => {
    if (longPress !== null) clearTimeout(longPress);
    longPress = null;
  };
  const cancel = () => {
    generation++;
    stopLongPress();
    stopFrame?.();
    stopFrame = null;
    const previous = held;
    held = null;
    options.contact(null);
    if (previous?.mode === "drag") {
      options.cancelPointer(previous.lastPoint);
      options.onDragEnd?.();
    }
  };
  const click = (point: Point, button: "left" | "right") => {
    if (!options.pointer(point, "down", button)) return false;
    if (options.pointer(point, "up", button)) return true;
    options.cancelPointer(point);
    return false;
  };
  const fling = (point: Point, vx: number, vy: number) => {
    const speed = Math.hypot(vx, vy);
    if (speed < 0.05) return;
    const bound = Math.min(1, 6 / speed);
    vx *= bound;
    vy *= bound;
    // Exponential, elapsed-time decay: longer iOS glide, shorter Android release.
    // The duration cap deliberately limits interference with another controller.
    const decayMs = options.platform === "ios" ? 500 : 325;
    const epoch = generation;
    const start = performance.now();
    let previous = start;
    const step = () => {
      if (epoch !== generation) return;
      stopFrame = null;
      const now = performance.now();
      const elapsed = Math.min(1200, now - start);
      // A suspended app must never pay back missed animation frames as wheel input.
      if (!options.usable() || now - previous > 80 || now <= previous) return;
      const distance =
        decayMs * (Math.exp(-(previous - start) / decayMs) - Math.exp(-elapsed / decayMs));
      if (!options.wheel(point, vx * distance, vy * distance)) return;
      previous = now;
      if (elapsed < 1200 && speed * bound * Math.exp(-elapsed / decayMs) >= 0.02)
        stopFrame = schedule(step);
    };
    stopFrame = schedule(step);
  };
  return {
    cancel,
    /** A second contact suppresses one-finger input until every contact has lifted. */
    contacts(count: number) {
      if (count > 1) {
        cancel();
        blocked = true;
      } else if (count === 0) blocked = false;
    },
    start(start: TouchStart<Point>) {
      cancel();
      if (blocked || !options.usable()) return;
      held = {
        ...start,
        lastPoint: start.point,
        lastX: start.x,
        lastY: start.y,
        time: performance.now(),
        mode: start.drag ? "drag" : "tap",
        vx: 0,
        vy: 0,
      };
      options.contact({ x: start.x, y: start.y });
      if (start.drag) {
        if (!options.pointer(start.point, "down", "left")) cancel();
      } else {
        longPress = setTimeout(() => {
          longPress = null;
          if (!held || held.mode !== "tap") return;
          if (!options.usable()) {
            cancel();
            return;
          }
          held.mode = "menu";
          options.contact(null);
          // The runtime reports fallback facts only when the site allows contextmenu.
          click(held.point, "right");
        }, 500);
      }
    },
    move(next: Contact & { readonly point: Point }) {
      const current = held;
      if (!current) return;
      if (!options.usable()) {
        cancel();
        return;
      }
      if (current.mode === "menu") return;
      if (current.mode === "drag") {
        current.lastPoint = next.point;
        if (!options.pointer(next.point, "move", "none")) cancel();
        return;
      }
      if (current.mode === "tap") {
        if (Math.hypot(next.x - current.x, next.y - current.y) <= 8) return;
        current.mode = "scroll";
        stopLongPress();
        options.contact(null);
        options.onScroll?.();
      }
      const dx = (current.lastX - next.x) * current.scale;
      const dy = (current.lastY - next.y) * current.scale;
      const now = performance.now();
      const dt = now - current.time;
      if (dt > 0) {
        current.vx = dt <= 80 ? dx / dt : 0;
        current.vy = dt <= 80 ? dy / dt : 0;
      }
      current.time = now;
      current.lastX = next.x;
      current.lastY = next.y;
      if (
        !options.wheel(
          current.point,
          Math.max(-100000, Math.min(100000, dx)),
          Math.max(-100000, Math.min(100000, dy)),
        )
      )
        cancel();
    },
    release() {
      const current = held;
      held = null;
      stopLongPress();
      options.contact(null);
      if (!current) return;
      if (!options.usable()) {
        if (current.mode === "drag") {
          options.cancelPointer(current.lastPoint);
          options.onDragEnd?.();
        }
        return;
      }
      if (current.mode === "tap" && click(current.point, "left")) options.onTap?.();
      else if (current.mode === "drag") {
        if (!options.pointer(current.lastPoint, "up", "left"))
          options.cancelPointer(current.lastPoint);
        options.onDragEnd?.();
      } else if (current.mode === "scroll" && performance.now() - current.time <= 80)
        fling(current.point, current.vx, current.vy);
    },
  };
}
