import type { IntegrationOAuthApplicationSource } from "@opensteer/integration-core";
import {
  accessPlan,
  accessServerChoices,
  accountConnectable,
  computerAccessUpgrade,
  grantedIntegrationAccess,
  integrationAccessSummary,
  integrationInstallReview,
  installationDefinition,
  mainAccessDetail,
  matchingInstallationForManifest,
  requestedAccountUnavailableDetail,
  type AccessRequestAccount,
  type LoadedAccessRequest,
} from "./access-request.js";
import { integrationAccountDetail } from "./account-identity.js";
import {
  connectAvailability,
  connectSignInOptions,
  initialConnectSource,
} from "./connect-selection.js";

export type ConnectCardPhase =
  | "ask"
  | "choose-account"
  | "connecting"
  | "needs-form"
  | "needs-admin"
  | "unavailable"
  | "failed"
  | "connected"
  | "answered";
export type ConnectCardForm = "api-key" | "computer" | "repositories" | "server";
export interface ConnectCardAction {
  readonly kind:
    "connect" | "use" | "install" | "upgrade" | "retry" | "settings" | "repositories" | "server";
  readonly label: string;
}

/** Presentation only: a browser return or an admitted command is never a connected account. */
export function connectCard(input: {
  readonly loaded: LoadedAccessRequest;
  readonly deploymentName: string;
  readonly selectedAccountId?: string | null;
  readonly allowChanges?: boolean;
  readonly agentProposed?: boolean;
  readonly connecting?: boolean;
  readonly error?: string | null;
  /** Supplied only after reading the committed Host connection and fulfilling access. */
  readonly connectedAccount?: Pick<
    AccessRequestAccount,
    "accountIdentifier" | "displayName"
  > | null;
  readonly answered?: boolean;
  readonly repositories?: boolean;
}) {
  const { loaded, deploymentName } = input;
  const plan = accessPlan(loaded, input.selectedAccountId ?? null);
  const review = integrationInstallReview(loaded.request.manifest);
  const entry = loaded.platform.installations.find(
    ({ installation }) => installation.id === loaded.request.installationId,
  );

  const name = plan?.integrationName ?? review?.name ?? entry?.installation.title ?? "Integration";
  const iconId =
    plan?.definition?.id ??
    (loaded.request.manifest ? installationDefinition(loaded.request.manifest)?.id : null) ??
    entry?.installation.id ??
    name.toLowerCase();
  const requestedAccess: "read" | "read-write" =
    loaded.request.access === "read-write" || input.allowChanges ? "read-write" : "read";
  const grantedAccess =
    plan === null
      ? requestedAccess
      : grantedIntegrationAccess({
          allowChanges: input.allowChanges ?? false,
          plan,
        });
  const effectiveAccess = grantedAccess;
  const accounts = plan?.accounts ?? [];
  const selected = plan?.selectedAccount ?? null;
  const serverChoices = accessServerChoices(loaded);
  const reconnect = plan?.requestedAccountMissing ? plan.requestedAccountReconnect : null;
  const upgrade = plan ? computerAccessUpgrade(plan, effectiveAccess) : null;
  const provider =
    plan?.requirement.kind === "provider" && plan.requirement.providerApplicationRequired
      ? plan.requirement.provider
      : null;
  const availability = provider ? connectAvailability(loaded.dashboard, provider) : null;
  // Use the Host's exact selection. A missing saved default must never silently
  // authorize another app; when there is no default, managed sign-in is offered.
  const source: IntegrationOAuthApplicationSource | null = provider
    ? (initialConnectSource(loaded.dashboard, provider) ??
      (loaded.dashboard.providerAuthorizations[provider]?.code === "READY"
        ? (connectSignInOptions(loaded.dashboard, provider).find(
            ({ source }) => source.kind === "hosted-oauth",
          )?.source ?? null)
        : null))
    : null;
  let phase: ConnectCardPhase = "ask";
  let form: ConnectCardForm | null = null;
  let primary: ConnectCardAction | null = { kind: "connect", label: "Connect" };
  let error = input.error ?? null;
  const installReview =
    loaded.request.installationId === null && review?.provenance ? review : null;
  const autoInstall =
    loaded.request.installationId === null && review !== null && review.provenance === null;
  const canConnectAnother =
    plan !== null && plan.requestedConnectionId === null && accountConnectable(plan);
  const canAllowChanges =
    plan?.requirement.kind === "computer" &&
    plan.requestedAccess === "read" &&
    (plan.writeCount > 0 || plan.definition?.computerApp?.accessLevels.length === 2);
  const proposed = plan?.proposed === true || input.agentProposed === true;
  const scope = "All your tasks";
  const details = [
    ...(plan?.requirement.kind !== "computer" ? [mainAccessDetail(deploymentName, name)] : []),
    ...(plan
      ? [integrationAccessSummary(plan, grantedAccess)]
      : review?.provenance
        ? []
        : (review?.facts ?? [])),
    ...(plan?.definition?.computerApp
      ? [plan.definition.computerApp.accessSummaries.readWrite]
      : []),
  ];
  if (loaded.request.installationId === null) {
    const installed = matchingInstallationForManifest(loaded.platform, loaded.request.manifest);
    if (!review) {
      phase = "unavailable";
      error =
        "Opensteer cannot read what this request would install. Decline it and ask for a fresh proposal.";
      primary = null;
    } else if (!loaded.dashboard.isAdministrator && installed === null) {
      phase = "needs-admin";
      error = `Ask an admin to add ${name}`;
      primary = null;
    } else if (installReview) {
      primary = { kind: "install", label: installed ? "Continue" : "Install and continue" };
    }
  } else if (serverChoices.length > 0) {
    phase = "needs-form";
    form = "server";
    primary = { kind: "server", label: "Choose server" };
  } else if (plan === null) {
    phase = "unavailable";
    error = "The requested integration is no longer installed.";
    primary = null;
  } else if (plan.requestedAccountMissing && reconnect === null) {
    phase = "unavailable";
    error = requestedAccountUnavailableDetail;
    primary = null;
  } else if (upgrade) {
    phase = "needs-form";
    form = "computer";
    primary = { kind: "upgrade", label: `Request sending access on ${upgrade.displayName}` };
  } else if (selected || plan.requirement.kind === "none") {
    phase = selected ? "choose-account" : "ask";
    primary = { kind: "use", label: "Allow" };
  } else if (plan.apiKeyMethod) {
    phase = "needs-form";
    form = "api-key";
    primary = {
      kind: "connect",
      label: reconnect ? `Reconnect ${accountLabel(reconnect.account)}` : "Connect",
    };
  } else if (plan.requirement.kind === "computer") {
    phase = "needs-form";
    form = "computer";
    primary = { kind: "connect", label: "Choose a computer" };
  } else if (provider && (availability?.kind !== "ready" || source === null)) {
    phase = "unavailable";
    error =
      availability && availability.kind !== "ready"
        ? availability.detail
        : "Choose a sign-in account in Settings to continue.";
    primary = { kind: "settings", label: "Open integration settings" };
  } else if (reconnect) {
    primary = { kind: "connect", label: `Reconnect ${accountLabel(reconnect.account)}` };
  }
  if (input.repositories) {
    phase = "needs-form";
    form = "repositories";
    primary = { kind: "repositories", label: "Recheck repository access" };
  }
  if (input.error) {
    error = input.error;
    phase = "failed";
    primary = { kind: "retry", label: "Try again" };
  }
  if (input.connecting) {
    phase = "connecting";
    primary = null;
  }
  const success = input.connectedAccount
    ? `${name} connected · ${accountLabel(input.connectedAccount)}`
    : null;
  if (success) {
    phase = "connected";
    primary = null;
    error = null;
  } else if (input.answered) {
    phase = "answered";
    primary = null;
  }
  const rows = accounts.filter(
    ({ id }) => plan?.requestedConnectionId === null || id === plan?.requestedConnectionId,
  );
  // "Use" once there is an account to answer with; until then the card asks
  // for a connection.
  const verb = selected || plan?.requirement.kind === "none" ? "Use" : "Connect";
  return {
    phase,
    proposed,
    name,
    iconId,
    title: `${verb} ${name}`,
    reason: loaded.request.reason,
    primary,
    secondary: "Not now" as const,
    accounts: rows.map((account) => ({
      ...account,
      label: accountLabel(account),
      // Told apart from every account of this integration, shown or not: a
      // Request pinned to one still has to say which of two look-alikes it is.
      detail: accountRowDetail(account, accounts),
      selected: account.id === selected?.id,
    })),
    selectedAccount: selected,
    scope,
    details,
    error,
    form,
    source,
    plan,
    installReview,
    autoInstall,
    canConnectAnother,
    canAllowChanges,
    effectiveAccess,
    upgrade,
    reconnect,
    serverChoices,
    success,
  };
}

