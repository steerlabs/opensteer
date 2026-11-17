import type { Blocked } from "@opensteer/core";
import type { IntegrationReadiness } from "@opensteer/integration-core";

export function localTargetBlocked(
  readiness: IntegrationReadiness | undefined,
  name: string,
  target: { dataApp: string; computerId?: string } | { server: string } = { server: name },
): Blocked | undefined {
  if (!readiness || readiness.code === "READY") return undefined;
  if (readiness.code === "ACCESS_GRANT_REQUIRED" && readiness.requiredAccess === null)
    throw new Error("Access-grant readiness must name its required access");
  switch (readiness.code) {
    case "READ_ONLY_TASK":
      return {
        code: "read_only_task",
        message: "This task runs read-only.",
        next: "Use read operations. The person can change this task's access mode to allow changes; another app or server grant cannot raise this task's ceiling.",
      };
    case "ACCESS_GRANT_REQUIRED":
      return {
        code: "access_required",
        message: `${name} requires an access grant.`,
        next: `Call app_access_request ${JSON.stringify({ ...target, access: readiness.requiredAccess, reason: "<why you need it>" })}.`,
      };
    case "USER_AUTHORIZATION_REQUIRED":
    case "REAUTHORIZATION_REQUIRED":
      return {
        code: "setup_required",
        message: `${name} needs the person's setup or approval.`,
        next: `Call app_access_request ${JSON.stringify({ ...target, access: "read-write", reason: "<why you need it>" })}; the person can finish setup in Opensteer.`,
      };
    case "INTEGRATION_UNAVAILABLE":
      return {
        code: "unavailable",
        message: `${name} is unavailable${readiness.detail ? `: ${readiness.detail.slice(0, 240).replace(/[.!?]+$/, "")}` : ""}.`,
        next: "Continue without it and tell the person what the message says.",
      };
  }
}
