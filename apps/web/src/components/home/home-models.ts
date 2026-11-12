import type { ChannelKind, TeamTileView } from "../team/team-models.js";

/**
 * What the personal screens draw: one person, their agent, and their tasks
 * and their source or folder. Wiring maps the personal client's records onto these.
 */

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
