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
 * another Host's Home.
 */
const modalWorkRoutes: ReadonlySet<string> = new Set([
  "AddDeployment",
  "AddPersonal",
  "AddServer",
  "DeploymentSwitcher",
  // Joining a team from another computer selects it first; the sheet then
  // leaves for that computer's Home itself.
  "JoinTeam",
  "NotificationsIntro",
  "Settings",
]);

/** A computer's address and one-time code, waiting for the person to confirm them. */
export interface PairingOffer {
  readonly code: string;
  readonly origin: string;
}

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
 * Entering a Deployment lands on persistent Home, the composer. A link or
 * notification builds `threadRoot` instead, so its explicit destination
 * remains on top.
 */
export function deploymentRoot(deploymentId: string): InitialState {
  return {
    index: 0,
    routes: [{ name: "Home", params: { deploymentId } }],
  };
}

/**
 * A deep link keeps Home beneath its exact destination, so Back lands where
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

export function needsYouRoot(deploymentId: string): InitialState {
  return {
    index: 1,
    routes: [
      { name: "Home", params: { deploymentId } },
      { name: "NeedsYou", params: { deploymentId } },
    ],
  };
}

/** An agent's connection request, reviewed over Home so closing it lands somewhere useful. */
export function agentAuthorizationRoot(deploymentId: string, requestId: string): InitialState {
  return {
    index: 1,
    routes: [
      { name: "Home", params: { deploymentId } },
      { name: "AgentAuthorization", params: { deploymentId, requestId } },
    ],
  };
}

/** The catalog is the root only until this phone has a selected Deployment. */
export function deploymentsRoot(): InitialState {
  return { index: 0, routes: [{ name: "Deployments" }] };
}

/**
 * The first stack after storage hydrates. A pairing link opens its form over
 * whatever would have been shown, including a single computer startup opened
 * on its own, so the link is answered before anything else is.
 */
export function startupRoot(input: {
  /** A Thread or agent link's stack, which replaces the remembered one. */
  readonly destination: InitialState | null;
  readonly pairing: PairingOffer | null;
  readonly selectedDeploymentId: string | null;
}): InitialState {
  const base =
    input.destination ??
    (input.selectedDeploymentId === null
      ? deploymentsRoot()
      : deploymentRoot(input.selectedDeploymentId));
  if (input.pairing === null) return base;
  const routes = [
    ...base.routes,
    { name: "AddPersonal", params: { code: input.pairing.code, origin: input.pairing.origin } },
  ];
  return { index: routes.length - 1, routes };
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
