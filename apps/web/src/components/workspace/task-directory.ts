import { useCallback, useMemo, useRef } from "react";
import {
  sameTaskListSource,
  sameTaskMark,
  taskAttention,
  taskList,
  threadMark,
  type HostClient,
  type HostSnapshot,
  type TaskAttention,
  type TaskList,
  type TaskMark,
  type TaskRow,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useTaskSnapshot } from "../task-rows.js";
import { taskAt } from "./navigation.js";

/** What a task mark anywhere needs to say about its task: name and state, by thread. */
export interface TaskDirectory {
  readonly list: TaskList;
  readonly snapshot: HostSnapshot;
  readonly rows: ReadonlyMap<string, TaskRow>;
  /** One per task that needs the reader, with the exact request to focus, in list order. */
  readonly attention: readonly TaskAttention[];
  readonly attentionByThread: ReadonlyMap<string, TaskAttention>;
}

/** The task a path shows. */
export function conversationAt(pathname: string): string | null {
  return taskAt(pathname);
}

/** The task list, read once for every mark and row that names a task. */
export function useTaskDirectory(
  hostClient: HostClient,
  openThreadId?: string | null,
): TaskDirectory {
  const snapshot = useTaskSnapshot(hostClient);
  // A snapshot that changed nothing a mark or row says (a tab's catalog, say)
  // keeps the same directory, so the rows that read it do not re-render.
  const previous = useRef<{ readonly key: string; readonly value: TaskDirectory } | null>(null);
  return useMemo(() => {
    const value = taskDirectory(snapshot, openThreadId, previous.current?.value.list);
    const key = JSON.stringify([
      value.list,
      value.attention,
      snapshot.threads,
      snapshot.tasks,
      snapshot.activeTasks,
      snapshot.doneTasks,
      snapshot.quietTasksAvailable,
      snapshot.taskMarksAvailable,
    ]);
    if (previous.current?.key === key) return previous.current.value;
    previous.current = { key, value };
    return value;
  }, [snapshot, openThreadId]);
}

function taskDirectory(
  snapshot: HostSnapshot,
  openThreadId: string | null | undefined,
  previous: TaskList | undefined,
): TaskDirectory {
  const list = taskList(snapshot, { openThreadId, previous });
  const rows = new Map<string, TaskRow>();
  for (const row of [...list.working, ...list.ready, ...list.done]) rows.set(row.threadId, row);
  const order = [...list.working, ...list.ready].map((row) => row.threadId);
  const asks = taskAttention(snapshot);
  const attentionByThread = new Map(asks.map((ask) => [ask.threadId, ask]));
  const attention = order.flatMap((threadId) => {
    const ask = attentionByThread.get(threadId);
    return ask ? [ask] : [];
  });
  return {
    snapshot,
    attention,
    attentionByThread,
    list,
    rows,
  };
}

/** What a task's own head says of where it stands: its state, and why it failed. */
export interface TaskStanding {
  readonly tone: TaskRow["tone"];
  readonly failure: string | null;
}

const sameStanding = (left: TaskStanding | null, right: TaskStanding | null) =>
  left === right ||
  (left !== null && right !== null && left.tone === right.tone && left.failure === right.failure);

/**
 * One task's standing as every task list draws it. The list is worked out again only when what
 * it is drawn from changed, and this redraws only when this task's standing did, never another's.
 */
export function useTaskStanding(hostClient: HostClient, threadId: string): TaskStanding | null {
  const select = useMemo(() => {
    let source: HostSnapshot | null = null;
    let rows: ReadonlyMap<string, TaskRow> = new Map();
    return (snapshot: HostSnapshot): TaskStanding | null => {
      if (source === null || !sameTaskListSource(source, snapshot)) {
        source = snapshot;
        const list = taskList(snapshot);
        rows = new Map(
          [...list.working, ...list.ready, ...list.done].map((row) => [row.threadId, row]),
        );
      }
      const row = rows.get(threadId);
      return row ? { tone: row.tone, failure: row.tone === "failed" ? row.line : null } : null;
    };
  }, [threadId]);
  return useHostSelector(hostClient, select, sameStanding);
}

/** A task's mark, wherever this client holds the task; null names no task and draws the default. */
export function useTaskMark(hostClient: HostClient, threadId: string | null): TaskMark {
  const select = useCallback(
    (snapshot: HostSnapshot) => threadMark(threadId ?? "", snapshot),
    [threadId],
  );
  return useHostSelector(hostClient, select, sameTaskMark);
}

export { personDoneTaskList } from "@opensteer/client/host";
