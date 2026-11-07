import { createNavigationContainerRef } from "@react-navigation/native";
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
