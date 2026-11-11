import type { VoiceTarget } from "@opensteer/client/voice";
import { CommonActions, StackActions } from "@react-navigation/native";
import { navigationRef } from "../navigation-ref.js";
import { paramsDestination, sameDestination, tabsRoute } from "../browser/surface-route.js";

/** The route naming the conversation here: the one on screen, or beneath the places over it. */
export function conversationRoute() {
  const route = navigationRef.getCurrentRoute();
  if (route?.name !== "WorkspaceBrowser") return route;
  return navigationRef.getRootState()?.routes.findLast(({ name }) => name !== "WorkspaceBrowser");
}

export function show(deploymentId: string | null, target: VoiceTarget): boolean {
  if (!deploymentId || !navigationRef.isReady()) return false;
  const route = navigationRef.getCurrentRoute();
  if (target.kind === "chat") {
    if (
      route?.name === "Home" &&
      (route.params as { deploymentId?: string } | undefined)?.deploymentId === deploymentId
    )
      return false;
    navigationRef.dispatch(StackActions.popTo("Home", { deploymentId }));
    return true;
  }
  const current = route?.params as Record<string, unknown> | undefined;
  if (
    target.kind === "place" &&
    route?.name === "WorkspaceBrowser" &&
    current?.["deploymentId"] === deploymentId
  ) {
    if (sameDestination(paramsDestination(current), target.destination)) return false;
    const { scope: _scope, ...destination } = tabsRoute(deploymentId, target.destination);
    navigationRef.dispatch({
      ...CommonActions.setParams({
        appId: undefined,
        appKey: undefined,
        computerSessionId: undefined,
        editAddress: false,
        generation: undefined,
        machineId: undefined,
        pendingBrowserTab: undefined,
        phone: undefined,
        popup: false,
        sessionId: undefined,
        tabId: undefined,
        viewId: undefined,
        windowId: undefined,
        ...destination,
      }),
      source: route.key,
    });
    return true;
  }
  const name = target.kind === "thread" ? "Thread" : "WorkspaceBrowser";
  const params =
    target.kind === "thread"
      ? { deploymentId, threadId: target.threadId }
      : tabsRoute(deploymentId, target.destination);
  if (
    route?.name === name &&
    current &&
    Object.entries(params).every(([key, value]) => current[key] === value)
  )
    return false;
  navigationRef.dispatch(StackActions.push(name, params));
  return true;
}
