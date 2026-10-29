import { placeStatus } from "@opensteer/protocol/deployment-status";
import type {
  DeploymentAccessDeployment,
  DeploymentAccessSnapshot,
  DeploymentAccessUnavailable,
  DeploymentStatusInfo,
} from "@opensteer/protocol/desktop";
import type { IconName } from "../components/icon.js";
import { deploymentConnectionStatusInfo } from "./desktop-deployment-selection.js";

/**
 * One place in a list of places — the sidebar's menu and the full window that
 * opens when no place is open — said the same way in both.
 *
 * A row is named by what a person calls the place and described relative to
 * them: this Mac, a computer of theirs, one shared with them, Opensteer Cloud,
 * a server's address. Nothing here is a category of software.
 */
export interface PlaceRow {
  readonly current: boolean;
  readonly detail: string;
  readonly icon: IconName;
  readonly id: string;
  readonly name: string;
  /** Whether choosing the row opens the place; a row that cannot explains why. */
  readonly opens: boolean;
  /** A listing this person may drop from their list: one shared with them. */
  readonly removable: boolean;
  readonly status: DeploymentStatusInfo;
}

export interface PlaceRowContext {
  /** Deployments the Account created in Opensteer Cloud, by id. */
  readonly cloudDeploymentIds: ReadonlySet<string>;
  /** What this computer is called from itself: "This Mac" on macOS. */
  readonly thisComputer: string;
}

/**
 * Every place the snapshot lists, in the order a person looks for them: this
 * computer, their other computers, then servers, then what was added by hand.
 * A listing the Account knows about but this app could not verify stays in the
 * list with the reason, so nothing a person owns silently disappears.
 */
export function placeRows(
  snapshot: DeploymentAccessSnapshot,
  context: PlaceRowContext,
): readonly PlaceRow[] {
  const signedIn = snapshot.account.status === "signed-in";
  const ranked = snapshot.deployments.map((deployment) => ({
    rank: placeRank(deployment, context),
    row: placeRow(deployment, snapshot.selectedDeploymentId, signedIn, context),
  }));
  const listed = new Set(snapshot.deployments.map(({ id }) => id));
  for (const entry of snapshot.unavailable) {
    if (!listed.has(entry.deploymentId)) ranked.push({ rank: 9, row: unavailableRow(entry) });
  }
  return ranked
    .sort((left, right) => left.rank - right.rank || left.row.name.localeCompare(right.row.name))
    .map(({ row }) => row);
}

export function thisComputerLabel(
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  return platform.startsWith("Mac") ? "This Mac" : "This computer";
}

function placeRow(
  deployment: DeploymentAccessDeployment,
  selectedDeploymentId: string | null,
  signedIn: boolean,
  context: PlaceRowContext,
): PlaceRow {
  const current = deployment.id === selectedDeploymentId;
  const cloud = context.cloudDeploymentIds.has(deployment.id);
  return {
    current,
    detail: placeDetail(deployment, cloud, context),
    icon:
      deployment.kind === "personal"
        ? "laptop"
        : deployment.kind === "development"
          ? "code"
          : cloud
            ? "cloud"
            : "server",
    id: deployment.id,
    name: deployment.name,
    opens: current || deployment.availableActions.includes("select"),
    removable:
      deployment.source === "account" &&
      deployment.accountAccess === "member" &&
      !deployment.onThisComputer &&
      !current,
    // An Account place kept on screen through an ended sign-in says what it
    // needs — the sign-in — not the failed attempt that sign-in explains.
    status:
      deployment.source === "account" && !signedIn
        ? deployment.statusInfo
        : deploymentConnectionStatusInfo(deployment),
  };
}

function placeDetail(
  deployment: DeploymentAccessDeployment,
  cloud: boolean,
  context: PlaceRowContext,
): string {
  if (deployment.onThisComputer) return context.thisComputer;
  if (deployment.kind === "development") return "Development";
  if (deployment.accountAccess === "member") return "Shared with you";
  if (deployment.kind === "personal") {
    return deployment.source === "account" ? "Your computer" : "Computer · added here";
  }
  if (cloud) return "Opensteer Cloud";
  return originHost(deployment.canonicalOrigin);
}

function placeRank(deployment: DeploymentAccessDeployment, context: PlaceRowContext): number {
  if (deployment.onThisComputer) return 0;
  if (deployment.kind === "personal") return deployment.source === "account" ? 1 : 5;
  if (context.cloudDeploymentIds.has(deployment.id)) return 2;
  return deployment.source === "account" ? 3 : 6;
}

function unavailableRow(entry: DeploymentAccessUnavailable): PlaceRow {
  return {
    current: false,
    detail: entry.accountAccess === "member" ? "Shared with you" : "In your account",
    icon: "server",
    id: entry.deploymentId,
    name: entry.name,
    opens: false,
    removable: entry.accountAccess === "member",
    status: placeStatus.unavailable(entry.reason, entry.name),
  };
}

function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "Server";
  }
}
