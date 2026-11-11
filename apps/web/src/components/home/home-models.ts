import type { TaskMark, TaskState } from "../workspace/task-mark.js";
import type { ChannelKind, TeamTileView } from "../team/team-models.js";

/**
 * What the personal screens draw: one person, their agent, and their tasks
 * grouped by folder. Wiring maps the personal client's records onto these.
 */

export type TaskMarkView = Parameters<typeof TaskMark>[0]["mark"];
export type TaskToneView = Parameters<typeof TaskState>[0]["state"];

/** Where a task works: one folder on one computer. Fixed once the task starts. */
export interface FolderView {
  readonly id: string;
  /** The last part of the path, or "Agent home". */
  readonly label: string;
  readonly path: string;
  readonly computerName: string;
  /** `~/Opensteer`, the agent's own folder, where its memory lives. */
  readonly agentHome: boolean;
}

/** A task a team thread started: the team, the channel, and whose thread. */
export interface TaskSourceView {
  readonly team: TeamTileView;
  readonly channel: { readonly kind: ChannelKind; readonly name: string };
  readonly threadAuthor?: string | null | undefined;
  /** False once the person left or was removed: the task stays, the way back is gone. */
  readonly available: boolean;
}

export interface TaskRowView {
  readonly id: string;
  readonly title: string;
  readonly mark: TaskMarkView;
  readonly tone: TaskToneView;
  readonly unread: boolean;
  /** What it asks of the person, when it needs them. */
  readonly ask: string | null;
  readonly source: TaskSourceView | null;
  /** Home's longer line: "Working · reading the order history". */
  readonly status: string | null;
  readonly updatedAt: string;
  readonly canBeDone?: boolean | undefined;
}

/** The loudest thing a folded folder holds, so folding never hides an ask. */
export type FolderSignal = "needs-you" | "working" | "failed" | "unread" | null;

export interface FolderGroupView {
  readonly folder: FolderView;
  readonly tasks: readonly TaskRowView[];
  /** Open tasks beyond those shown. */
  readonly more: number;
  readonly signal: FolderSignal;
  readonly needsYou: number;
}

export interface ComputerView {
  readonly id: string;
  readonly name: string;
  readonly kind: "laptop" | "desktop";
  /** The computer this Opensteer runs on. */
  readonly hosting: boolean;
  readonly online: boolean;
}

export interface FolderEntryView {
  readonly name: string;
  readonly path: string;
}

/** A folder listing the picker asked for. `entries` is null while it loads. */
export interface FolderBrowseView {
  readonly computer: ComputerView;
  readonly path: string;
  /** The path's parts from the top the person can reach, for the crumb line. */
  readonly crumbs: readonly { readonly label: string; readonly path: string }[];
  readonly entries: readonly FolderEntryView[] | null;
  readonly error?: string | null | undefined;
}

export type NeedsYouAnswer =
  | { readonly kind: "approve"; readonly approve: string; readonly deny: string }
  | {
      readonly kind: "choices";
      readonly options: readonly { readonly id: string; readonly label: string }[];
    }
  | { readonly kind: "sign-in"; readonly label: string }
  | { readonly kind: "open" };

/** One Request from one task, waiting on the person. */
export interface NeedsYouItemView {
  readonly id: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly mark: TaskMarkView;
  readonly where:
    | { readonly kind: "folder"; readonly label: string }
    | { readonly kind: "team"; readonly source: TaskSourceView };
  readonly askedAt: string;
  readonly title: string;
  readonly detail: string | null;
  /** A team-started task's channel card while it waits: "Waiting for Tim". */
  readonly channelSees: string | null;
  readonly answer: NeedsYouAnswer;
}
