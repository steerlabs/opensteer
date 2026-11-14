import type { TeamAskOutcome, TeamAudience } from "@opensteer/core";
import type { NeedsYouPage, TeamAgentRequest } from "@opensteer/protocol";

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

/**
 * What an ask's owner gets in team chat in place of "Waiting for <them>".
 * `decide`: answer from chat, approving the teammate's words as sent.
 * `review-edited`: the owner already edited the task's copy, so chat never
 * approves words the person isn't looking at; the control opens the task.
 * `none`: the ordinary status line, as everyone else sees it.
 */
export type TeamAskOwnerControl =
  | {
      readonly kind: "decide";
      readonly teamId: string;
      readonly requestId: string;
      /** The task the ask waits in, for the person who wants to see it first. */
      readonly threadId: string;
      readonly expectedRevision: number;
    }
  | { readonly kind: "review-edited"; readonly threadId: string; readonly messageId: string }
  | { readonly kind: "none" };

/**
 * Decides the owner's control from the team's request, the viewer's team
 * user id and the personal Host's Needs you, which knows the task and the
 * version of its copy. An ask the personal Host has not admitted, already
 * answered or could not admit has no control.
 */
export function teamAskOwnerControl(input: {
  readonly request: TeamAgentRequest;
  readonly teamId: string;
  readonly viewerUserId: string | null;
  readonly needsYou: NeedsYouPage | null;
}): TeamAskOwnerControl {
  const { request } = input;
  if (
    request.kind !== "ask" ||
    request.ownerUserId !== input.viewerUserId ||
    request.state !== "awaiting_approval" ||
    request.pendingRemote ||
    request.askRefusal
  )
    return { kind: "none" };
  const entry = input.needsYou?.entries.find(
    (row) => row.kind === "team-ask" && row.teamId === input.teamId && row.requestId === request.id,
  );
  if (entry?.kind !== "team-ask" || !entry.task || entry.failureReason) return { kind: "none" };
  return entry.task.revision === 0
    ? {
        expectedRevision: 0,
        kind: "decide",
        requestId: request.id,
        teamId: input.teamId,
        threadId: entry.task.threadId,
      }
    : { kind: "review-edited", messageId: entry.task.messageId, threadId: entry.task.threadId };
}
