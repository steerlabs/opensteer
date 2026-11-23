import {
  StackActions,
  createNavigationContainerRef,
  type InitialState,
} from "@react-navigation/native";
import type { RootParamList } from "./navigation.js";
import type { PendingDestination } from "./pending-destination.js";
import { sideMemory } from "./side-memory.js";
import type { TopLevelTarget } from "./top-level.js";
import { deploymentRoot, deploymentsRoot, selectionRootTransition } from "./navigation-state.js";

/**
 * The one handle the app root has on navigation. A deep link and a
 * notification arrive outside React's tree, so the only correct way to answer
 * them is a reference to the container that is already mounted.
 */
export const navigationRef = createNavigationContainerRef<RootParamList>();

type SingleRouteTarget = `Home:${string}` | "Deployments";

function singleRouteTarget(state: {
  readonly index?: number;
  readonly routes: readonly { readonly name: string; readonly params?: object | undefined }[];
}): SingleRouteTarget | null {
  if (state.routes.length !== 1 || (state.index ?? 0) !== 0) return null;
  const route = state.routes[0];
  if (route === undefined) return null;
  if (route.name === "Deployments") return "Deployments";
  if (
    route.name === "Home" &&
    route.params !== undefined &&
    "deploymentId" in route.params &&
    typeof route.params.deploymentId === "string"
  ) {
    return `Home:${route.params.deploymentId}`;
  }
  return null;
}

function stateSignature(state: {
  readonly index: number;
  readonly routes: readonly { readonly key: string; readonly name: string }[];
}): string {
  return `${state.index}:${state.routes.map((route) => `${route.key}/${route.name}`).join(",")}`;
}

let pendingRoot: { readonly from: string; readonly target: SingleRouteTarget } | null = null;

/**
 * Replaces the root stack, ignoring a back-to-back reset to the same single-route
 * root (for example, the root selection observer and a screen's own subscriber
 * reacting to the same selection publish before React Navigation commits the first reset).
 */
export function resetRoot(state: InitialState): void {
  if (!navigationRef.isReady()) return;
  const target = singleRouteTarget(state);
  const current = navigationRef.getRootState();
  if (target !== null && current !== undefined) {
    if (singleRouteTarget(current) === target) {
      pendingRoot = null;
      return;
    }
    const from = stateSignature(current);
    if (pendingRoot !== null && pendingRoot.from === from && pendingRoot.target === target) {
      return;
    }
    pendingRoot = { from, target };
  } else {
    pendingRoot = null;
  }
  navigationRef.resetRoot(state);
}

/** Moves the root stack when the client's published selection changes, outside deferred modals. */
export function reconcileRootSelection(input: {
  readonly destinations: Pick<PendingDestination, "reconciled" | "selectionToReconcile">;
  readonly selection: { readonly deploymentId: string | null; readonly status: string };
}): void {
  const { destinations, selection } = input;
  if (
    selection.status !== "ready" ||
    !navigationRef.isReady() ||
    !destinations.selectionToReconcile(selection.deploymentId)
  )
    return;
  const state = navigationRef.getRootState();
  if (state === undefined) return;
  const base = state.routes[0];
  const baseId = base?.params && "deploymentId" in base.params ? base.params.deploymentId : null;
  const transition = selectionRootTransition({
    activeRouteName: state.routes[state.index]?.name ?? null,
    baseDeploymentId: typeof baseId === "string" ? baseId : null,
    baseRouteName: base?.name ?? null,
    deploymentId: selection.deploymentId,
  });
  if (transition === "defer") return;
  destinations.reconciled(selection.deploymentId);
  if (transition !== null) resetRoot(transition);
}

export function resetToDeployments(): void {
  resetRoot(deploymentsRoot());
}

export function resetToDeployment(deploymentId: string): void {
  resetRoot(deploymentRoot(deploymentId));
}

/** Opens a subagent's own view over whatever is in front, from outside a screen's tree. */
export function pushSubagent(params: RootParamList["Subagent"]): void {
  if (!navigationRef.isReady()) return;
  pendingRoot = null;
  navigationRef.dispatch(StackActions.push("Subagent", params));
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
    pendingRoot = null;
    navigationRef.dispatch(StackActions.push(target.name, target.params));
    return true;
  }
  const action = sideMemory.enter(state, target);
  if (action === null) return false;
  pendingRoot = null;
  navigationRef.dispatch(action);
  return true;
}
