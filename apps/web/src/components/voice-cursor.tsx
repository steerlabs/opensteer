import type { VoiceTarget } from "@opensteer/client/voice";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { CursorMark, CursorMotion } from "./workspace/cursor-motion.js";
import { opensteerCursorPaint } from "./workspace/task-mark.js";

interface Point {
  readonly x: number;
  readonly y: number;
}

/** The soft glide of a teammate's hand, slower than the agents working in a page. */
const glideStiffness = 9;
/** How long the cursor stays on what it clicked before it fades. */
const lingerMs = 420;
const cursorId = "voice";

/**
 * What names a show's row, so a show finds it with no list to build. A place's
 * key comes from what identifies it, since a resolved show and a sidebar row
 * spell the rest of a destination differently.
 */
export function voiceRowKey(target: VoiceTarget): string {
  if (target.kind === "thread") return target.threadId;
  const place = target.destination;
  if (place.kind === "browser") return `browser:${place.tabId}`;
  if (place.kind === "phone") return `phone:${place.machineId}`;
  if (place.kind === "opensteer-app") return `opensteer-app:${place.appId}`;
  return `app:${place.machineId}:${place.appKey}:${place.computerSessionId}`;
}

/**
 * Where the person would click to open this themselves, if they can see it
 * now. Null skips the cursor. Read before the route changes, since selecting a
 * row can scroll it into view. A desktop tab is a native view over the app, so
 * nothing in this page could cross it to reach the sidebar.
 */
export function voiceCursorAim(target: VoiceTarget): Point | null {
  if (!document.hasFocus()) return null;
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  if (
    target.kind === "place" &&
    target.destination.kind === "browser" &&
    document.documentElement.classList.contains("electron-shell")
  )
    return null;
  const key = voiceRowKey(target);
  const row = [...document.querySelectorAll<HTMLElement>("[data-voice-row]")].find(
    ({ dataset }) => dataset.voiceRow === key,
  );
  if (!row) return null;
  const box = row.getBoundingClientRect();
  const point = { x: box.left + Math.min(28, box.width / 2), y: box.top + box.height / 2 };
  const top = document.elementFromPoint(point.x, point.y);
  return top && row.contains(top) ? point : null;
}

/** Whether the straight glide would pass behind a native page. */
function crossesNativePage(from: Point, to: Point): boolean {
  const stages = [...document.querySelectorAll(".browser-stage[data-native]")].map((stage) =>
    stage.getBoundingClientRect(),
  );
  for (let step = 0; step <= 20; step += 1) {
    const x = from.x + ((to.x - from.x) * step) / 20;
    const y = from.y + ((to.y - from.y) * step) / 20;
    if (stages.some((box) => x > box.left && x < box.right && y > box.top && y < box.bottom))
      return true;
  }
  return false;
}

function setAway(away: boolean): void {
  document.querySelector<HTMLElement>(".voice-island")?.toggleAttribute("data-away", away);
}

export interface VoiceCursor {
  /** The moving cursor, drawn over the whole app while it flies. */
  readonly layer: ReactNode;
  /**
   * Runs `navigate` at once, every time. When `fromCall`, the call's cursor
   * then leaves the pill for the row it opened, if the person can see it go.
   */
  show(target: VoiceTarget, fromCall: boolean, navigate: () => void): void;
}

/**
 * Voice's second cursor. It is decoration on a show that has already happened:
 * nothing waits for it, a second show bends its path, and one it cannot follow
 * fades it out.
 */
export function useVoiceCursor(): VoiceCursor {
  const [motion] = useState(() => new CursorMotion({ stiffness: glideStiffness }));
  const [flight, setFlight] = useState<{ from: Point; to: Point } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef(0);
  const takeoffs = useRef(0);

  const land = useCallback(() => {
    clearTimeout(timer.current);
    const leaving = takeoffs.current;
    // A fade can end after the next takeoff, before that takeoff has reached the cursor.
    motion.leave(cursorId, () => {
      if (takeoffs.current === leaving) setFlight(null);
    });
    setAway(false);
  }, [motion]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(timer.current);
      setAway(false);
    },
    [],
  );

  const show = useCallback<VoiceCursor["show"]>(
    (target, fromCall, navigate) => {
      const aim = fromCall ? voiceCursorAim(target) : null;
      navigate();
      if (!fromCall) return;
      cancelAnimationFrame(frame.current);
      clearTimeout(timer.current);
      // The show may have moved the pill: it starts from where the pill is now.
      frame.current = requestAnimationFrame(() => {
        const box = document.querySelector(".voice-island .voice-cursor")?.getBoundingClientRect();
        const from = box && { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        if (!aim || !from || crossesNativePage(from, aim)) {
          land();
          return;
        }
        takeoffs.current += 1;
        setAway(true);
        setFlight({ from, to: aim });
      });
    },
    [land],
  );

  return {
    layer: flight ? <Flight flight={flight} land={land} motion={motion} timer={timer} /> : null,
    show,
  };
}

/** Mounted with the flight, so the cursor is placed after its element is attached. */
function Flight({
  flight,
  land,
  motion,
  timer,
}: {
  readonly flight: { readonly from: Point; readonly to: Point };
  readonly land: () => void;
  readonly motion: CursorMotion;
  readonly timer: RefObject<ReturnType<typeof setTimeout> | undefined>;
}) {
  const ring = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    // The glide this replaces may have landed in the frame just before this one.
    clearTimeout(timer.current);
    motion.setSpace({
      picture: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
      unit: "pixel",
    });
    motion.place(cursorId, flight.from);
    motion.place(cursorId, flight.to, {
      landed: () => {
        ring.current?.animate?.(
          [
            { opacity: 0.9, scale: 0.4 },
            { opacity: 0, scale: 1.7 },
          ],
          { duration: 460, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
        timer.current = setTimeout(land, lingerMs);
      },
    });
  }, [flight, land, motion, timer]);
  return (
    <div aria-hidden className="cursor-layer voice-glide" ref={motion.layerRef}>
      <span
        className="voice-glide__ring"
        ref={ring}
        style={{ left: flight.to.x, top: flight.to.y }}
      />
      <CursorMark
        color={opensteerCursorPaint}
        icon={null}
        id={cursorId}
        motion={motion}
        title="Opensteer"
      />
    </div>
  );
}
