import type { Request } from "@opensteer/core";
import type { SavedLoginResult, UseCardResult, ChromeCookiesResult } from "@opensteer/protocol";
import { requestPendingGuidance } from "@opensteer/shared/requestGuidance";
import { requestResult } from "../mcp/request-result.js";

export function savedLoginAgentResult(result: SavedLoginResult, request: Request | null) {
  const next =
    request?.status === "pending"
      ? requestPendingGuidance
      : result.status === "ready"
        ? "Use loginRef to sign in and continue the task."
        : "No saved login was released. Continue without it and report the reason.";
  return {
    ...(request
      ? requestResult(request, next, "replayed" in result && result.replayed === true)
      : {
          requestId: null,
          kind: "browser.password-sign-in" as const,
          status: "fulfilled" as const,
          next,
        }),
    site: result.site,
    loginStatus: result.status,
    ...(result.status === "ready" ? { loginRef: result.loginRef, account: result.account } : {}),
    ...(result.status === "unavailable" ? { reason: result.reason } : {}),
  };
}

export function cardAgentResult(result: UseCardResult, request: Request | null) {
  const next =
    request?.status === "pending"
      ? requestPendingGuidance
      : result.status === "ready"
        ? "Use cardRef to fill the approved card."
        : "No card was released. Continue without it and report the reason.";
  return {
    ...(request
      ? requestResult(request, next)
      : {
          requestId: null,
          kind: "browser.password-sign-in" as const,
          status: "fulfilled" as const,
          next,
        }),
    site: result.site,
    cardStatus: result.status,
    ...(result.status === "ready"
      ? { cardRef: result.cardRef, brand: result.brand, lastFour: result.lastFour }
      : {}),
    ...(result.status === "unavailable" ? { reason: result.reason } : {}),
  };
}

export function chromeCookiesAgentResult(result: ChromeCookiesResult, request: Request | null) {
  const next =
    request?.status === "pending"
      ? requestPendingGuidance
      : result.status === "copied"
        ? "Cookies were copied; reload the tab and check the account."
        : "No cookies were copied. Continue without them and report the reason.";
  return {
    ...(request
      ? requestResult(request, next, "replayed" in result && result.replayed === true)
      : { requestId: null, kind: "browser.sign-in" as const, status: "fulfilled" as const, next }),
    site: result.site,
    cookiesStatus: result.status,
    ...(result.status === "copied"
      ? { sourceName: result.sourceName, profileName: result.profileName }
      : {}),
    ...(result.status === "unavailable" ? { reason: result.reason } : {}),
  };
}
