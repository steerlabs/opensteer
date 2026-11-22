import { StackActions, createNavigationContainerRef } from "@react-navigation/native";
import type { RootParamList } from "./navigation.js";
import { sideMemory } from "./side-memory.js";
import type { TopLevelTarget } from "./top-level.js";
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

/** Links, notifications and Voice share the root entry. */
export function enterSide(target: TopLevelTarget): boolean {
  if (!navigationRef.isReady()) return false;
  let state = navigationRef.getRootState();
  if (state === undefined) return false;
  const deploymentId = "deploymentId" in target.params ? target.params.deploymentId : undefined;
  const home = state.routes[0];
  const currentDeployment =
    home?.params && "deploymentId" in home.params ? home.params.deploymentId : null;
  if (typeof deploymentId === "string" && currentDeployment !== deploymentId) {
    state = {
      ...state,
      index: 0,
      routes: [{ key: `Home:${deploymentId}`, name: "Home", params: { deploymentId } }],
    };
  }
  if (state.routes[0]?.name !== "Home") {
    navigationRef.dispatch(StackActions.push(target.name, target.params));
    return true;
  }
  const action = sideMemory.enter(state, target);
  if (action === null) return false;
  navigationRef.dispatch(action);
  return true;
}
