import type { TaskMark } from "../ui/task-mark.js";
import type { TeamTileView } from "../team/team-models.js";

/** A task's subject tile, whatever the task list calls it. */
export type TaskMarkView = Parameters<typeof TaskMark>[0]["mark"];

/** Where a task started from a team thread came from. */
export interface TaskSourceView {
  readonly team: TeamTileView;
  /** "#support", or "Maya Chen" for a DM. */
  readonly place: string;
  /** "Dana's thread". */
  readonly thread: string | null;
  /** The reader left the team, or the thread is gone: the chip greys and goes nowhere. */
  readonly available: boolean;
}
