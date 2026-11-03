import type { Request } from "@opensteer/core";

/** The winning human decision, shared by Request cards and transcript receipts. */
export function requestSettlementLabel(
  request: Pick<Request, "status" | "settlementProvenance">,
): string | null {
  if (!request.settlementProvenance) return null;
  const decision =
    request.status === "fulfilled" ? "Allowed" : request.status === "declined" ? "Declined" : null;
  return decision ? `${decision} on ${request.settlementProvenance.deviceLabel}` : null;
}
