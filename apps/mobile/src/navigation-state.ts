import type { InitialState } from "@react-navigation/native";

export interface ThreadDestination {
  readonly deploymentId: string;
  /** The exact update a notification or link is about, when it names one. */
  readonly messageId?: string;
  readonly requestId?: string;
  readonly threadId: string;
}

/**
 * Routes whose work may finish before a selection change moves the root.
 * `ThreadSettings` and `NewThread` are deliberately absent: each belongs to
 * work on one Deployment, so when the Deployment changes underneath it the
 * sheet has nothing left to change, and deferring would leave it standing over
 * another Host's Chat.
 */
const modalWorkRoutes: ReadonlySet<string> = new Set([
  "AddDeployment",
  "AddPersonal",
  "AddServer",
  "DeploymentSwitcher",
  "Settings",
]);

/**
 * A linked Thread is already the intended root while its Deployment selection
 * catches up. Only that matching publication may resume normal reconciliation;
 * an older remembered selection must not replace the destination stack.
 */
export function selectionMayReconcileLinkedRoot(input: {
  readonly linkedDeploymentId: string | null;
  readonly selectionDeploymentId: string | null;
}): boolean {
  return (
    input.linkedDeploymentId === null || input.linkedDeploymentId === input.selectionDeploymentId
  );
}

/** A failed link may release its protected root only while it is still newest. */
export function linkedSelectionFailureIsCurrent(input: {
  readonly currentAttempt: number;
  readonly failedAttempt: number;
  readonly failedDeploymentId: string;
  readonly linkedDeploymentId: string | null;
}): boolean {
  return (
    input.currentAttempt === input.failedAttempt &&
    input.linkedDeploymentId === input.failedDeploymentId
  );
}

/**
 * What a newly published client selection means for the visible root.
 *
 * Modal work is allowed to finish or dismiss before it moves. A selection
 * change replaces a catalog root or another Deployment's root; a settled
 * matching root needs no navigation action.
 */
export function selectionRootTransition(input: {
  readonly activeRouteName: string | null;
  readonly baseDeploymentId: string | null;
  readonly baseRouteName: string | null;
  readonly deploymentId: string | null;
}): "defer" | InitialState | null {
  if (input.activeRouteName !== null && modalWorkRoutes.has(input.activeRouteName)) return "defer";
  if (input.deploymentId === null) {
    return input.baseRouteName === "Home" ? deploymentsRoot() : null;
  }
  if (
    input.baseRouteName === "Deployments" ||
    (input.baseRouteName === "Home" && input.baseDeploymentId !== input.deploymentId)
  ) {
    return deploymentRoot(input.deploymentId);
  }
  return null;
}

/**
 * The root stack is rebuilt whenever its Deployment changes. A route that
 * belongs to one Host must never sit behind a route for another Host: the
 * destination replaces the old stack as the client releases that attachment.
 *
 * Entering a Deployment lands on persistent Home. It renders Chat or the
 * first-message intro once the Host answers. A link or notification builds
 * `threadRoot` instead, so its explicit destination remains on top.
 */
export function deploymentRoot(deploymentId: string): InitialState {
  return {
    index: 0,
    routes: [{ name: "Home", params: { deploymentId } }],
  };
}

/**
 * A deep link keeps Chat beneath its exact destination, so Back lands where
 * the sidebar, and with it every other task, is one tap away.
 */
export function threadRoot(destination: ThreadDestination): InitialState {
  return {
    index: 1,
    routes: [
      { name: "Home", params: { deploymentId: destination.deploymentId } },
      { name: "Thread", params: destination },
    ],
  };
}

/** The catalog is the root only until this phone has a selected Deployment. */
export function deploymentsRoot(): InitialState {
  return { index: 0, routes: [{ name: "Deployments" }] };
}

/**
 * How a sheet over a Deployment's work reaches one of its Threads: back to it
 * when it is the Thread already beneath, and otherwise back to the screen
 * beneath the sheets and forward to it, so no Thread is ever pushed over a
 * sheet.
 */
export function threadReturn(
  routes: readonly { readonly name: string; readonly params?: object | undefined }[],
  destination: ThreadDestination,
): "pop-to" | "push-from-top" {
  const below = routes.findLast((route) => route.name === "Thread");
  const params = below?.params as Partial<ThreadDestination> | undefined;
  return params?.deploymentId === destination.deploymentId &&
    params.threadId === destination.threadId
    ? "pop-to"
    : "push-from-top";
}
