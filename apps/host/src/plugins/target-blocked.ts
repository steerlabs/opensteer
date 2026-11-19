import type { EngineAccountMetadata } from "./engine-protocol.js";
import type { Blocked } from "@opensteer/core";

export function pluginTargetBlocked(input: {
  id: string;
  name: string;
  reason: string;
  requirements: Readonly<Record<string, { scope: "app" | "user" }>>;
  canRequestAccount?: boolean;
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
          input.canRequestAccount === false
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

/**
 * A plugin that is not served until it is rebuilt for this version of Opensteer: nothing of it
 * ran, and the same call succeeds once the rebuild finishes.
 */
export function pluginUpdatingBlocked(
  name: string,
  reason: string | undefined,
): Blocked | undefined {
  if (reason === undefined) return undefined;
  return {
    code: "plugin_updating",
    message:
      `${name} is updating for this version of Opensteer, so nothing was sent to it. ${reason}`.slice(
        0,
        2000,
      ),
    next: "Try the same call again in a minute; it was not run. The person can see the update in Plugins.",
  };
}

/** A call whose selected build may not run, answered unsent (see `DispatchRefusal`). */
export function refusalBlocked(
  name: string,
  refusal: { readonly kind: "updating"; readonly reason: string } | { readonly kind: "stale" },
): Blocked {
  return refusal.kind === "updating"
    ? pluginUpdatingBlocked(name, refusal.reason)!
    : {
        code: "unavailable",
        message:
          `${name} changed after this was saved, and the version it was saved for no longer runs, so nothing was sent to it.`.slice(
            0,
            2000,
          ),
        next: "Discover the plugin's tools again and make the call again.",
      };
}
