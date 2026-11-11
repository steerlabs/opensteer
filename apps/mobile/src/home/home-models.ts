import type { TaskMark } from "../ui/task-mark.js";
import type { TeamTileView } from "../team/team-models.js";

/**
 * What Home, Needs you and the drawer draw for the reader's own Opensteer: one
 * agent, its tasks, and the folders they work in. Plain values, already worded.
 */

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

export type TaskTone = "needs-you" | "working" | "waiting" | "failed" | "finished" | "idle";

export interface HomeTaskRowView {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly mark: TaskMarkView;
  readonly tone: TaskTone;
  /** The second line: the ask when it needs you, else the live step or outcome ("Finished · cart is ready"). */
  readonly line: string | null;
  readonly source: TaskSourceView | null;
  readonly unread: boolean;
  /** "Tue", "9:41", for finished work. */
  readonly time: string | null;
}

export interface FolderSectionView {
  readonly id: string;
  /** "Agent home", or the folder's last path part. */
  readonly label: string;
  /** "~/Opensteer" for Agent home, else the computer. */
  readonly detail: string;
  readonly home: boolean;
  readonly folded: boolean;
  /** Folded: the loudest state inside, and how many tasks it holds. */
  readonly loudest: TaskTone | null;
  readonly count: number;
  readonly tasks: readonly HomeTaskRowView[];
  /** Open tasks past the first five. */
  readonly more: number;
}

/** One Request, as Needs you and Home's top section draw it. */
export interface NeedsYouCardView {
  readonly id: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly mark: TaskMarkView;
  /** "Studio Mac", "Agent home"; a team task names its source instead. */
  readonly where: string;
  readonly source: TaskSourceView | null;
  /** "Approve a ¥48,000 deposit?". */
  readonly ask: string;
  readonly detail: string | null;
  /** For a team task: "#support sees “Waiting for Tim”". */
  readonly channelSees: string | null;
  /** Approvals answer in place; everything else opens its task. */
  readonly answer:
    | { readonly kind: "approve"; readonly approve: string; readonly deny: string }
    | { readonly kind: "open" };
  readonly age: string;
}

export interface FolderChoiceView {
  readonly id: string;
  readonly label: string;
  /** "~/code/opensteer · Studio Mac". */
  readonly detail: string;
  readonly home: boolean;
  readonly current: boolean;
}

export interface ComputerChoiceView {
  readonly id: string;
  readonly name: string;
  readonly kind: "laptop" | "desktop" | "mini";
  /** Offline or unable to hold a task here: dimmed, with the reason. */
  readonly unavailable: string | null;
}

export interface FolderEntryView {
  readonly path: string;
  readonly name: string;
}

export interface DrawerTabView {
  readonly id: string;
  readonly title: string;
  readonly kind: "browser" | "app" | "phone";
}

export interface DrawerComputerView {
  readonly name: string;
  readonly state: "connected" | "connecting" | "offline";
}
