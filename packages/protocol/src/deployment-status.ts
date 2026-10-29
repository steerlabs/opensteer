import type { DeploymentDisplayKind } from "@opensteer/core";
import type {
  DeploymentStatus,
  DeploymentStatusInfo,
  DesktopDeploymentUnavailableReason,
  DesktopPersonalDeploymentStatus,
} from "./desktop.js";

/**
 * The one status vocabulary every Directory renders — the Desktop deployment
 * list, the settings surfaces, and the Cloud portal alike. A Deployment's
 * status is *derived* by whichever authority owns it (the Desktop access
 * machine, the local Personal stack, the control plane), but what that status
 * *says* to a person is defined exactly once, here, so the same place never
 * reads differently in two Directories.
 *
 * Five words, no more: a place is ready, is on its way, is being checked,
 * wants something from you, or is not there. Anything more specific belongs in
 * the one-sentence `reason` beside it, and in a short `label` only when the
 * status word alone would leave a person guessing what to do.
 */
export type { DeploymentStatus, DeploymentStatusInfo };

export type DeploymentStatusTone = "busy" | "muted" | "ok" | "warn";

const statusLabels: Readonly<Record<DeploymentStatus, string>> = {
  attention: "Needs attention",
  checking: "Checking…",
  offline: "Offline",
  ready: "Ready",
  starting: "Starting",
};

const statusTones: Readonly<Record<DeploymentStatus, DeploymentStatusTone>> = {
  attention: "warn",
  checking: "busy",
  offline: "muted",
  ready: "ok",
  starting: "busy",
};

/** The word itself. Every surface that shows a status shows one of these five. */
export function deploymentStatusLabel(status: DeploymentStatus): string {
  return statusLabels[status];
}

/** The short words a status chip shows: the condition when one is named. */
export function deploymentStatusInfoLabel(info: DeploymentStatusInfo): string {
  return info.label ?? statusLabels[info.status];
}

/** Which of the four dot colors a status wears. */
export function deploymentStatusTone(status: DeploymentStatus): DeploymentStatusTone {
  return statusTones[status];
}

/**
 * Whether opening the place could do anything but fail. An offline entry is an
 * explanation, not a dead link: the repair lives on the computer that owns it.
 */
export function deploymentStatusSelectable(status: DeploymentStatus): boolean {
  return status !== "offline";
}

/**
 * One naming of what a Deployment *is*, shared by every surface that has to say
 * it: the Door, the first-run chooser, the Desktop directory, the deployment
 * panel, Settings, and the Account portal. Every display kind is covered
 * here, so no surface has to invent a label for the one it did not expect.
 */
export function deploymentKindLabel(kind: DeploymentDisplayKind): string {
  if (kind === "development") return "Development";
  if (kind === "personal") return "Personal";
  return "Server";
}

/**
 * One sentence per reason a listed Deployment could not be reached, in the same
 * voice as the status reasons above: what happened, and the one thing the
 * person can do about it.
 */
export function deploymentUnavailableReasonExplanation(
  reason: DesktopDeploymentUnavailableReason,
): string {
  if (reason === "client-too-old") return "Update this app to connect to this Opensteer.";
  if (reason === "host-too-old") return "This Opensteer needs updating to work with this app.";
  if (reason === "host-unavailable") return "This deployment did not answer.";
  if (reason === "identity-mismatch") {
    return "This deployment did not match the identity your Account has on file. The deployment refreshes that record the next time it starts.";
  }
  return "This deployment is no longer active.";
}

/**
 * What a list of places says about one place on another computer or server,
 * each sentence naming the place and the one thing a person can do. These are
 * the only words the Desktop's place list uses for a place that is not here.
 */
