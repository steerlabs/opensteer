import { placeDestinationEnded, type HostSnapshot } from "@opensteer/client/host";
import { isRecord } from "@opensteer/shared/isRecord";
import { paramsDestination } from "./browser/surface-route.js";

/** List absence, initial bootstrap and failed reads never establish deletion. */
export function personalRouteInvalid(
  route: { readonly name: string; readonly params?: object | undefined },
  snapshot: HostSnapshot,
): boolean {
  const params = isRecord(route.params) ? route.params : {};
  if (params["deploymentId"] !== snapshot.deploymentId) return false;
  if (route.name === "Thread" && typeof params["threadId"] === "string")
    return snapshot.threadLookups[params["threadId"]] === "missing";
  if (
    route.name !== "WorkspaceBrowser" ||
    snapshot.connection !== "connected" ||
    snapshot.session !== "authenticated" ||
    snapshot.can === null
  )
    return false;
  const destination = paramsDestination(params);
  if (destination === null) return false;
  if (destination.kind === "browser") {
    const group = snapshot.browserTabs?.groupForSession(destination.sessionId);
    if (group === undefined || !snapshot.browserTabs?.tabs(group).whole) return false;
  } else if (destination.kind === "opensteer-app") {
    if (snapshot.appTabs === undefined) return false;
  } else {
    const machine = snapshot.machines.find((row) => row.id === destination.machineId);
    if (machine === undefined || (destination.kind === "app" && !machine.computerUse)) return false;
    if (
      destination.kind === "app" &&
      destination.source?.kind === "owner-view" &&
      machine.computerUse?.ownerViews === undefined
    )
      return false;
  }
  return placeDestinationEnded(snapshot, destination);
}
