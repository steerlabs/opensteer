import { z } from "zod";
import { toolOutputRecord, type Request } from "@opensteer/core";
import { PasswordSignInRequestResponseSchema, type CardChoice } from "@opensteer/protocol";
import { browserSiteLabel } from "./browser-sign-in.js";
import { requestSettlementLabel } from "./request-settlement.js";

export function cardUseTitle(site: string): string {
  return `Use a saved card on ${browserSiteLabel(site)}?`;
}
export function cardUseConsent(site: string, expiresAt: string): string {
  const deadline = new Date(expiresAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Your agents can fill this card on ${browserSiteLabel(site)} until ${deadline}, including payment fields embedded by that site. The website and its payment provider can read filled details. This does not approve a particular charge.`;
}
export function cardChoiceLabel(card: CardChoice): string {
  return `${card.brand} ending ${card.lastFour}${card.label ? ` · ${card.label}` : ""} · ${String(card.expiryMonth).padStart(2, "0")}/${card.expiryYear}`;
}
export function cardUseEmpty(mac: string): string {
  return `Add a card in Passwords on ${mac}, then ask the agent again`;
}
export function cardUseOutcome(request: Request): { signedIn: boolean; text: string } | null {
  if (request.status === "pending") return null;
  const response = PasswordSignInRequestResponseSchema.safeParse(
    request.response?.kind === "external" ? request.response.value : null,
  );
  let text = "Card use stopped";
  if (request.status === "declined") text = "Card use not allowed";
  else if (response.success) {
    const result = response.data;
    if (result.outcome === "authorized")
      text = `Allowed card use on ${request.payload.kind === "browser.password-sign-in" ? browserSiteLabel(request.payload.site) : "the site"} · ${result.account}`;
    else if (result.outcome === "expired") text = "This card approval timed out";
    else if (result.outcome === "unavailable")
      text =
        result.reason === "passwords-off"
          ? "Agent use of saved passwords and cards is off"
          : result.reason === "not-set-up"
            ? "Passwords isn’t set up"
            : result.reason === "no-saved-login"
              ? "No saved card"
              : "Passwords didn’t respond";
  }
  const settlement = requestSettlementLabel(request);
  return {
    signedIn: response.success && response.data.outcome === "authorized",
    text: text + (settlement ? ` · ${settlement}` : ""),
  };
}
export function readCardUseResult(text: string) {
  const result = z
    .discriminatedUnion("status", [
      z
        .object({
          status: z.enum(["ready", "pending", "resolved", "declined", "needs-approval"]),
          site: z.url(),
        })
        .passthrough(),
      z
        .object({ status: z.literal("unavailable"), site: z.url(), reason: z.string() })
        .passthrough(),
    ])
    .safeParse(toolOutputRecord(text));
  return result.success ? result.data : null;
}
