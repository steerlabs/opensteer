import { StackActions, createNavigationContainerRef } from "@react-navigation/native";
import type { RootParamList } from "./navigation.js";
import { deploymentRoot, deploymentsRoot } from "./navigation-state.js";

/**
 * The one handle the app root has on navigation. A deep link and a
 * notification arrive outside React's tree, so the only correct way to answer
 * them is a reference to the container that is already mounted.
 */
export const navigationRef = createNavigationContainerRef<RootParamList>();

export function resetToDeployments(): void {
  if (navigationRef.isReady()) navigationRef.resetRoot(deploymentsRoot());
}

export function resetToDeployment(deploymentId: string): void {
  if (navigationRef.isReady()) navigationRef.resetRoot(deploymentRoot(deploymentId));
}

/** Opens a subagent's own view over whatever is in front, from outside a screen's tree. */
export function pushSubagent(params: RootParamList["Subagent"]): void {
  if (navigationRef.isReady()) navigationRef.dispatch(StackActions.push("Subagent", params));
}
