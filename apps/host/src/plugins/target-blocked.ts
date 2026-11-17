import type { Blocked } from "@opensteer/core";

export function pluginTargetBlocked(input: {
  id: string;
  name: string;
  reason: string;
  requirements: Readonly<Record<string, { scope: "app" | "user" }>>;
  canRequestAccount?: boolean;
  links: readonly { requirement: string; scope: "app" | "user" }[];
}): Blocked {
  const missing = Object.entries(input.requirements).filter(
    ([requirement, { scope }]) =>
      !input.links.some((link) => link.requirement === requirement && link.scope === scope),
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
