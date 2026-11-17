import { computerForTeam, teamLinkTarget, type ApplicationLinkOutcome } from "./links.js";
import type { MobileTeams } from "./team/mobile-teams.js";
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
 * A deep link opens its task top-level, directly on Home, as the sidebar
 * would: the sidebar and every other task are one swipe away.
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

/** Builds the stack before starting any personal Host connection. Team reads are independent. */
export function applicationLinkState(
  outcome: Exclude<ApplicationLinkOutcome, { kind: "ignore" | "unknown-deployment" }>,
  ports: {
    readonly selectedDeploymentId: string | null;
    readonly select: (deploymentId: string) => Promise<void>;
    readonly teams: Pick<MobileTeams, "team" | "teamAt" | "computersIn">;
  },
): InitialState {
  let deploymentId = ports.selectedDeploymentId;
  let state: InitialState;
  if (outcome.kind === "pairing") {
    const base = deploymentId === null ? deploymentsRoot() : deploymentRoot(deploymentId);
    return {
      index: base.routes.length,
      routes: [...base.routes, { name: "AddPersonal", params: outcome.offer }],
    };
  }
  if (outcome.kind === "team" || outcome.kind === "team-notice") {
    const team =
      outcome.kind === "team-notice"
        ? ports.teams.team(outcome.teamId)
        : ports.teams.teamAt(outcome.origin);
    const target = teamLinkTarget(outcome, team);
    const move =
      team === null
        ? null
        : computerForTeam({
            shown: deploymentId,
            computersInTeam: ports.teams.computersIn(team.teamId),
          });
    deploymentId = move ?? deploymentId;
    const base = deploymentId === null ? deploymentsRoot() : deploymentRoot(deploymentId);
    state = { index: base.routes.length, routes: [...base.routes, target] };
    if (move === null) return state;
  } else {
    deploymentId = outcome.deploymentId;
    state =
      outcome.kind === "authorize-agent"
        ? agentAuthorizationRoot(deploymentId, outcome.requestId)
        : outcome.kind === "needs-you"
          ? needsYouRoot(deploymentId)
          : threadRoot({
              deploymentId,
              threadId: outcome.threadId,
              ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }),
              ...(outcome.requestId === null ? {} : { requestId: outcome.requestId }),
            });
  }
  // The destination's gate shows connection failures; a dead Host cannot delay navigation.
  if (deploymentId !== null) void ports.select(deploymentId).catch(() => undefined);
  return state;
}
