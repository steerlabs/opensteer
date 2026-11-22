import { homeKindWords } from "@opensteer/client/computers";
import { isNetworkedHome } from "@opensteer/client/connections";
import { hostNeedsUpdateLabel, placeStatus } from "@opensteer/protocol/deployment-status";
import type {
  DeploymentAccessDeployment,
  DeploymentAccessSnapshot,
  DeploymentAccessUnavailable,
  DeploymentStatusInfo,
} from "@opensteer/protocol/desktop";
import type { ComputerFacts } from "./computer-facts.js";
import type { IconName } from "../components/icon.js";
import { deploymentConnectionStatusInfo } from "./desktop-deployment-selection.js";

/**
 * One place in a list of places — the sidebar's menu and the full window that
 * opens when no place is open — said the same way in both.
 *
 * A row is named by what a person calls the place and described relative to
 * them: this Mac, a computer of theirs, one shared with them,
 * a server's address. Nothing here is a category of software.
 */
export interface PlaceRow {
  readonly current: boolean;
  readonly facts?: ComputerFacts | undefined;
  readonly detail: string;
  readonly icon: IconName;
  readonly id: string;
  readonly name: string;
  /** Whether choosing the row opens the place; a row that cannot explains why. */
  readonly opens: boolean;
  /** A listing this person may drop from their list: one shared with them. */
  readonly removable: boolean;
  readonly status: DeploymentStatusInfo;
  /** Too old for this app, and listed here with a route to reach it for an update. */
  readonly updatable: boolean;
  /** "Work · {organization}" when an organization pays for and governs this Home. */
  readonly work?: string | undefined;
}

export interface PlaceRowContext {
  /** What this computer is called from itself: "This Mac" on macOS. */
  readonly thisComputer: string;
  readonly facts?: ReadonlyMap<string, ComputerFacts>;
  /** Each work Home's badge, by Home. */
  readonly work?: ReadonlyMap<string, string>;
  /**
   * The Homes the Account says are Opensteer Cloud Computers, work Homes among them; null
   * while that is unknown (not read yet, the read failed, or no Account here).
   */
  readonly cloud?: ReadonlySet<string> | null;
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
    rank: placeRank(deployment),
    row: placeRow(deployment, snapshot.selectedDeploymentId, signedIn, context),
  }));
  const listed = new Set(snapshot.deployments.map(({ id }) => id));
  for (const entry of snapshot.unavailable) {
    if (!listed.has(entry.deploymentId))
      ranked.push({ rank: 9, row: unavailableRow(entry, context) });
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
  // An Account place kept on screen through an ended sign-in says what it
  // needs — the sign-in — not the failed attempt that sign-in explains.
  const status =
    deployment.source === "account" && !signedIn
      ? deployment.statusInfo
      : deploymentConnectionStatusInfo(deployment);
  const kind = homeKindOf(deployment, context);
  return {
    current,
    facts: context.facts?.get(deployment.id),
    detail:
      kind === "unknown" ? originHost(deployment.canonicalOrigin) : placeDetail(deployment, kind),
    icon: homeIcons[kind],
    id: deployment.id,
    name: deployment.name,
    opens: current || deployment.availableActions.includes("select"),
    removable:
      deployment.source === "account" &&
      deployment.accountAccess === "member" &&
      !deployment.onThisComputer &&
      !current,
    status,
    updatable: status.label === hostNeedsUpdateLabel,
    work: context.work?.get(deployment.id),
  };
}

type RowHomeKind = "mac" | "cloud" | "server" | "unknown";
const homeIcons: Readonly<Record<RowHomeKind, IconName>> = {
  mac: "laptop",
  cloud: "cloud",
  server: "server",
  unknown: "globe",
};

/**
 * What a row's Home is. A personal Home reached at its own HTTPS address is a Cloud Computer
 * when the Account lists it as one and a server of the person's otherwise; while the Account
 * cannot say, it has no kind rather than a wrong one. A Cloud Computer is never "Your
 * computer" with a laptop.
 */
function homeKindOf(
  deployment: Pick<
    DeploymentAccessDeployment,
    "canonicalOrigin" | "id" | "kind" | "onThisComputer"
  >,
  context: PlaceRowContext,
): RowHomeKind {
  if (deployment.onThisComputer) return "mac";
  if (context.cloud?.has(deployment.id) === true) return "cloud";
  const networked = isNetworkedHome({
    canonicalOrigin: deployment.canonicalOrigin,
    deploymentShape: { kind: deployment.kind },
  } as Parameters<typeof isNetworkedHome>[0]);
  if (!networked) return "mac";
  return context.cloud === null || context.cloud === undefined ? "unknown" : "server";
}

/**
 * Under the Home's own name, what kind of Home it is, in the one table of words every client
 * reads. A Home shared with this person says so instead.
 */
function placeDetail(deployment: DeploymentAccessDeployment, kind: RowHomeKind): string {
  if (deployment.onThisComputer) return homeKindWords("this-mac").label;
  if (deployment.accountAccess === "member") return "Shared with you";
  return homeKindWords(kind === "unknown" ? "unknown" : kind).label;
}

function placeRank(deployment: DeploymentAccessDeployment): number {
  if (deployment.onThisComputer) return 0;
  return deployment.source === "account" ? 1 : 5;
}

function unavailableRow(entry: DeploymentAccessUnavailable, context: PlaceRowContext): PlaceRow {
  // A Home this app cannot reach is still named what the Account says it is.
  const cloud = context.cloud?.has(entry.deploymentId) === true;
  return {
    current: false,
    detail: cloud
      ? homeKindWords("cloud").label
      : entry.accountAccess === "member"
        ? "Shared with you"
        : "In your account",
    icon: cloud ? "cloud" : "server",
    id: entry.deploymentId,
    name: entry.name,
    opens: false,
    removable: entry.accountAccess === "member",
    status: placeStatus.unavailable(entry.reason, entry.name),
    updatable: false,
  };
}

function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "Server";
  }
}
