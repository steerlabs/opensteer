import type { Request } from "@opensteer/core";

const requestKinds: Record<string, string> = {
  integration_request: "integration.access",
  custom_integration_request: "integration.install",
  app_access_request: "computer.app.access",
  computer_access_request: "device.access",
  browser_profile_request: "browser.access",
  saved_login_request: "browser.password-sign-in",
  card_request: "browser.password-sign-in",
  chrome_cookies_request: "browser.sign-in",
  ask_person: "person.input",
};

export function requestResult(
  tool: string,
  raw: Record<string, unknown>,
  request?: Pick<Request, "id" | "kind" | "status"> | null,
): Record<string, unknown> {
  const {
    nextAction: _nextAction,
    guidance: _guidance,
    alreadyGranted: _alreadyGranted,
    ...data
  } = raw;
  const legacyStatus = raw.status;
  const status =
    request?.status ??
    (["pending", "fulfilled", "declined", "withdrawn", "cancelled"].includes(String(legacyStatus))
      ? legacyStatus
      : "fulfilled");
  const next =
    typeof raw.next === "string"
      ? raw.next
      : status === "pending"
        ? "The person was asked. Nothing is granted until they answer; you will be told when they answer."
        : status === "declined" || status === "withdrawn" || status === "cancelled"
          ? `The request was ${status}. Continue other work without this access.`
          : legacyStatus === "ready" || legacyStatus === "already-available"
            ? "It is usable now; continue the task."
            : legacyStatus === "copied"
              ? "Cookies were copied; reload the tab and check the account."
              : legacyStatus === "unavailable" ||
                  legacyStatus === "needs-approval" ||
                  legacyStatus === "refused"
                ? "The resource is unavailable. Tell the person the reported reason and continue other work."
                : "The request was fulfilled. Check the returned result and continue the task.";
  return {
    ...data,
    ...(["saved_login_request", "card_request", "chrome_cookies_request"].includes(tool) &&
    ["ready", "copied", "unavailable", "needs-approval"].includes(String(legacyStatus))
      ? { outcome: legacyStatus }
      : {}),
    requestId: request?.id ?? raw.requestId ?? null,
    kind: request?.kind ?? raw.kind ?? requestKinds[tool],
    status,
    next,
  };
}
