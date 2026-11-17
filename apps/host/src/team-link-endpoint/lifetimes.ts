import type { TeamAccessEffects } from "../team/access-port.js";
import type { TeamAgentRequestId, TeamChannelId, TeamLinkId, UserId } from "@opensteer/core";

interface Lifetime {
  readonly linkId?: TeamLinkId;
  readonly userId: UserId;
  readonly requestId?: TeamAgentRequestId;
  readonly channelIds: readonly TeamChannelId[];
  /** A link socket a client can reopen on another copy, unlike a transfer in flight. */
  readonly socket?: boolean;
  readonly cancel: (revoked: boolean) => void;
}

export class TeamLinkLifetimes {
  readonly #entries = new Set<Lifetime>();

  register(lifetime: Lifetime): () => void {
    this.#entries.add(lifetime);
    return () => {
      this.#entries.delete(lifetime);
    };
  }

  close(effects: TeamAccessEffects): void {
    for (const entry of this.#entries) {
      if (
        (entry.linkId !== undefined && effects.links.includes(entry.linkId)) ||
        effects.users.includes(entry.userId) ||
        (entry.requestId !== undefined && effects.requests.includes(entry.requestId)) ||
        entry.channelIds.some((id) => effects.channels.includes(id))
      ) {
        this.#entries.delete(entry);
        entry.cancel(entry.linkId !== undefined && effects.links.includes(entry.linkId));
      }
    }
  }

  /** Moves link sockets to another copy; admitted transfers keep running. */
  closeSockets(): void {
    for (const entry of this.#entries)
      if (entry.socket) {
        this.#entries.delete(entry);
        entry.cancel(false);
      }
  }
  closeAll(_code = 1012): void {
    for (const entry of this.#entries) entry.cancel(false);
    this.#entries.clear();
  }
  stop(): void {
    this.closeAll(1012);
  }
}
