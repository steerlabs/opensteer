/**
 * What the debugger hub knows of one debugger session, which a new session knows nothing of
 * (`ElectronDebuggerHub`): made when the hub attaches the debugger, discarded at every detach.
 * Nothing in it outlives what it describes: what it keeps of one of the hub's own sessions goes
 * when that session is gone.
 */
export class DebuggerSessionState {
  /** For each session a cast can run in (the page's own is ""), the highest frame id Chromium sent. */
  readonly laneFrames = new Map<string, number>();
  /** For each, the starts Chromium has answered: its next cast's frames carry one more. */
  readonly laneStarts = new Map<string, number>();
  /**
   * The sessions the hub attached to this page for itself (cast sessions, profile inspections):
   * each is detached exactly once, on whatever path its use ends, and no channel sees it.
   */
  readonly ownSessions = new Set<string>();
  /**
   * Every one of them not yet gone: their events reach no channel. One the hub let go stays
   * until Chromium says it is detached, the last event it sends of it.
   */
  readonly ownSessionsSeen = new Set<string>();
  /** The hub's own attaches Chromium has not answered. */
  ownAttaching = 0;
  /** Target events of the page's session that came while one was unanswered, in order. */
  held: { readonly method: string; readonly record: Record<string, unknown> }[] = [];

  /** The hub let one of its sessions go: no cast runs in it again, so its counts go. */
  letGo(sessionId: string): void {
    this.ownSessions.delete(sessionId);
    this.laneFrames.delete(sessionId);
    this.laneStarts.delete(sessionId);
  }

  /** Chromium says one of the hub's sessions is detached: nothing more of it will come. */
  gone(sessionId: string): void {
    this.letGo(sessionId);
    this.ownSessionsSeen.delete(sessionId);
  }
}
