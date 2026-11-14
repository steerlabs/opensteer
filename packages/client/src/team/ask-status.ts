import type { TeamAskOutcome, TeamAudience } from "@opensteer/core";
import type { TeamAgentRequest } from "@opensteer/protocol";

export function teamAskStatuses(
  requests: readonly TeamAgentRequest[],
  messageId: string,
  ownerName: (userId: string) => string,
): readonly { id: string; label: string }[] {
  const latest = new Map<string, TeamAgentRequest>();
  for (const request of requests) {
    const held = latest.get(request.id);
    if (!held || BigInt(request.changeSeq) >= BigInt(held.changeSeq))
      latest.set(request.id, request);
  }
  return [...latest.values()]
    .filter((request) => request.kind === "ask" && request.triggerMessageId === messageId)
    .map((request) => {
      const name = ownerName(request.ownerUserId);
      let status: string;
      if (request.askRefusal)
        status = {
          "people-only": "People only",
          "no-access": "Unavailable",
          "no-link": "Not connected",
          "rate-limited": "Request limit reached",
        }[request.askRefusal];
      else if (request.pendingRemote) status = "Asking…";
      else if (request.replyMessageId) status = "Answered";
      else if (request.failureCode === "expired") status = "Expired";
      else
        switch (request.state) {
          case "awaiting_approval":
            status = `Waiting for ${name}`;
            break;
          case "declined":
            status = "Declined";
            break;
          case "cancelled":
          case "stopped":
          case "failed":
            status = "Cancelled";
            break;
          default:
            status = "Working";
        }
      return {
        id: request.id,
        label: status === `Waiting for ${name}` ? status : `${name} · ${status}`,
      };
    });
}

export function teamAskRefusalNotice(
  outcomes: readonly TeamAskOutcome[],
  ownerName: (userId: string) => string,
): string | null {
  const reasons = {
    "people-only": "this channel is people only",
    "no-access": "their agent cannot post here",
    "no-link": "their agent is not connected to this team",
    "rate-limited": "the request limit was reached",
  };
  const refused = outcomes.flatMap(({ ownerUserId, outcome }) =>
    outcome === "queued"
      ? []
      : [`Couldn’t ask ${ownerName(ownerUserId)}’s agent: ${reasons[outcome]}.`],
  );
  return refused.length ? refused.join(" ") : null;
}

export function teamAskAudienceLabel(audience: TeamAudience): string {
  const kind = {
    public: "Public channel",
    private: "Private channel",
    dm: "Direct message",
    group_dm: "Group message",
  }[audience.channelKind];
  const external = audience.externalTeams?.length
    ? ` · Shared with ${audience.externalTeams.map((t) => t.name).join(", ")}`
    : "";
  return `${audience.teamName} · ${kind} · ${audience.memberCount} ${audience.memberCount === 1 ? "person" : "people"}${external}`;
}
