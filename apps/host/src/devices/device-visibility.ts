import type { AgentGrant } from "@opensteer/core";

/**
 * The Devices a caller may learn of, by the rule the Device listings apply: a
 * `selected` grant knows only the Devices its apps and phone screens name;
 * anyone else, the person's own tasks among them, knows the person's Devices.
 */
export function deviceVisibleTo(grant: AgentGrant | undefined): (deviceId: string) => boolean {
  if (grant?.scope !== "selected") return () => true;
  const devices = new Set<string>(
    grant.resources.flatMap((resource) =>
      resource.kind === "computer-app" ? [resource.deviceId] : [],
    ),
  );
  return (deviceId) => devices.has(deviceId);
}
