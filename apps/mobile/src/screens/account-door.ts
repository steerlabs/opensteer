import type { AccountDeploymentDirectoryUnavailable } from "@opensteer/client/connections";
import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import { deploymentUnavailableReasonExplanation } from "@opensteer/protocol/deployment-status";
import type { DeploymentRow } from "../client/deployment-rows.js";
import { signInStorageSentence } from "../platform/sign-in-storage.js";

type AccountState = DesktopAccountAuthState["account"];

/** Expo's own words for a Keychain or Keystore call the platform refused. */
const secureStoreException =
  /Keychain|SecureStore|entitlement|(?:get|set|delete)ValueWithKeyAsync|isAvailableAsync/u;

export function accountDoorPresentation(
  account: AccountState,
  starting: boolean,
  noun: "iPhone" | "phone" = "phone",
): { readonly description: string; readonly disabled: boolean; readonly title: string } {
  const signingIn = starting || account.status === "authorizing";
  // The sign-in storage says this itself; an exception that still arrives in Expo's words
  // reads the same, never as the exception.
  const unavailableDetail =
    account.detail !== null && secureStoreException.test(account.detail)
      ? signInStorageSentence(noun)
      : account.detail;
  if (signingIn) {
    return {
      description: unavailableDetail ?? "Complete authorization in your browser.",
      disabled: true,
      title: "Finish signing in in your browser",
    };
  }
  return {
    description: account.available
      ? account.status === "error"
        ? (unavailableDetail ?? "Your Opensteer account could not be reached.")
        : "Your Opensteer account lists every Opensteer you can open."
      : (unavailableDetail ?? "This build was made without an Opensteer account service."),
    disabled: !account.available,
    // Retrying is only something to offer when signing in is possible at all.
    title: account.available && account.status === "error" ? "Try signing in again" : "Sign in",
  };
}

export type DeploymentsPresentation = "list" | "signed-in-empty" | "welcome";

/** The empty catalog has two different jobs depending on whether an Account exists. */
export function deploymentsPresentation(
  rowCount: number,
  hasAccountIdentity: boolean,
): DeploymentsPresentation {
  if (rowCount > 0) return "list";
  return hasAccountIdentity ? "signed-in-empty" : "welcome";
}

/** Verification failures need repair before selecting them can be safe or useful. */
export function deploymentCanOpen(row: DeploymentRow): boolean {
  return row.status !== "unverified" && row.status !== "update-required";
}

/** The Account flow may continue automatically only when the destination is unambiguous. */
export function eligibleSingletonDeployment(rows: readonly DeploymentRow[]): DeploymentRow | null {
  const eligible = rows.filter(deploymentCanOpen);
  return eligible.length === 1 ? eligible[0]! : null;
}

export function accountFlowCanContinue(input: {
  readonly active: boolean;
  readonly currentGeneration: number;
  readonly currentSelection: string | null;
  readonly expectedGeneration: number;
  readonly expectedSelection: string | null;
}): boolean {
  return (
    input.active &&
    input.currentGeneration === input.expectedGeneration &&
    input.currentSelection === input.expectedSelection
  );
}

export function deploymentOpenLabel(row: DeploymentRow): string {
  if (!deploymentCanOpen(row)) return `Show why ${row.name} cannot open`;
  if (row.signIn !== null && row.signIn !== "pairing-code") {
    return `Open and sign in to ${row.name}`;
  }
  return `Open ${row.name}`;
}

export function accountIdentityLabel(identity: NonNullable<AccountState["identity"]>): string {
  return identity.email ?? identity.subject;
}

export function accountDirectoryUnavailablePresentation(
  entry: AccountDeploymentDirectoryUnavailable,
): { readonly detail: string; readonly title: string } {
  const sharedDetail = deploymentUnavailableReasonExplanation(entry.reason);
  return {
    detail:
      entry.reason === "host-unavailable"
        ? `${sharedDetail} Pull down to try again.`
        : entry.reason === "not-active"
          ? "This Opensteer is not ready yet."
          : sharedDetail,
    title: `${entry.name} — Account listing`,
  };
}

export function signedInDirectoryPresentation(input: {
  readonly detail: string | null;
  readonly status: "error" | "idle" | "loading" | "ready";
  readonly unavailableCount: number;
}): {
  readonly detail: string;
  readonly refreshDisabled: boolean;
  readonly refreshLabel: string;
  readonly title: string;
} {
  if (input.status === "idle" || input.status === "loading") {
    return {
      detail: "Checking your Opensteer account…",
      refreshDisabled: true,
      refreshLabel: "Refreshing…",
      title: "Signed in to your Account",
    };
  }
  if (input.status === "error") {
    return {
      detail: input.detail ?? "Your list of Opensteers could not be refreshed.",
      refreshDisabled: false,
      refreshLabel: "Try refreshing again",
      title: "Your list of Opensteers could not be loaded",
    };
  }
  if (input.unavailableCount > 0) {
    return {
      detail: `${input.unavailableCount === 1 ? "One Opensteer" : `${input.unavailableCount} Opensteers`} from your account could not be verified on this phone.`,
      refreshDisabled: false,
      refreshLabel: "Refresh",
      title: "Some Opensteers could not be loaded",
    };
  }
  return {
    detail:
      "Your Opensteer account doesn’t list an Opensteer yet. You can refresh or add one another way.",
    refreshDisabled: false,
    refreshLabel: "Refresh",
    title: "No Opensteer in your account yet",
  };
}
