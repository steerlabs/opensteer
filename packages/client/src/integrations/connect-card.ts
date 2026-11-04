import type { IntegrationOAuthApplicationSource } from "@opensteer/integration-core";
import { requestAgentProposedDetail } from "@opensteer/core";
import {
  accessPlan,
  accessServerChoices,
  accountConnectable,
  computerAccessUpgrade,
  grantedIntegrationAccess,
  integrationAccessSummary,
  integrationInstallReview,
  installationDefinition,
  mainConnectAllowsNote,
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
  readonly workspace: { readonly kind: "main" | "project"; readonly name: string };
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
  const { loaded, workspace } = input;
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
  const effectiveAccess: "read" | "read-write" =
    loaded.request.access === "read-write" || input.allowChanges ? "read-write" : "read";
  const grantedAccess =
    plan === null
      ? effectiveAccess
      : grantedIntegrationAccess({
          allowChanges: input.allowChanges ?? false,
          plan,
          workspaceKind: workspace.kind,
        });
  const accounts = plan?.accounts ?? [];
  const selected = plan?.selectedAccount ?? null;
  const accountLabel = (account: Pick<AccessRequestAccount, "accountIdentifier" | "displayName">) =>
    account.accountIdentifier ?? account.displayName;
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
  let primary: ConnectCardAction | null = { kind: "connect", label: `Connect ${name}` };
  let error = input.error ?? null;
  const installReview =
    loaded.request.installationId === null && review?.provenance ? review : null;
  const autoInstall =
    loaded.request.installationId === null && review !== null && review.provenance === null;
  const canConnectAnother =
    plan !== null && plan.requestedConnectionId === null && accountConnectable(plan);
  const canAllowChanges =
    workspace.kind === "project" &&
    plan?.requestedAccess === "read" &&
    (plan.writeCount > 0 || plan.definition?.computerApp?.accessLevels.length === 2);
  const proposed = plan?.proposed === true || input.agentProposed === true;
  const capabilities = [
    ...(proposed ? [requestAgentProposedDetail] : []),
    ...(plan
      ? [integrationAccessSummary(plan, grantedAccess)]
      : review?.provenance
        ? []
        : (review?.facts ?? [])),
    ...(workspace.kind === "main" && plan !== null && plan.requirement.kind !== "computer"
      ? [mainConnectAllowsNote(workspace.name)]
      : []),
    ...(workspace.kind === "project" && loaded.request.access === "read-write"
      ? [
          "This task requires read-write access. It allows changes when operations become available.",
        ]
      : []),
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
    primary = {
      kind: "use",
      label: selected ? `Use ${accountLabel(selected)}` : `Allow in ${workspace.name}`,
    };
  } else if (plan.apiKeyMethod) {
    phase = "needs-form";
    form = "api-key";
    primary = {
      kind: "connect",
      label: reconnect ? `Reconnect ${accountLabel(reconnect.account)}` : `Connect ${name}`,
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
    ? `✓ ${name} connected · ${accountLabel(input.connectedAccount)}`
    : null;
  if (success) {
    phase = "connected";
    primary = null;
    error = null;
  } else if (input.answered) {
    phase = "answered";
    primary = null;
  }
  return {
    phase,
    proposed,
    name,
    iconId,
    purpose: loaded.request.reason,
    primary,
    secondary: "Not now" as const,
    accounts: accounts
      .filter(
        ({ id }) => plan?.requestedConnectionId === null || id === plan?.requestedConnectionId,
      )
      .map((account) => ({
        ...account,
        label: accountLabel(account),
        detail: integrationAccountDetail(account, accounts),
        selected: account.id === selected?.id,
      })),
    selectedAccount: selected,
    projectNote: workspace.kind === "project" ? `Only ${workspace.name} gets access` : null,
    capabilities,
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
export type ConnectCard = ReturnType<typeof connectCard>;
