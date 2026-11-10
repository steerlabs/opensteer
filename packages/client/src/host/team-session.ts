import type { HostClient, HostSnapshot } from "./client.js";
import { TeamAccess, type TeamSummaryView } from "./team-access.js";

type SessionPort = Pick<HostClient, "rpc" | "dispatch" | "getSnapshot" | "subscribe">;

export interface TeamSessionState {
  /**
   * Whose team data this is: Deployment, viewer and session. Null when the
   * Host offers no team administration or nobody is signed in.
   */
  readonly identity: string | null;
  readonly team: TeamAccess | null;
  readonly summary: TeamSummaryView | null;
  readonly error: unknown;
  readonly loading: boolean;
  /** Bumps after every committed team command, so a screen's own reads can key on it. */
  readonly generation: number;
  /**
   * Invite links this identity made here, by invitation id. Memory only: the
   * verifier exists nowhere else and is forgotten with the identity.
   */
  readonly links: ReadonlyMap<string, string>;
  /**
   * Keeps or forgets a link for this identity only. Taken when a screen
   * renders, so an answer that arrives after a change of person is refused.
   */
  readonly holdLink: (invitationId: string, url: string) => void;
  readonly forgetLink: (invitationId: string) => void;
}

export function teamIdentity(snapshot: HostSnapshot): string | null {
  if (snapshot.teamAdministrationAvailable !== true || snapshot.session !== "authenticated")
    return null;
  if (!snapshot.user || !snapshot.deploymentId) return null;
  return `${snapshot.deploymentId}\u0000${snapshot.user.id}\u0000${snapshot.sessionId ?? ""}`;
}

const signedOut: TeamSessionState = {
  identity: null,
  team: null,
  summary: null,
  error: null,
  loading: false,
  generation: 0,
  links: new Map(),
  holdLink: () => {},
  forgetLink: () => {},
};

/**
 * One Host's team data for whoever is signed in to it now. When the
 * Deployment, viewer or session changes, everything read or made for the
 * previous one is dropped, reads still in flight for it are ignored, and the
 * new one's summary is read before any team content can render.
 */
export class TeamSession {
  readonly #port: SessionPort;
  readonly #listeners = new Set<() => void>();
  #state: TeamSessionState = signedOut;
  #read = 0;
  #started = false;
  #detach: (() => void) | null = null;
  #detachTeam: (() => void) | null = null;

  constructor(port: SessionPort) {
    this.#port = port;
  }

  getState = (): TeamSessionState => {
    this.#sync();
    return this.#state;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#detach ??= this.#port.subscribe(() => {
      if (this.#sync()) this.#emit();
    });
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#detach?.();
        this.#detach = null;
      }
    };
  };

  /** Reads the summary once the first screen has painted; nothing before. */
  start = (): void => {
    if (this.#started) return;
    this.#started = true;
    // A first sync schedules its own read.
    if (!this.#sync() && this.#state.team) void this.#load();
  };

  refresh = (): void => {
    if (this.#state.team) void this.#load();
  };

  /** Moves to the current identity; true when that dropped the previous one. */
  #sync(): boolean {
    const identity = teamIdentity(this.#port.getSnapshot());
    if (identity === this.#state.identity) return false;
    this.#read += 1;
    this.#detachTeam?.();
    this.#detachTeam = null;
    if (identity === null) {
      this.#state = signedOut;
      return true;
    }
    const team = new TeamAccess(this.#port);
    this.#detachTeam = team.onChange(() => {
      if (this.#state.team !== team) return;
      this.#set({ generation: this.#state.generation + 1 });
      void this.#load();
    });
    // Bound to this identity, never to whichever one is current when called.
    const mine = () => this.#state.team === team;
    this.#state = {
      ...signedOut,
      identity,
      team,
      loading: true,
      holdLink: (invitationId, url) => {
        if (!mine()) return;
        this.#set({ links: new Map([...this.#state.links, [invitationId, url]]) });
      },
      forgetLink: (invitationId) => {
        if (!mine() || !this.#state.links.has(invitationId)) return;
        const links = new Map(this.#state.links);
        links.delete(invitationId);
        this.#set({ links });
      },
    };
    if (this.#started) queueMicrotask(() => void this.#load());
    return true;
  }

  async #load(): Promise<void> {
    const team = this.#state.team;
    if (!team) return;
    const read = ++this.#read;
    this.#set({ loading: true });
    try {
      const summary = await team.summary();
      if (read === this.#read && this.#state.team === team)
        this.#set({ summary, error: null, loading: false });
    } catch (error) {
      if (read === this.#read && this.#state.team === team)
        this.#set({ summary: null, error, loading: false });
    }
  }

  #set(patch: Partial<TeamSessionState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