export const placeStatus = {
  /** A check is under way, and nothing is claimed until it answers. */
  checking: (): DeploymentStatusInfo => ({ reason: null, status: "checking" }),
  /** The check itself failed, so nothing is known about the place. */
  couldNotCheck: (): DeploymentStatusInfo => ({
    label: "Couldn’t check",
    reason:
      "Opensteer couldn’t check this just now. Check your internet connection, then try again.",
    status: "attention",
  }),
  notResponding: (name: string): DeploymentStatusInfo => ({
    label: "Not responding",
    reason: `${name} didn’t answer just now. Make sure it’s on and reachable, then try again.`,
    status: "attention",
  }),
  /**
   * This computer has no network, which says nothing about the other place —
   * and a place on a private network may still answer, so it stays openable.
   */
  noInternet: (): DeploymentStatusInfo => ({
    label: "You’re offline",
    reason: "This computer isn’t connected to the internet.",
    status: "attention",
  }),
  ready: (): DeploymentStatusInfo => ({ reason: null, status: "ready" }),
  /** The other computer is asleep or has Opensteer closed: its lease lapsed. */
  asleep: (name: string): DeploymentStatusInfo => ({
    reason: `${name} is asleep, or Opensteer isn’t open on it. Wake it up and open Opensteer, then check again.`,
    status: "offline",
  }),
  /** Listed, but the computer that runs it does not let other devices in. */
  remoteAccessOff: (name: string): DeploymentStatusInfo => ({
    label: "Remote access off",
    reason: `Remote access is off on ${name}. Turn it on there in Settings › Remote access.`,
    status: "offline",
  }),
  /** The sign-in it waits on is open in the browser. */
  signingIn: (name: string): DeploymentStatusInfo => ({
    label: "Signing in…",
    reason: `Finish signing in in your browser to keep using ${name}.`,
    status: "starting",
  }),
  /** Kept on screen through an expired sign-in, so a person is never moved. */
  signInAgain: (name: string): DeploymentStatusInfo => ({
    label: "Sign in again",
    reason: `Sign in again to keep using ${name}.`,
    status: "attention",
  }),
  /** Why a place that was checked could not be used, by what the check found. */
  unavailable: (reason: DesktopDeploymentUnavailableReason, name: string): DeploymentStatusInfo => {
    if (reason === "host-too-old") {
      return {
        label: "Needs update",
        reason: `${name} needs an Opensteer update to work with this app.`,
        status: "attention",
      };
    }
    if (reason === "client-too-old") {
      return {
        label: "Update this app",
        reason: `Update this app to open ${name}.`,
        status: "attention",
      };
    }
    if (reason === "identity-mismatch") {
      return {
        label: "Can’t verify",
        reason: `Something other than ${name} answered at its address.`,
        status: "attention",
      };
    }
    if (reason === "not-active") {
      return { reason: `${name} is no longer active.`, status: "offline" };
    }
    return { reason: `${name} can’t be reached right now.`, status: "offline" };
  },
} as const;

/**
 * The projection from the Personal stack running on this computer. A stack that
 * needs attention carries the supervisor's own issue detail, because that
 * sentence names the component and the repair; the generic line is only for the
 * case where the stack reports trouble without saying which.
 */
export function deploymentStatusFromPersonalStack(
  personal: DesktopPersonalDeploymentStatus,
): DeploymentStatusInfo {
  const { state } = personal;
  if (state === "ready") return { reason: null, status: "ready" };
  if (state === "checking" || state === "starting") return { reason: null, status: "starting" };
  if (state === "degraded" || state === "repair-required" || state === "update-required") {
    return {
      reason: personal.issue?.detail ?? "Opensteer needs attention on this computer.",
      status: "attention",
    };
  }
  return { reason: null, status: "offline" };
}

/**
 * The facts a Personal Deployment reached through Opensteer Connect is judged
 * on, in the shape both authorities already hold: the Account directory record
 * (a signed Connect route plus a liveness observation) and the Desktop catalog
 * (a verified Account route plus the same observation's expiry).
 */
interface PersonalConnectReachability {
  /** A signed Connect route exists — remote access is on for this Deployment. */
  readonly hasConnectRoute: boolean;
  /** When the last liveness observation stops counting, ISO 8601, or null. */
  readonly livenessExpiresAt: string | null;
}

/**
 * THE single derivation of "this Personal Deployment is reachable through
 * Connect right now". Both the Cloud portal and the Desktop directory answer
 * with this function, so the same computer is never ready in one Directory and
 * offline in the other.
 */
export function deploymentStatusFromPersonalConnect(
  reachability: PersonalConnectReachability,
  now: Date = new Date(),
): DeploymentStatusInfo {
  if (!reachability.hasConnectRoute) {
    return {
      reason: "Remote access is off on the computer that runs this deployment.",
      status: "offline",
    };
  }
  const { livenessExpiresAt } = reachability;
  if (livenessExpiresAt === null || Date.parse(livenessExpiresAt) <= now.getTime()) {
    return { reason: "That computer is offline.", status: "offline" };
  }
  return { reason: null, status: "ready" };
}

interface AccountDirectoryDeploymentStatus {
  /** Whether this Account still grants the person access to the Deployment. */
  readonly present: boolean;
  /** Whether this client can validate the published signed connection material. */
  readonly compatible: boolean;
  readonly reachability: "canonical" | "routed";
  readonly hasConnectRoute?: boolean;
  readonly livenessExpiresAt?: string | null;
}

/**
 * The status an Account directory may honestly derive from its stored facts.
 * Membership proves authorization, not that a network Host answered. A routed
 * Personal Deployment has the additional bounded liveness lease needed to say
 * "Ready". A canonical Deployment has no health observation in this directory,
 * so it has no status to project. Null means no observation, not a default
 * "Ready" or "Needs attention" verdict for a renderer to supply.
 */
export function deploymentStatusFromAccountDirectory(
  deployment: AccountDirectoryDeploymentStatus,
  now: Date = new Date(),
): DeploymentStatusInfo | null {
  if (!deployment.present) {
    return {
      reason: "You no longer have access to this deployment.",
      status: "offline",
    };
  }
  if (!deployment.compatible) {
    return {
      reason: "Update Opensteer to use this deployment’s published connection details.",
      status: "attention",
    };
  }
  if (deployment.reachability === "routed") {
    return deploymentStatusFromPersonalConnect(
      {
        hasConnectRoute: deployment.hasConnectRoute === true,
        livenessExpiresAt: deployment.livenessExpiresAt ?? null,
      },
      now,
    );
  }
  return null;
}
