import {
  accessPlan,
  accessServerChoices,
  catalogInstallDefinition,
  computerAccessUpgrade,
  grantedIntegrationAccess,
  integrationAccessSummary,
  matchingInstallationForManifest,
  requestedAccountUnavailableDetail,
  type AccessRequestAccount,
  type LoadedAccessRequest,
} from "./access-request.js";

export type ConnectCardPhase =
  | "ask"
  | "choose-account"
  | "needs-form"
  | "needs-admin"
  | "unavailable"
  | "failed"
  | "connected"
  | "answered";
export type ConnectCardForm = "computer" | "server";
export interface ConnectCardAction {
  readonly kind: "connect" | "use" | "install" | "upgrade" | "retry" | "server";
  readonly label: string;
}


/**
 * An access Request for a device data app or a local server, as both cards show
 * it. Presentation only: a committed Host connection is the only connected state.
 */
export function connectCard(input: {
  readonly loaded: LoadedAccessRequest;
  readonly selectedAccountId?: string | null;
  readonly allowChanges?: boolean;
  readonly error?: string | null;
  /** Supplied only after reading the committed Host connection and fulfilling access. */
  readonly connectedAccount?: Pick<
    AccessRequestAccount,
    "accountIdentifier" | "displayName"
  > | null;
  readonly answered?: boolean;
}) {
  const { loaded } = input;
  const plan = accessPlan(loaded, input.selectedAccountId ?? null);
  const catalog = catalogInstallDefinition(loaded.request.manifest);
  const entry = loaded.platform.installations.find(
    ({ installation }) => installation.id === loaded.request.installationId,
  );
  const name = plan?.integrationName ?? catalog?.name ?? entry?.installation.title ?? "App";
  const iconId =
    plan?.definition?.id ?? catalog?.id ?? entry?.installation.id ?? name.toLowerCase();
  const requestedAccess: "read" | "read-write" =
    loaded.request.access === "read-write" || input.allowChanges ? "read-write" : "read";
  const grantedAccess =
    plan === null
      ? requestedAccess
      : grantedIntegrationAccess({ allowChanges: input.allowChanges ?? false, plan });
  const accounts = plan?.accounts ?? [];
  const selected = plan?.selectedAccount ?? null;
  const serverChoices = accessServerChoices(loaded);
  const upgrade = plan ? computerAccessUpgrade(plan, grantedAccess) : null;
  let phase: ConnectCardPhase = "ask";
  let form: ConnectCardForm | null = null;
  let primary: ConnectCardAction | null = { kind: "connect", label: "Connect" };
  let error = input.error ?? null;
  const install = loaded.request.installationId === null;
  const canConnectAnother =
    plan !== null && plan.requestedConnectionId === null && plan.requirement.kind === "computer";
  const canAllowChanges =
    plan?.requirement.kind === "computer" &&
    plan.requestedAccess === "read" &&
    (plan.writeCount > 0 || plan.definition?.computerApp?.accessLevels.length === 2);
  const details = [
    ...(plan
      ? [integrationAccessSummary(plan, grantedAccess)]
      : catalog
        ? [catalog.description]
        : []),
    ...(plan?.definition?.computerApp
      ? [plan.definition.computerApp.accessSummaries.readWrite]
      : []),
  ];
  if (install) {
    const installed = matchingInstallationForManifest(loaded.platform, loaded.request.manifest);
    if (!catalog) {
      phase = "unavailable";
      error = "This device app is no longer offered. Decline this request and ask the agent again.";
      primary = null;
    } else if (!loaded.dashboard.isAdministrator && installed === null) {
      phase = "needs-admin";
      error = `Ask an admin to add ${name}`;
      primary = null;
    } else {
      primary = { kind: "install", label: "Continue" };
    }
  } else if (serverChoices.length > 0) {
    phase = "needs-form";
    form = "server";
    primary = { kind: "server", label: "Choose server" };
  } else if (plan === null) {
    phase = "unavailable";
    error = "What this request asks for is no longer installed.";
    primary = null;
  } else if (plan.requestedAccountMissing) {
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
  } else {
    phase = "needs-form";
    form = "computer";
    primary = { kind: "connect", label: "Choose a computer" };
  }
  if (input.error) {
    error = input.error;
    phase = "failed";
    primary = { kind: "retry", label: "Try again" };
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
  const verb = selected || plan?.requirement.kind === "none" ? "Use" : "Connect";
  return {
    phase,
    name,
    iconId,
    title: `${verb} ${name}`,
    reason: loaded.request.reason,
    primary,
    secondary: "Not now" as const,
    accounts: rows.map((account) => ({
      ...account,
      label: accountLabel(account),
      selected: account.id === selected?.id,
    })),
    selectedAccount: selected,
    scope: "All your tasks",
    details,
    error,
    form,
    plan,
    canConnectAnother,
    canAllowChanges,
    effectiveAccess: grantedAccess,
    upgrade,
    serverChoices,
    success,
  };
}

const accountLabel = (account: Pick<AccessRequestAccount, "accountIdentifier" | "displayName">) =>
  account.accountIdentifier ?? account.displayName;

/**
 * The rows a card shows before "Show more": the first `limit`, always
 * including the selected one so the computer Allow answers with is on screen.
 * A list one longer than the limit is shown whole.
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
