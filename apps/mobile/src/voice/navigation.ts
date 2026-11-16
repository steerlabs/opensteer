import type { TabId } from "@opensteer/core";
import { CommonActions, StackActions } from "@react-navigation/native";
import { enterSide, navigationRef } from "../navigation-ref.js";
import { routeSide } from "../side-memory.js";
import { paramsTabId, tabRoute } from "../browser/surface-route.js";

/** What a Run's show or the voice call brings into view: a task, or exactly one tab. */
export type ShowTarget =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "tab"; readonly tabId: TabId };

/** The route naming the conversation here: the one on screen, or beneath the places over it. */
export function conversationRoute() {
  const route = navigationRef.getCurrentRoute();
  if (route?.name !== "WorkspaceBrowser") return route;
  return navigationRef.getRootState()?.routes.findLast(({ name }) => name !== "WorkspaceBrowser");
}

export function show(deploymentId: string | null, target: ShowTarget): boolean {
  if (!deploymentId || !navigationRef.isReady()) return false;
  const route = navigationRef.getCurrentRoute();
  const current = route?.params as Record<string, unknown> | undefined;
  if (
    target.kind === "tab" &&
    route?.name === "WorkspaceBrowser" &&
    current?.["deploymentId"] === deploymentId
  ) {
    if (paramsTabId(current) === target.tabId) return false;
    // The tab in front changes in place; where it was opened from stays.
    navigationRef.dispatch({
      ...CommonActions.setParams({ editAddress: false, popup: false, tabId: target.tabId }),
      source: route.key,
    });
    return true;
  }
  const name = target.kind === "thread" ? "Thread" : "WorkspaceBrowser";
  const params =
    target.kind === "thread"
      ? { deploymentId, threadId: target.threadId }
      : tabRoute(deploymentId, target.tabId);
  if (
    route?.name === name &&
    current &&
    Object.entries(params).every(([key, value]) => current[key] === value)
  )
    return false;
  // Within Tasks the shown screen goes over the task, so Back returns to it.
  if (routeSide(navigationRef.getRootState()?.routes[1]) === "tasks") {
    navigationRef.dispatch(StackActions.push(name, params));
    return true;
  }
  return enterSide({ name, params });
}
