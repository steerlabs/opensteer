import type { Blocked } from "@opensteer/core";
import type { IntegrationReadiness } from "@opensteer/integration-core";

export function integrationBlocked(
  readiness: IntegrationReadiness | undefined,
  integration: string,
): Blocked | undefined {
  if (!readiness || readiness.code === "READY") return undefined;
  if (readiness.code === "ACCESS_GRANT_REQUIRED" && readiness.requiredAccess === null)
    throw new Error("Access-grant readiness must name its required access");
  const args = {
    integration,
    ...(readiness.connectionId ? { account: readiness.connectionId } : {}),
    server: readiness.serverId,
    access: readiness.requiredAccess ?? "<read|read-write>",
    reason: "<why you need it>",
  };
  const next = `Call integration_request ${JSON.stringify(args)}.`;
  switch (readiness.code) {
    case "ACCESS_GRANT_REQUIRED":
      return { code: "access_required", message: `${integration} requires an access grant.`, next };
    case "USER_AUTHORIZATION_REQUIRED":
      return { code: "sign_in_required", message: `${integration} requires sign-in.`, next };
    case "REAUTHORIZATION_REQUIRED":
      return {
        code: "reauthorization_required",
        message: `${integration} requires reauthorization.`,
        next,
      };
    case "ADMIN_CONFIGURATION_REQUIRED":
      return {
        code: "admin_setup_required",
        message: `${integration} requires administrator setup.`,
        next,
      };
    case "INTEGRATION_UNAVAILABLE":
      return {
        code: "unavailable",
        message: `${integration} is unavailable${readiness.detail ? `: ${readiness.detail.slice(0, 240).replace(/[.!?]+$/, "")}` : ""}.`,
        next: "Continue without it and tell the person what the message says.",
      };
  }
}
