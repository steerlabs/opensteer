import { describeConnectionAccess, type DeploymentConnection } from "@opensteer/client/connections";
import type { HostSessionExchangeFailure } from "@opensteer/client/auth";
import type { DeploymentId } from "@opensteer/core";

/**
 * What the live attachment is doing. Only the one Deployment this phone is
 * attached to has one — every other row is a credential and an address, and
 * saying anything about a socket that was never opened would be an invention.
 */
export type DeploymentAttachment = "connected" | "connecting" | "offline" | "reconnecting";

/**
 * What a live verification of the route this phone would actually use found.
 *
 * The two version arms are the vocabulary the verification itself uses, and
 * they are kept apart because they name different repairs: one person updates
 * the deployment, the other updates the app. `identity-mismatch` is neither —
 * it means the address answered as some other Host — and is worth its own word
 * because treating it as "unknown" is how a route that leads somewhere else
 * goes unnoticed. A Host that could not be reached at all produces no
 * verification: that is a connection state, not a verdict.
 */
export type HostVerification = "client-too-old" | "host-too-old" | "identity-mismatch";

/**
 * What a row on the Deployments screen says.
 *
 * Every word is something observed. `connected` and the three states beside it
 * come from the socket that is open; `signed-in` says only what it says — a
 * credential is held and usable — because a credential in protected storage is
 * not a connection and calling it one is the difference between a row a person
 * can trust and one they learn to ignore.
 */
export type DeploymentStatus =
  | DeploymentAttachment
  | "needs-sign-in"
  | "signed-in"
  | "unavailable"
  | "unverified"
  | "update-required";

/**
 * The door a Deployment that needs a credential opens.
 *
 * A self-hosted Host runs its own authorization server, so the person signs in
 * through the system browser. A Personal computer reached over Opensteer
 * Connect needs nobody: the Account signs a grant for the route and the Host
 * exchanges it. A Personal computer on its own private route needs the one-use
 * pairing code the operator carries off it, which only the Add door can take.
 */
export type DeploymentSignIn = "account-grant" | "host-oauth" | "pairing-code";

export interface DeploymentFacts {
  /** The open attachment's state, or null for every row that is not attached. */
  readonly attachment: DeploymentAttachment | null;
  /** Whether a credential this deployment accepts is held and still usable. */
  readonly credentialed: boolean;
  /** Why an automatic Personal-session exchange could not produce a credential. */
  readonly sessionFailure?: HostSessionExchangeFailure | null;
  /** What a live verification of the resolved route found, if one has answered. */
  readonly verification: HostVerification | null;
}

export interface DeploymentRow {
  readonly deploymentId: DeploymentId;
  /** True when the Account directory owns this row, so the phone may not drop it. */
  readonly accountManaged: boolean;
  readonly kindLabel: string;
  readonly name: string;
  /** Where this app would talk to it, which is also what the row shows. */
  readonly origin: string;
  /** Non-null exactly when the status is `needs-sign-in`. */
  readonly signIn: DeploymentSignIn | null;
  /** The last session-exchange answer for this attachment attempt. */
  readonly sessionFailure?: HostSessionExchangeFailure | null;
  /** Non-null exactly when the status is `update-required` or `unverified`. */
  readonly verification: HostVerification | null;
  readonly status: DeploymentStatus;
}

/**
 * A phone never runs the Personal Host it is talking to, so the resolver is
 * always asked with a null local runtime: the owner arm belongs to the computer
 * at the keyboard and cannot be reached from here.
 */
