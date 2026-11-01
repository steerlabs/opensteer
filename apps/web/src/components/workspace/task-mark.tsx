import { memo, type CSSProperties } from "react";
import {
  markColorPaint,
  homeCursorPaint,
  type TaskMark as ResolvedTaskMark,
  type TaskTone,
} from "@opensteer/client/host";
import { WorkspaceIconGlyph } from "../workspace-orb.js";

export type TaskMarkSize = 16 | 20 | 22;

/**
 * Subject and identity only; lifecycle belongs beside it. A tile tinted with
 * the task's colour under its symbol, and a neutral tile, empty until the
 * task has a symbol, where either is missing.
 */
export const TaskMark = memo(function TaskMark({
  mark,
  size,
  quiet = false,
}: {
  readonly mark: ResolvedTaskMark;
  readonly size: TaskMarkSize;
  readonly quiet?: boolean;
}) {
  const paint = mark.icon === null || mark.color === null ? null : markColorPaint[mark.color];
  return (
    <span
      aria-hidden="true"
      className={`task-mark task-mark--${size}${quiet ? " task-mark--quiet" : ""}`}
      data-icon={mark.icon ?? undefined}
      data-color={mark.color ?? "neutral"}
      style={paint ? { background: paint.wash, color: paint.glyph } : undefined}
    >
      {mark.icon ? <WorkspaceIconGlyph icon={mark.icon} /> : null}
    </span>
  );
});

export const ChatOrb = memo(function ChatOrb({ size }: { readonly size: TaskMarkSize | 28 }) {
  return (
    <span aria-hidden="true" className="chat-orb" style={{ width: size, height: size }}>
      <img alt="" decoding="async" draggable={false} src="/opensteer.png" />
    </span>
  );
});

/** A stable trailing slot; unread does not change a task's lifecycle. */
export function TaskState({
  state,
  unread = false,
}: {
  readonly state: TaskTone;
  readonly unread?: boolean;
}) {
  return (
    <span aria-hidden="true" className={`task-state task-state--${state}`} data-state={state}>
      {state === "working" ? (
        <WorkingRing />
      ) : state === "needs-you" ? (
        <span className="task-state__disc">!</span>
      ) : state === "failed" ? (
        <span className="task-state__disc">
          <svg viewBox="0 0 12 12">
            <path
              d="m4 4 4 4M8 4 4 8"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.7"
            />
          </svg>
        </span>
      ) : state === "waiting" ? (
        <svg className="task-state__pause" viewBox="0 0 12 12">
          <path
            d="M4.4 3.6v4.8M7.6 3.6v4.8"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.7"
          />
        </svg>
      ) : unread ? (
        <span className="task-row__unread" />
      ) : null}
    </span>
  );
}

/**
 * Work in progress: one slow arc that traces the mark at work, in the colour
 * its tile wears, and ember on Chat, a neutral tile or on its own. `settling`
 * closes it and lets it fade once the work stops.
 */
export function WorkingRing({
  mark,
  settling = false,
}: {
  readonly mark?: ResolvedTaskMark | null;
  readonly settling?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className="working-ring"
      data-settling={settling || undefined}
      style={
        mark && mark.icon !== null && mark.color !== null
          ? ({ "--working-hue": markColorPaint[mark.color].glyph } as CSSProperties)
          : undefined
      }
    />
  );
}

export function TaskBadge({ state }: { readonly state: TaskTone }) {
  return state === "needs-you" || state === "failed" ? (
    <span className="task-badge">
      <TaskState state={state} />
    </span>
  ) : null;
}

export function taskStateWords(state: TaskTone): string {
  switch (state) {
    case "working":
      return "working";
    case "needs-you":
      return "needs you";
    case "waiting":
      return "waiting";
    case "finished":
      return "finished";
    case "failed":
      return "couldn’t finish";
  }
}

export function taskCursorPaint(mark: ResolvedTaskMark, home: boolean): string {
  return home
    ? homeCursorPaint
    : mark.color === null
      ? "var(--surface-hover)"
      : markColorPaint[mark.color].cursor;
}
