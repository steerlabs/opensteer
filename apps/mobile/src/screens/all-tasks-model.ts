import {
  allTasksFilters,
  allTasksRows,
  deriveSurface,
  doneTaskList,
  taskList,
  threadMark,
  type AllTasksFilter,
  type HostSnapshot,
  type SurfaceModel,
  type TaskList,
  type TaskListSource,
  type TaskMark,
  type TaskRow,
} from "@opensteer/client/host";

export interface AllTasksView {
  readonly list: TaskList;
  /** Done reads the Host's own Done list: a read Done task is never in the open pages. */
  readonly done: readonly TaskRow[];
  readonly doneHasMore: boolean;
}

export function allTasksView(snapshot: TaskListSource): AllTasksView {
  const list = taskList(snapshot);
  const done = doneTaskList(snapshot);
  return { list, done: done?.rows ?? list.done, doneHasMore: done?.hasMore ?? false };
}

export function allTasksFilterRows(view: AllTasksView, filter: AllTasksFilter): readonly TaskRow[] {
  return allTasksRows(view.list, filter, view.done);
}

export function allTasksCounts(
  view: AllTasksView,
  needsYou: number,
): Readonly<Record<AllTasksFilter, number>> {
  return Object.fromEntries(
    allTasksFilters.map((id) => [
      id,
      id === "needs-you" ? needsYou : allTasksFilterRows(view, id).length,
    ]),
  ) as Record<AllTasksFilter, number>;
}

/** One card per Request the Host says needs the reader, answered in place. */
export interface NeedsYouCard {
  readonly surface: SurfaceModel;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly mark: TaskMark;
  readonly teamOrigin: TaskRow["teamOrigin"];
  readonly folder: TaskRow["folder"] | null;
}

export function needsYouCards(
  snapshot: Pick<HostSnapshot, "needsYou" | "user" | "threads" | "tasks" | "activeTasks">,
): readonly NeedsYouCard[] {
  return (snapshot.needsYou?.entries ?? []).flatMap((entry) => {
    const surface = deriveSurface([entry.request], snapshot.user);
    if (surface === null) return [];
    const thread = snapshot.threads.find(({ id }) => id === entry.navigationThreadId);
    return [
      {
        surface,
        taskId: entry.navigationThreadId,
        taskTitle: entry.title,
        mark: threadMark(entry.navigationThreadId, snapshot),
        teamOrigin: thread?.teamOrigin ?? null,
        folder: thread?.folder ?? null,
      },
    ];
  });
}
