import type { Request } from "@opensteer/core";

/** The winning answerer, shared by Request cards and transcript receipts. */
export function requestSettlementLabel(
  request: Pick<Request, "status" | "settlementProvenance">,
): string | null {
  if (!request.settlementProvenance) return null;
  if ("kind" in request.settlementProvenance) {
    return request.status === "fulfilled" || request.status === "declined"
      ? `Answered by ${request.settlementProvenance.title}`
      : null;
  }
  const decision =
    request.status === "fulfilled" ? "Allowed" : request.status === "declined" ? "Declined" : null;
  return decision ? `${decision} on ${request.settlementProvenance.deviceLabel}` : null;
}
