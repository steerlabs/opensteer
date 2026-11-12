import type { ChannelKind, TeamTileView } from "../team/team-models.js";

/** A task a team thread started: the team, the channel, and whose thread. */
export interface TaskSourceView {
  readonly team: TeamTileView;
  readonly channel: { readonly kind: ChannelKind; readonly name: string };
  readonly threadAuthor?: string | null | undefined;
  /** False once the person left or was removed: the task stays, the way back is gone. */
  readonly available: boolean;
}
