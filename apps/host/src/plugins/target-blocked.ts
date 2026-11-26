import type { EngineAccountMetadata } from "./engine-protocol.js";
import type { Blocked } from "@opensteer/core";

export function pluginTargetBlocked(input: {
  id: string;
  name: string;
  reason: string;
  requirements: Readonly<Record<string, { scope: "app" | "user" }>>;
  canRequestAccount?: boolean;
  /** A connected agent, which finds plugins with `discover` and never asks for an account. */
  connection?: boolean;
  readiness: EngineAccountMetadata["readiness"];
}): Blocked {
  if (Object.values(input.readiness).some(({ state }) => state === "consent-needs-review"))
    return {
      code: "sign_in_required",
      message: `${input.name} needs its account link reviewed.`,
      next: "The person can review the changed account link in Plugins. Continue without this plugin until it is reviewed.",
    };
  const missing = Object.entries(input.requirements).filter(
    ([requirement]) => input.readiness[requirement]?.state === "required-but-missing",
  );
  return missing.length
    ? {
        code: "sign_in_required",
        message: `${input.name} needs a connected account.`,
        next:
          input.connection === true
            ? "The person can connect or link this account in Plugins. Continue without this plugin until it is connected."
            : input.canRequestAccount === false
              ? "The person can connect or link this account in Plugins. Only a task Run can ask with plugin_account_request; continue without this plugin until it is connected."
              : missing
                  .map(
                    ([requirement, { scope }]) =>
                      `Call plugin_account_request ${JSON.stringify({ pluginId: input.id, requirement, scope, reason: "<why you need it>" })}.`,
                  )
                  .join(" ")
                  .slice(0, 2000),
      }
    : {
        code: "unavailable",
        message: input.reason.slice(0, 2000),
        next: "Continue without this plugin and tell the person what the message says. The person can check its setup in Plugins.",
      };
}

export function pluginAccessBlocked(
  access: "all" | "off" | "read-only" | undefined,
  write: boolean,
): Blocked | undefined {
  if (access !== "off" && !(access === "read-only" && write)) return undefined;
  return {
    code: "access_denied",
    message:
      access === "off" ? "This plugin is Off for agents." : "This plugin is set to Read-only.",
    next: "The person can change this plugin’s access in Plugins. Continue with the tools you can use.",
  };
}

/** A tool outside a connection's grant: read as absent wherever it is listed or called. */
export const outsideGrant: Blocked = {
  code: "access_required",
  message: "Plugin tool is unavailable to this caller.",
  next: "Continue with the tools you can use.",
};

/**
 * Why a plugin tool cannot be called now: the one order every listing (projectTool), every call
 * (callTool) and a connected agent's own path read it in, so a listing never says one reason and
 * the call another.
 * 1. A tool the connection's grant does not hold (a write in an app it holds for reading): outside
 *    the grant, read as absent (`outsideGrant`).
 * 2. The person's own setting for the plugin: Off, or Read-only for a change. The app is in the
 *    grant, so saying it is no leak.
 * 3. For a local provider, its operation's own reason, in the order LocalProviders gives it: the
 *    device's own refusal (its Apps switch, offline, asleep, stopped), then the app's state there
 *    (a permission missing, its helper not running), then the approval's read-only, then the
 *    task's mode.
 */
export function pluginToolReason(input: {
  readonly tool: string;
  readonly write: boolean;
  readonly outsideGrant: boolean;
  readonly setting: "all" | "read-only" | "off" | undefined;
  readonly local?: {
    readonly blocked?: Blocked | undefined;
    readonly toolBlockers?: Readonly<Record<string, Blocked>> | undefined;
  };
}): Blocked | undefined {
  if (input.outsideGrant) return outsideGrant;
  return (
    pluginAccessBlocked(input.setting, input.write) ??
    input.local?.toolBlockers?.[input.tool] ??
    input.local?.blocked
  );
}
