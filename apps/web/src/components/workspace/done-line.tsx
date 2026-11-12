import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import {
  seenThroughOf,
  taskMark,
  taskMarkQuiet,
  type HostClient,
  type TaskRow,
} from "@opensteer/client/host";
import type { QuietTaskDays } from "@opensteer/core";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { useToast } from "../toast.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { TaskMark } from "./task-mark.js";

/** At most this many tasks move back at once, so a long list does not flood a slow link. */
const moveBackConcurrency = 4;

const seenKey = (scope: string) => `opensteer.quiet-done-seen:${scope}`;

/**
 * The newest quiet move this browser has shown its reader, per Deployment and
 * person, and a way to advance it past rows just shown. A convenience only: a
 * blocked store shows the notice again, never loses a task.
 */
export function useQuietSeen(
  scope: string | null,
): readonly [string | null, (rows: readonly TaskRow[]) => void] {
  const [held, setHeld] = useState(() => ({ scope, seen: readSeen(scope) }));
  // Read in render, not after it, so a new viewer never flashes the last one's notice.
  if (held.scope !== scope) setHeld({ scope, seen: readSeen(scope) });
  const markSeen = useCallback(
    (rows: readonly TaskRow[]) =>
      setHeld((previous) => {
        const seen = seenThroughOf(rows, previous.seen);
        if (seen === previous.seen || !previous.scope || !seen) return previous;
        try {
          localStorage.setItem(seenKey(previous.scope), seen);
        } catch {
          // Not saved, the notice comes back once; nothing else depends on it.
        }
        return { ...previous, seen };
      }),
    [],
  );
  return [held.scope === scope ? held.seen : readSeen(scope), markSeen];
}

function readSeen(scope: string | null): string | null {
  if (!scope) return null;
  try {
    return localStorage.getItem(seenKey(scope));
  } catch {
    return null;
  }
}

/**
 * The last row of Tasks: Done and how many it holds. It opens Done in place
 * of Tasks. When the Host has just moved quiet tasks there, a "+N" beside it
 * opens a card that names them and moves them back.
 */
export function DoneLine({
  active,
  count,
  hostClient,
  lineRef,
  moved,
  onOpen,
  onOpenTask,
  onSeen,
  quietTaskDays,
}: {
  /** The open conversation is one of the Done tasks. */
  readonly active: boolean;
  readonly count: number;
  readonly hostClient: HostClient;
  readonly lineRef: Ref<HTMLLIElement>;
  readonly moved: readonly TaskRow[];
  readonly onOpen: () => void;
  readonly onOpenTask: (threadId: string) => void;
  readonly onSeen: (rows: readonly TaskRow[]) => void;
  readonly quietTaskDays: QuietTaskDays | null;
}) {
  const chip = useRef<HTMLButtonElement | null>(null);
  const main = useRef<HTMLButtonElement | null>(null);
  // What the card opened with, and what is still in Done of it, so it keeps
  // naming them while they move back and closes once none is left.
  const [card, setCard] = useState<{
    readonly opened: readonly TaskRow[];
    readonly left: readonly TaskRow[];
  } | null>(null);
  const shown = card?.left ?? moved;
  const close = () => {
    if (card) onSeen(card.opened);
    setCard(null);
  };
  useEffect(() => {
    if (card?.left.length !== 0) return;
    onSeen(card.opened);
    setCard(null);
    main.current?.focus();
  }, [card, onSeen]);
  return (
    <li
      className={`side-task side-done${active ? " is-filled" : ""}`}
      data-motion-key="done-shelf"
      ref={lineRef}
    >
      <button
        aria-current={active ? "true" : undefined}
        aria-label={`Done, ${count} ${count === 1 ? "task" : "tasks"}`}
        className="side-task__main side-done__main"
        onClick={onOpen}
        ref={main}
        type="button"
      >
        <Icon name="check-circle" />
        <span>Done</span>
      </button>
      {shown.length > 0 ? (
        <button
          aria-expanded={card !== null}
          aria-haspopup="dialog"
          aria-label={`${shown.length} ${shown.length === 1 ? "task" : "tasks"} moved to Done for you`}
          className="side-done__moved"
          onClick={() => (card ? close() : setCard({ opened: moved, left: moved }))}
          ref={chip}
          type="button"
        >
          +{shown.length}
        </button>
      ) : null}
      <span aria-hidden className="side-done__count">
        {count}
      </span>
      {card && chip.current ? (
        <Popover
          anchor={chip.current}
          className="popover--quiet-moved"
          label="Moved to Done for you"
          onClose={close}
          role="dialog"
        >
          <QuietMovedCard
            hostClient={hostClient}
            onMovedBack={(threadId) =>
              setCard(
                (held) =>
                  held && { ...held, left: held.left.filter((row) => row.threadId !== threadId) },
              )
            }
            onOpenTask={(threadId) => {
              close();
              onOpenTask(threadId);
            }}
            quietTaskDays={quietTaskDays}
            rows={card.left}
          />
        </Popover>
      ) : null}
    </li>
  );
}

function QuietMovedCard({
  hostClient,
  onMovedBack,
  onOpenTask,
  quietTaskDays,
  rows,
}: {
  readonly hostClient: HostClient;
  readonly onMovedBack: (threadId: string) => void;
  readonly onOpenTask: (threadId: string) => void;
  readonly quietTaskDays: QuietTaskDays | null;
  readonly rows: readonly TaskRow[];
}) {
  const toast = useToast();
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const moveBack = async (targets: readonly TaskRow[]) => {
    setMoving((held) => new Set([...held, ...targets.map(({ threadId }) => threadId)]));
    const queue = [...targets];
    let failure: unknown = null;
    await Promise.all(
      Array.from({ length: Math.min(moveBackConcurrency, queue.length) }, async () => {
        for (let row = queue.shift(); row; row = queue.shift()) {
          try {
            await hostClient.setTaskDone(row.threadId, false);
            onMovedBack(row.threadId);
          } catch (error) {
            failure ??= error;
          }
        }
      }),
    );
    setMoving((held) => {
      const next = new Set(held);
      for (const { threadId } of targets) next.delete(threadId);
      return next;
    });
    if (failure) toast.error(actionErrorMessage(failure));
  };
  return (
    <div className="quiet-moved">
      <h2 className="quiet-moved__title">Moved to Done for you</h2>
      <p className="quiet-moved__why">
        {quietTaskDays
          ? `No activity in ${quietTaskDays} ${quietTaskDays === 1 ? "day" : "days"}`
          : "No recent activity"}
      </p>
      <ul className="quiet-moved__rows">
        {rows.map((row) => (
          <li className="quiet-moved__row" key={row.threadId}>
            <button
              className="quiet-moved__open"
              onClick={() => onOpenTask(row.threadId)}
              type="button"
            >
              <TaskMark size={20} mark={taskMark(row)} quiet={taskMarkQuiet(row, true)} />
              <span className="quiet-moved__name">{row.title}</span>
            </button>
            <button
              aria-label={`Move back: ${row.title}`}
              className="icon-btn icon-btn--small quiet-moved__back"
              disabled={moving.has(row.threadId)}
              onClick={() => void moveBack([row])}
              title="Move back to Tasks"
              type="button"
            >
              <Icon name="undo" />
            </button>
          </li>
        ))}
      </ul>
      {rows.length > 1 ? (
        <div className="quiet-moved__actions">
          <button
            className="btn btn--small"
            disabled={moving.size > 0}
            onClick={() => void moveBack(rows)}
            type="button"
          >
            Move all {rows.length} back
          </button>
        </div>
      ) : null}
    </div>
  );
}