const accountLabel = (account: Pick<AccessRequestAccount, "accountIdentifier" | "displayName">) =>
  account.accountIdentifier ?? account.displayName;

/**
 * A row's second line, only where its label alone does not tell it from
 * another row: a name only it has, or else when it was added.
 */
function accountRowDetail(
  account: AccessRequestAccount,
  accounts: readonly AccessRequestAccount[],
): string | null {
  const comparable = (value: string) => value.trim().toLocaleLowerCase();
  const label = comparable(accountLabel(account));
  const alike = accounts.filter((other) => comparable(accountLabel(other)) === label);
  if (alike.length < 2) return null;
  const name = comparable(account.displayName);
  const nameSetsItApart =
    name !== label &&
    alike.every(({ displayName, id }) => id === account.id || comparable(displayName) !== name);
  if (nameSetsItApart) return account.displayName;
  // Without identifiers the detail is the date: the identifier is the label already.
  const dated = (other: AccessRequestAccount) => ({ ...other, accountIdentifier: null });
  return integrationAccountDetail(dated(account), alike.map(dated));
}

/**
 * The account rows a card shows before "Show more": the first `limit`, always
 * including the selected one so the account Allow answers with is on screen.
 * A list one longer than the limit is shown whole, since a row that only
 * reveals one more account costs as much space as the account itself.
 */
export function collapsedAccountRows<Row extends { readonly selected: boolean }>(
  rows: readonly Row[],
  limit: number,
): { readonly rows: readonly Row[]; readonly hidden: number } {
  if (rows.length <= limit + 1) return { rows, hidden: 0 };
  const shown = rows.slice(0, limit);
  const selected = rows.find((row) => row.selected);
  if (selected && !shown.includes(selected)) shown[limit - 1] = selected;
  return { rows: shown, hidden: rows.length - limit };
}
export type ConnectCard = ReturnType<typeof connectCard>;
