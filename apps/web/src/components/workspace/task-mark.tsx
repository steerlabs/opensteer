import { memo } from "react";
import {
  markColorPaint,
  homeCursorPaint,
  type TaskMark as ResolvedTaskMark,
  type TaskTone,
} from "@opensteer/client/host";
import { WorkspaceIconGlyph } from "../workspace-orb.js";

export type TaskMarkSize = 16 | 20 | 22;

/** Subject and identity only; lifecycle belongs beside it. */
export const TaskMark = memo(function TaskMark({
  mark,
  size,
  quiet = false,
}: {
  readonly mark: ResolvedTaskMark;
  readonly size: TaskMarkSize;
  readonly quiet?: boolean;
}) {
  const icon = mark.pending || mark.color === null ? "document" : mark.icon;
  return (
    <span
      aria-hidden="true"
      className={`task-mark task-mark--${size}${quiet ? " task-mark--quiet" : ""}`}
      data-icon={icon}
      data-color={mark.color ?? "neutral"}
      data-pending={mark.pending}
      style={{
        color:
          mark.pending || mark.color === null ? "var(--muted)" : markColorPaint[mark.color].glyph,
      }}
    >
      <WorkspaceIconGlyph icon={icon} />
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
        <svg className="task-state__spinner" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="5.6" fill="none" stroke="var(--line-strong)" strokeWidth="1.8" />
          <path
            d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6"
            fill="none"
            stroke="var(--ember)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
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
