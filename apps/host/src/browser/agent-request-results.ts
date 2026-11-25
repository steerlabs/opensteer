import type { Request } from "@opensteer/core";
import type { SavedLoginResult, UseCardResult, ChromeCookiesResult } from "@opensteer/protocol";
import { requestPendingGuidance } from "@opensteer/shared/requestGuidance";
import { immediateRequestResult, requestResult } from "../mcp/request-result.js";

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
      : immediateRequestResult(
          "browser.password-sign-in",
          result.status === "ready" ? "fulfilled" : "blocked",
          next,
        )),
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
        : result.status === "needs-approval"
          ? "No card was released. Ask the parent task to request the person's approval."
          : "No card was released. Continue without it and report the reason.";
  return {
    ...(request
      ? requestResult(request, next)
      : immediateRequestResult(
          "browser.password-sign-in",
          result.status === "ready" ? "fulfilled" : "blocked",
          next,
        )),
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
        : result.status === "unavailable" && result.reason === "unconfirmed"
          ? "The sign-in may have been applied; check the page before asking again."
          : "No cookies were copied. Continue without them and report the reason.";
  return {
    ...(request
      ? requestResult(request, next, "replayed" in result && result.replayed === true)
      : immediateRequestResult(
          "browser.sign-in",
          result.status === "copied" ? "fulfilled" : "blocked",
          next,
        )),
    site: result.site,
    cookiesStatus: result.status,
    ...(result.status === "copied"
      ? { sourceName: result.sourceName, profileName: result.profileName }
      : {}),
    ...(result.status === "unavailable" ? { reason: result.reason } : {}),
  };
}
