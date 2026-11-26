import { normalizeToolError } from "@opensteer/agent-tools";
import { DeviceAccessRefusal } from "../administration/device-access.js";
import type { Blocked } from "@opensteer/core";
import type { IntegrationReadiness } from "@opensteer/integration-core";

const deviceCapabilityLabel = { apps: "Apps", browser: "Browser", files: "Files" } as const;

/**
 * The sentence a connected agent reads for a device's refusal, or null where it reads the same as
 * any agent. It is told the person's switch is off and that turning it on is the person's, or that
 * the device it was shown is offline, by the name it was shown: it has no tool to ask with.
 */
export function deviceRefusalSentence(
  error: DeviceAccessRefusal,
  connection: boolean,
): string | null {
  if (!connection) return null;
  if (error.reason === "device-access-off")
    return `${deviceCapabilityLabel[error.capability]} access is off on ${error.machineName ?? "this device"}. The person can turn it on in Opensteer.`;
  if (error.reason === "device-offline") return `${error.machineName ?? "This device"} is offline.`;
  return null;
}

/** What a device's refusal blocks, worded for a connected agent when `connection` is set. */
export function deviceAccessBlocked(error: unknown, connection = false): Blocked | undefined {
  if (!(error instanceof DeviceAccessRefusal)) return undefined;
  const sentence = deviceRefusalSentence(error, connection);
  const { code, message, next } = normalizeToolError({
    code: error.code,
    message: error.message,
    reason: error.reason,
    computerId: error.machineId,
    capability: error.capability,
    ...(error.reason === "device-stopped"
      ? {
          next: "Tell the person agents are stopped on it; work there can continue once they resume them on that computer.",
        }
      : error.reason === "device-asleep"
        ? { next: "Tell the person it is asleep; work can continue once it wakes." }
        : error.reason === "device-offline"
          ? { next: "Continue without it and tell the person what the message says." }
          : {}),
  });
  return sentence
    ? {
        code,
        message: sentence,
        // As a Mac app on an offline Mac says it (computer-use-discovery.ts).
        next:
          error.reason === "device-offline"
            ? "The person can bring it online; other work can continue."
            : "Continue without this device.",
      }
    : { code, message, next: next ?? "Continue without this device." };
}

/**
 * A data app the person approved that its device cannot serve now (a macOS permission not given
 * yet, Opensteer there needing an update): the device's own reason, as the person's device page
 * and an agent's device state say it, and that the next move is the person's, on that device.
 */
export function deviceAppUnavailable(input: {
  readonly detail: string;
  readonly app: string;
  readonly device: string;
}): Blocked {
  return {
    code: "unavailable",
    message: input.detail.slice(0, 2000),
    next: `The person finishes this on ${input.device}. Tell them what the message says, and continue without ${input.app} on ${input.device} until then.`,
  };
}

export function deviceAppBlocked(
  readiness: IntegrationReadiness | undefined,
  input: {
    name: string;
    /** The app's own title and its device's name, for the person's move on that device. */
    app: string;
    device: string;
    dataApp: string;
    computerId: string;
    readOnlyGrant: boolean;
    operation: string;
    canAsk: boolean;
    /** A connected agent: it has no task to ask for access from. */
    connection?: boolean;
  },
): Blocked | undefined {
  if (readiness?.code === "INTEGRATION_UNAVAILABLE" && readiness.detail)
    return deviceAppUnavailable({ detail: readiness.detail, app: input.app, device: input.device });
  const blocked = localTargetBlocked(
    readiness,
    input.name,
    { dataApp: input.dataApp, computerId: input.computerId },
    input.canAsk,
    input.connection,
  );
  // The person approved this data app for reading only: that is the true reason, whoever asks.
  if (blocked?.code === "access_required" && input.readOnlyGrant)
    return {
      code: "access_denied",
      message: `${input.name} allows reading only.`,
      next: input.canAsk
        ? `To ${input.operation}, call app_access_request with dataApp "${input.dataApp}", computerId "${input.computerId}" and access "read-write"; do not retry this call until it is fulfilled.`
        : "Use its read operations. The person can allow changes in the device's settings in Opensteer.",
    };
  return blocked;
}

export function localTargetBlocked(
  readiness: IntegrationReadiness | undefined,
  name: string,
  target: { dataApp: string; computerId?: string } | { server: string } = { server: name },
  canAsk = true,
  /** A connected agent: it has no task to ask for access from. */
  connection = false,
): Blocked | undefined {
  if (!readiness || readiness.code === "READY") return undefined;
  if (readiness.code === "ACCESS_GRANT_REQUIRED" && readiness.requiredAccess === null)
    throw new Error("Access-grant readiness must name its required access");
  const ownerAction =
    "dataApp" in target
      ? "Ask the person to manage this data app in the device's settings in Opensteer."
      : connection
        ? "Ask the person to review this server in Plugins in Opensteer."
        : "Ask the person to review this server in Plugins in Opensteer, or request access from a task.";
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
        next: canAsk
          ? `Call app_access_request ${JSON.stringify({ ...target, access: readiness.requiredAccess, reason: "<why you need it>" })}.`
          : ownerAction,
      };
    case "USER_AUTHORIZATION_REQUIRED":
    case "REAUTHORIZATION_REQUIRED":
      return {
        code: "setup_required",
        message: `${name} needs the person's setup or approval.`,
        next: canAsk
          ? `Call app_access_request ${JSON.stringify({ ...target, access: "read-write", reason: "<why you need it>" })}; the person can finish setup in Opensteer.`
          : ownerAction,
      };
    case "INTEGRATION_UNAVAILABLE":
      return {
        code: "unavailable",
        message: `${name} is unavailable${readiness.detail ? `: ${readiness.detail.slice(0, 240).replace(/[.!?]+$/, "")}` : ""}.`,
        next: "Continue without it and tell the person what the message says.",
      };
  }
}
