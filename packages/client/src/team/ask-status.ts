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
      if (request.replyMessageId) status = "Answered";
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