export function describeDeploymentRow(
  connection: DeploymentConnection,
  facts: DeploymentFacts,
): DeploymentRow {
  const access = describeConnectionAccess(connection, null);
  const status = deploymentStatusOf(access.access !== null, facts);
  const sessionFailure = facts.sessionFailure ?? null;
  return {
    accountManaged: connection.source.kind === "account",
    deploymentId: access.deploymentId,
    kindLabel: deploymentKindLabel(connection),
    name: connection.name,
    origin: access.origin,
    signIn:
      status !== "needs-sign-in"
        ? null
        : sessionFailure === "pairing-required"
          ? "pairing-code"
          : connection.kind === "self-hosted"
            ? "host-oauth"
            : access.access === "connect"
              ? "account-grant"
              : "pairing-code",
    sessionFailure,
    status,
    verification: facts.verification,
  };
}

/**
 * Precedence, worst first. A verification that answered is ahead of everything
 * else because it is the only fact that says the connection itself is wrong
 * rather than merely absent; a route that resolves to nothing is ahead of the
 * credential because there is nowhere to present one; and the attachment is
 * read only once there is both a place and a credential, because it cannot
 * exist otherwise.
 */
function deploymentStatusOf(reachable: boolean, facts: DeploymentFacts): DeploymentStatus {
  if (facts.verification === "identity-mismatch") return "unverified";
  if (facts.verification !== null) return "update-required";
  if (!reachable) return "unavailable";
  if (facts.sessionFailure === "unavailable") return "offline";
  if (facts.sessionFailure !== undefined && facts.sessionFailure !== null) return "needs-sign-in";
  if (!facts.credentialed) return "needs-sign-in";
  return facts.attachment ?? "signed-in";
}

/** What the action on a row that needs a credential is called. */
export function deploymentSignInLabel(signIn: DeploymentSignIn): string {
  return signIn === "pairing-code" ? "Enter a pairing code" : "Sign in";
}

/**
 * The kind, in the words the product uses for it — and only the words its own
 * data supports. A Deployment listed by the Account directory is one somebody
 * gave that Account access to; the directory entry says who may reach it, never
 * who runs it, so nothing here may call it Cloud. `personal` and `development`
 * are facts the Host itself declares in its descriptor, and are used as such.
 */
export function deploymentKindLabel(connection: DeploymentConnection): string {
  if (connection.kind === "personal") return "Personal computer";
  if (connection.kind === "development") return "Development";
  return "Server";
}

export function deploymentStatusLabel(status: DeploymentStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "needs-sign-in":
      return "Needs sign-in";
    case "offline":
      return "Offline";
    case "reconnecting":
      return "Reconnecting";
    case "signed-in":
      return "Signed in";
    case "unavailable":
      return "Unavailable";
    case "unverified":
      return "Unverified";
    case "update-required":
      return "Update required";
  }
}

/**
 * What a row's state means, written out where there is room for a sentence. A
 * state the word already explains — connected, and a credential held for a
 * Deployment nobody has opened — says nothing more, and the row shows the
 * address instead.
 */
export function deploymentStatusDetail(row: DeploymentRow): string | null {
  switch (row.status) {
    case "connected":
    case "signed-in":
      return null;
    case "connecting":
      return "This phone is opening the connection.";
    case "reconnecting":
      return "The connection dropped. This phone is opening it again.";
    case "offline":
      return "This phone cannot reach it right now.";
    case "needs-sign-in":
      if (row.sessionFailure === "account-required") {
        return "Sign in to your Opensteer Account again to reconnect this deployment.";
      }
      if (row.sessionFailure === "blocked") {
        return "This deployment no longer admits your Opensteer Account.";
      }
      return row.signIn === "pairing-code"
        ? "Enter a new pairing code from the computer that hosts it."
        : "Sign in to this deployment to see your work.";
    case "unavailable":
      return row.kindLabel === "Personal computer"
        ? "That computer is asleep or off its network."
        : "This deployment has no address this app can reach.";
    case "unverified":
      return "The address this phone uses answers as a different deployment.";
    case "update-required":
      return row.verification === "host-too-old"
        ? "This deployment speaks an older Opensteer protocol than this app. Update the deployment."
        : "This deployment speaks a newer Opensteer protocol than this app. Update this app.";
  }
}
