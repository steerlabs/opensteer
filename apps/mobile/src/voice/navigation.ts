import type { VoiceTarget } from "@opensteer/client/voice";
import { StackActions } from "@react-navigation/native";
import { navigationRef } from "../navigation-ref.js";
import { workspaceRoute } from "../browser/surface-route.js";

export function show(deploymentId: string | null, target: VoiceTarget): void {
  if (!deploymentId || !navigationRef.isReady()) return;
  const route = navigationRef.getCurrentRoute();
  if (target.kind === "back") {
    if (navigationRef.canGoBack()) navigationRef.goBack();
    return;
  }
  if (target.kind === "chat") {
    navigationRef.dispatch(StackActions.popTo("Home", { deploymentId }));
    return;
  }
  const name = target.kind === "thread" ? "Thread" : "WorkspaceBrowser";
  const params =
    target.kind === "thread"
      ? { deploymentId, threadId: target.threadId }
      : workspaceRoute(deploymentId, target.destination);
  const current = route?.params as Record<string, unknown> | undefined;
  if (
    route?.name === name &&
    current &&
    Object.entries(params).every(([key, value]) => current[key] === value)
  )
    return;
  navigationRef.dispatch(StackActions.push(name, params));
}
