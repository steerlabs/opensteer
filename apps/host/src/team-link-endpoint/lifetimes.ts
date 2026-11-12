import type { TeamAccessEffects } from "../team/access-port.js";
import type { TeamAgentRequestId, TeamChannelId, TeamLinkId, UserId } from "@opensteer/core";

interface Lifetime {
  readonly linkId: TeamLinkId;
  readonly userId: UserId;
  readonly requestId?: TeamAgentRequestId;
  readonly channelIds: readonly TeamChannelId[];
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
        effects.links.includes(entry.linkId) ||
        effects.users.includes(entry.userId) ||
        (entry.requestId !== undefined && effects.requests.includes(entry.requestId)) ||
        entry.channelIds.some((id) => effects.channels.includes(id))
      ) {
        this.#entries.delete(entry);
        entry.cancel(effects.links.includes(entry.linkId));
      }
    }
  }

  stop(): void {
    for (const entry of this.#entries) entry.cancel(false);
    this.#entries.clear();
  }
}
