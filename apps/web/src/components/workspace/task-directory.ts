import { useMemo, useRef } from "react";
import {
  taskAttention,
  taskList,
  type HostClient,
  type HostSnapshot,
  type TaskAttention,
  type TaskList,
  type TaskRow,
} from "@opensteer/client/host";
import { useTaskSnapshot } from "../task-rows.js";

/** What a task mark anywhere needs to say about its task: name and state, by thread. */
export interface TaskDirectory {
  readonly list: TaskList;
  readonly snapshot: HostSnapshot;
  readonly rows: ReadonlyMap<string, TaskRow>;
  /** One per task that needs the reader, with the exact request to focus, in list order. */
  readonly attention: readonly TaskAttention[];
  readonly attentionByThread: ReadonlyMap<string, TaskAttention>;
  readonly homeThreadId: string | null;
}

/** Home identity belongs to the Host and Workspace, whichever URL opened it. */
export function homeThreadKind(
  threadId: string,
  snapshot: Pick<HostSnapshot, "homeThreadId" | "workspaces">,
): "main" | "specialized" | null {
  if (threadId === snapshot.homeThreadId) return "main";
  return snapshot.workspaces.find((workspace) => workspace.homeThreadId === threadId)?.kind ?? null;
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
    const value = taskDirectory(snapshot, openThreadId);
    const key = JSON.stringify([
      value.list,
      value.attention,
      value.homeThreadId,
      snapshot.threads,
      snapshot.tasks,
      snapshot.activeTasks,
      snapshot.workspaceTasks,
      snapshot.workspaces,
      snapshot.taskMarksAvailable,
    ]);
    if (previous.current?.key === key) return previous.current.value;
    previous.current = { key, value };
    return value;
  }, [snapshot, openThreadId]);
}

function taskDirectory(snapshot: HostSnapshot, openThreadId?: string | null): TaskDirectory {
  const list = taskList(snapshot, { openThreadId });
  const rows = new Map<string, TaskRow>();
  for (const row of [
    ...(list.chat ? [list.chat] : []),
    ...list.working,
    ...list.ready,
    ...list.done,
  ])
    rows.set(row.threadId, row);
  const order = [...(list.chat ? [list.chat] : []), ...list.working, ...list.ready].map(
    (row) => row.threadId,
  );
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
    homeThreadId: snapshot.homeThreadId,
    list,
    rows,
  };
}
