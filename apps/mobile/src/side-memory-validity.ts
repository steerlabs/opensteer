import type { LegacyHostSnapshot as HostSnapshot } from "@opensteer/client/host";
import { isRecord } from "@opensteer/shared/isRecord";
import { paramsTabId } from "./browser/surface-route.js";
import { selectTabs } from "./tabs/tabs-host.js";

/**
 * List absence, initial bootstrap and failed reads never establish deletion: a
 * tab route is gone only when the connected Host's complete list lacks its tab.
 */
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
  const tabId = paramsTabId(params);
  const tabs = selectTabs(snapshot);
  if (tabId === null || tabs === null || tabs.syncing || !tabs.complete) return false;
  return tabs.get(tabId) === undefined;
}
