import type { AgentOperationTarget } from "@opensteer/core";
import type { ApprovedComputerApp } from "@opensteer/protocol";

/**
 * The names of the Mac apps the person approved, by device and bundle id: the names the Devices
 * page and an approval ("Allow Safari?") show. An app reports that name itself, so it is shown
 * only where the person watches and nothing is decided, a task's activity and what an agent is
 * working in. A Request's question, a task's stored name and everything an agent reads keep the
 * Home's trusted name; this name is never stored or sent anywhere.
 */
export type ApprovedAppNames = ReadonlyMap<string, string>;

function appKey(deviceId: string, bundleId: string): string {
  return `${deviceId}\n${bundleId.toLowerCase()}`;
}

/** The key an approved name is held under for a Mac app target; null for any other target. */
export function approvedAppKey(target: Pick<AgentOperationTarget, "grant">): string | null {
  const { grant } = target;
  return grant.kind === "computer-app" && grant.app.kind === "mac-app"
    ? appKey(grant.deviceId, grant.app.bundleId)
    : null;
}

/** The approved Mac apps' names, from `integration.computer.apps.approved`. */
export function approvedAppNames(apps: readonly ApprovedComputerApp[]): ApprovedAppNames {
  const names = new Map<string, string>();
  for (const app of apps)
    if (app.target.kind === "app")
      names.set(appKey(app.machineId, app.target.app.bundleId), app.name);
  return names;
}

/** Whether a target is a Mac app, which the person sees by its approved name. */
export function namesMacApp(target: Pick<AgentOperationTarget, "grant">): boolean {
  return target.grant.kind === "computer-app" && target.grant.app.kind === "mac-app";
}

/**
 * A target as the person watching is shown it: a Mac app by the name they approved for that
 * device, its trusted name (the bundle id when it has no other) where no approved app matches.
 * For display only: never send or store what this returns.
 */
export function shownTarget<Target extends Pick<AgentOperationTarget, "grant" | "name">>(
  target: Target,
  names: ApprovedAppNames | null | undefined,
): Target {
  const { grant } = target;
  if (!names || grant.kind !== "computer-app" || grant.app.kind !== "mac-app") return target;
  const name = names.get(appKey(grant.deviceId, grant.app.bundleId));
  return name ? { ...target, name } : target;
}

/** Operations as the person watching is shown them: each target by `shownTarget`. */
export function shownOperations<
  Operation extends { readonly target: Pick<AgentOperationTarget, "grant" | "name"> },
>(
  operations: readonly Operation[],
  names: ApprovedAppNames | null | undefined,
): readonly Operation[] {
  if (!names?.size || !operations.some(({ target }) => namesMacApp(target))) return operations;
  return operations.map((operation) => {
    const target = shownTarget(operation.target, names);
    return target === operation.target ? operation : { ...operation, target };
  });
}
