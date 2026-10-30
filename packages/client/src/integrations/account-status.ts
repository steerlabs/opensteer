import type {
  IntegrationConnectionSummary,
  IntegrationDefinitionSummaryView,
} from "@opensteer/integration-core";

export type IntegrationAccountRepair = "choose-repositories" | "replace-key" | "sign-in";

/**
 * Whether a connection needs its owner. The Host already reports an account
 * whose OAuth app is gone as needing attention, so its status says it all.
 */
export function connectionNeedsReconnect(connection: IntegrationConnectionSummary): boolean {
  // A blocked computer app is the owner's decision, not a fault to repair.
  if (connection.computer?.blockedAt) return false;
  return connection.status !== "connected";
}

/**
 * How an account that needs its owner is repaired, the same from every list
 * and every device. A key names no account, so only its own row can say which
 * connection a new key replaces. An account whose credential works but which
 * the provider grants too little, GitHub's repository step, goes back to that
 * step. Any other sign-in comes back as whichever account the provider names,
 * and the Host updates that account in place, so signing in again repairs it.
 * Nothing repairs an account of an installation that is not active: it could
 * not be used.
 */
export function integrationAccountRepair(
  connection: IntegrationConnectionSummary,
  integration: {
    readonly active: boolean;
    readonly definition: Pick<IntegrationDefinitionSummaryView, "authMethods">;
  } | null,
): IntegrationAccountRepair | null {
  if (!integration?.active) return null;
  if (!connectionNeedsReconnect(connection)) return null;
  if (connection.connectionMethod === "api-key") return "replace-key";
  if (connection.connectionMethod !== "managed-oauth") return null;
  if (connection.statusReason === "permissions") return "choose-repositories";
  return integration.definition.authMethods.some(({ kind }) => kind === "oauth") ? "sign-in" : null;
}

/** The account as its owner knows it: who it is at the provider, else the name it was saved as. */
export function integrationAccountTitle(
  account: Pick<IntegrationConnectionSummary, "accountIdentifier" | "displayName">,
): string {
  return account.accountIdentifier?.trim() || account.displayName;
}

export interface IntegrationAccountStatus {
  /** The Host's own words, when the short status replaces them. */
  readonly detail: string | null;
  readonly text: string;
  readonly tone: "attention" | "ok" | "off";
}

/**
 * One short line for an account's state. A repair says what to do rather than
 * why the Host asked for it; the Host's reason stays available as detail.
 */
export function integrationAccountStatus(
  connection: { readonly status: string; readonly statusDetail?: string | null },
  repair: IntegrationAccountRepair | null,
): IntegrationAccountStatus {
  const detail = connection.statusDetail?.trim() || null;
  switch (repair) {
    case "sign-in":
      return { detail, text: "Sign in again to keep using it", tone: "attention" };
    case "replace-key":
      return { detail, text: "Replace the key to keep using it", tone: "attention" };
    case "choose-repositories":
      return { detail, text: "Choose repositories to finish connecting", tone: "attention" };
    case null:
      break;
  }
  if (connection.status === "connected") return { detail: null, text: "Connected", tone: "ok" };
  const tone =
    connection.status === "needs-attention" || connection.status === "pending"
      ? "attention"
      : "off";
  return { detail: null, text: detail ?? integrationStatusLabel(connection.status), tone };
}

/** A status the Host names in kebab case, as words. */
export function integrationStatusLabel(status: string): string {
  const words = status.replaceAll("-", " ");
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}
