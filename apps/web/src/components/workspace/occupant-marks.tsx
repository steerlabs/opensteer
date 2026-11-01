import { Popover } from "../popover.js";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { threadInDirectory, threadMark, type PlaceOccupant } from "@opensteer/client/host";
import {
  TaskMark,
  TaskBadge,
  TaskState,
  ChatOrb,
  WorkingRing,
  taskStateWords,
  type TaskMarkSize,
} from "./task-mark.js";
import type { TaskDirectory } from "./task-directory.js";

/** Marks on a place: who holds or acts there, newest first, at most three and "+N". */
const shownMarks = 3;

/**
 * The tasks in a place, each its own button: pressing one shows that place
 * and that task's conversation together. Chat wears its orb.
 */
export const OccupantMarks = memo(function OccupantMarks({
  className,
  directory,
  fallbackFocus,
  onOpen,
  occupants,
  placeTitle,
  size,
}: {
  readonly className?: string;
  readonly directory: TaskDirectory;
  /** Where focus goes if a focused mark disappears with its task. */
  readonly fallbackFocus: () => HTMLElement | null;
  readonly onOpen: (threadId: string) => void;
  readonly occupants: readonly PlaceOccupant[];
  readonly placeTitle: string;
  readonly size: TaskMarkSize;
}) {
  const listed = occupants;
  if (listed.length === 0) return null;
  const shown = listed.slice(0, shownMarks);
  const more = listed.slice(shownMarks);
  return (
    <span className={["occupant-marks", className ?? ""].filter(Boolean).join(" ")}>
      {shown.map((occupant) => (
        <OccupantMark
          acting={occupant.acting}
          directory={directory}
          fallbackFocus={fallbackFocus}
          home={occupant.home}
          key={occupant.threadId}
          onOpen={onOpen}
          placeTitle={placeTitle}
          size={size}
          threadId={occupant.threadId}
        />
      ))}
      {more.length > 0 ? (
        <OccupantOverflow
          directory={directory}
          fallbackFocus={fallbackFocus}
          occupants={more}
          placeTitle={placeTitle}
          onOpen={onOpen}
        />
      ) : null}
    </span>
  );
});

function OccupantOverflow({
  directory,
  fallbackFocus,
  occupants,
  placeTitle,
  onOpen,
}: {
  readonly directory: TaskDirectory;
  readonly fallbackFocus: () => HTMLElement | null;
  readonly occupants: readonly PlaceOccupant[];
  readonly placeTitle: string;
  readonly onOpen: (threadId: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const ref = useRef<HTMLButtonElement | null>(null);
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;
  useFocusRescue(ref, fallback);
  return (
    <>
      <button
        aria-label={`${occupants.length} more tasks at ${placeTitle}`}
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        className="occupant-marks__more"
        ref={ref}
        type="button"
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        +{occupants.length}
      </button>
      {anchor ? (
        <Popover anchor={anchor} label={`Tasks at ${placeTitle}`} onClose={() => setAnchor(null)}>
          {occupants.map((occupant) => {
            const name = occupant.home
              ? "Opensteer"
              : (threadInDirectory(occupant.threadId, directory.snapshot)?.title ?? "Task");
            const state = directory.rows.get(occupant.threadId)?.tone ?? "working";
            return (
              <button
                key={occupant.threadId}
                className="picker__row"
                role="menuitem"
                data-thread-id={occupant.threadId}
                type="button"
                aria-label={`Open ${name} at ${placeTitle} — ${taskStateWords(state)}`}
                onClick={() => {
                  setAnchor(null);
                  onOpen(occupant.threadId);
                }}
              >
                {occupant.home ? (
                  <ChatOrb size={16} />
                ) : (
                  <TaskMark size={16} mark={threadMark(occupant.threadId, directory.snapshot)} />
                )}
                <span className="picker__label">{name}</span>
                <TaskState state={state} />
              </button>
            );
          })}
        </Popover>
      ) : null}
    </>
  );
}

function OccupantMark({
  acting,
  directory,
  fallbackFocus,
  home,
  onOpen,
  placeTitle,
  size,
  threadId,
}: {
  readonly directory: TaskDirectory;
  readonly fallbackFocus: () => HTMLElement | null;
  readonly acting: boolean;
  readonly home: boolean;
  readonly onOpen: (threadId: string) => void;
  readonly placeTitle: string;
  readonly size: TaskMarkSize;
  readonly threadId: string;
}) {
  const [lingering, setLingering] = useState(acting);
  useEffect(() => {
    if (acting) {
      setLingering(true);
      return;
    }
    const timer = window.setTimeout(() => setLingering(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [acting]);
  const row = directory.rows.get(threadId);
  const name = home
    ? "Opensteer"
    : (threadInDirectory(threadId, directory.snapshot)?.title ?? "Task");
  const state = row?.tone ?? "working";
  const words = taskStateWords(state);
  const mark = threadMark(threadId, directory.snapshot);
  const ref = useRef<HTMLButtonElement | null>(null);
  const fallbackRef = useRef(fallbackFocus);
  fallbackRef.current = fallbackFocus;
  useFocusRescue(ref, fallbackRef);
  return (
    <button
      aria-label={`Open ${name} at ${placeTitle}${words ? ` — ${words}` : ""}`}
      className="occupant-mark"
      data-thread-id={threadId}
      onClick={() => onOpen(threadId)}
      ref={ref}
      title={name}
      type="button"
    >
      <span className="occupant-mark__mark">
        {home ? <ChatOrb size={size} /> : <TaskMark size={size} mark={mark} />}
        {acting || lingering ? <WorkingRing mark={home ? null : mark} settling={!acting} /> : null}
        <TaskBadge state={state} />
      </span>
    </button>
  );
}

/**
 * A control, or a row of them, that leaves while it holds focus hands focus to
 * a stable neighbour, never to the page body: background events remove marks
 * and rows.
 */
export function useFocusRescue(
  ref: { readonly current: HTMLElement | null },
  fallback: { readonly current: () => HTMLElement | null },
) {
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (!element?.contains(document.activeElement)) return;
      const rescue = fallback.current;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active !== null && active !== document.body && active.isConnected) return;
        const target = rescue();
        if (target?.isConnected) target.focus();
      });
    };
  }, [fallback, ref]);
}
