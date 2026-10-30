import { agentProposedText } from "@opensteer/core";
import type { IntegrationDefinitionSummaryView } from "@opensteer/integration-core/adapter";
import {
  type IntegrationConnectionSummary,
  type IntegrationDashboard,
  type IntegrationPlatformDashboardView,
  type IntegrationProvider,
  type IntegrationServerSummary,
  type IntegrationSkill,
  type IntegrationTool,
} from "@opensteer/integration-core/models";
import {
  canSetUpOwnApp,
  connectionNeedsReconnect,
  installationDefinition,
  integrationAccountRepair,
  integrationStatusLabel,
  type IntegrationAccountRepair,
} from "@opensteer/client/integrations";

export { connectionNeedsReconnect };

export interface InstallationEntry {
  readonly installation: IntegrationPlatformDashboardView["installations"][number]["installation"];
  readonly servers: readonly IntegrationServerSummary[];
  readonly skills: readonly IntegrationSkill[];
  readonly tools: readonly IntegrationTool[];
}

/**
 * One integration the page manages through its definition: a catalog preset,
 * installed or not, or an installation that brought its own, such as an
 * agent's proposal. Once installed, the definition is the installation's own,
 * describing the snapshot the Host connects and calls with; the catalog's
 * describes only what installing would take. Only a preset has a catalog
 * digest to install.
 */
export type DefinedIntegration = { readonly definition: IntegrationDefinitionSummaryView } & (
  | { readonly digest: string; readonly entry: InstallationEntry | null }
  | { readonly digest: null; readonly entry: InstallationEntry }
);

/** An account an MCP server's own OAuth authorized, held by its installation. */
type McpAccount = IntegrationPlatformDashboardView["connections"][number];

type CatalogReadiness =
  | { readonly kind: "ready" }
  | { readonly kind: "connectable" }
  /** Installed, and waiting for somebody to say which computer it runs on. */
  | { readonly kind: "choose-computer" }
  | { readonly kind: "request-driven" }
  | { readonly kind: "install"; readonly canInstall: boolean }
  | { readonly kind: "admin-setup"; readonly canConfigure: boolean }
  /** An account, not the installation, needs its owner. */
  | { readonly kind: "needs-attention" }
  | { readonly kind: "inactive"; readonly installation: InactiveInstallation };

/** An installation that is not active, said the same way on its card, its row and its page. */
export interface InactiveInstallation {
  readonly detail: string;
  readonly label: "Turned off" | "Unavailable";
  readonly status: "disabled" | "needs-attention";
  readonly title: string;
}

/** The one thing that repairs an account, wherever the account is listed. */
export type AccountRepair = IntegrationAccountRepair;

/** Whether this definition is an app that runs on an enrolled computer. */
export function isComputerApp(definition: IntegrationDefinitionSummaryView): boolean {
  return definition.computerApp !== undefined;
}

/** Definitions ride inside installation manifests; absent for plugins/MCP. */
export function definitionOf(entry: InstallationEntry): IntegrationDefinitionSummaryView | null {
  return installationDefinition(entry.installation.manifest);
}

/**
 * Every installation exactly once: an integration with a definition is managed
 * through it, however it was installed, and the rest (Agent Plugins and remote
 * MCP servers) are listed as installations.
 */
export function platformIntegrations(platform: IntegrationPlatformDashboardView | null): {
  readonly integrations: readonly DefinedIntegration[];
  readonly installations: readonly InstallationEntry[];
} {
  if (!platform) return { installations: [], integrations: [] };
  const installed = new Map<string, DefinedIntegration>();
  const installations: InstallationEntry[] = [];
  for (const entry of platform.installations) {
    const definition = definitionOf(entry);
    if (definition) installed.set(entry.installation.id, { definition, digest: null, entry });
    else installations.push(entry);
  }
  // Presets keep the catalog's order, and an installed one keeps its digest.
  const integrations = platform.catalog.flatMap(
    ({ definition, digest, installationId }): DefinedIntegration[] => {
      if (installationId === null) return [{ definition, digest, entry: null }];
      const integration = installed.get(installationId);
      if (!integration) return [];
      installed.delete(installationId);
      return [{ ...integration, digest }];
    },
  );
  return { installations, integrations: [...integrations, ...installed.values()] };
}

/** Whether an agent proposed it, which nothing about its name or text vouches for. */
export function agentProposed(entry: InstallationEntry | null | undefined): boolean {
  return entry?.installation.sourceKind === "proposed";
}

/**
 * An installation's name where only plain text fits, as in a native select.
 * An agent can give its proposal any name, a catalog integration's included,
 * so there the provenance is part of the name.
 */
export function installationNameText(entry: InstallationEntry): string {
  return agentProposedText(entry.installation.title, agentProposed(entry));
}

/**
 * Why an installation cannot be used, and that agents cannot use it. The
 * reason lives on the servers it materialized, which may record none.
 */
export function inactiveInstallation(
  name: string,
  entry: InstallationEntry,
): InactiveInstallation | null {
  const { status } = entry.installation;
  if (status === "active") return null;
  const reason = installationStatusDetail(entry);
  return status === "disabled"
    ? {
        detail: reason ?? "Agents can’t use it, and no account can be connected to it.",
        label: "Turned off",
        status,
        title: `${name} is turned off`,
      }
    : {
        detail: reason ?? "Opensteer can’t run it as installed, so agents can’t use it.",
        label: "Unavailable",
        status,
        title: `${name} is unavailable`,
      };
}

function installationStatusDetail(entry: InstallationEntry): string | null {
  return (
    entry.servers.find(({ status, statusDetail }) => status !== "active" && statusDetail)
      ?.statusDetail ??
    entry.servers.find(({ statusDetail }) => statusDetail)?.statusDetail ??
    null
  );
}

/** How this account is repaired from any list; see `integrationAccountRepair`. */
export function accountRepair(
  integration: DefinedIntegration | undefined,
  connection: IntegrationConnectionSummary,
): AccountRepair | null {
  return integrationAccountRepair(
    connection,
    integration?.entry
      ? {
          active: integration.entry.installation.status === "active",
          definition: integration.definition,
        }
      : null,
  );
}

export function accountsFor(
  dashboard: IntegrationDashboard | null,
  definition: IntegrationDefinitionSummaryView,
): readonly IntegrationConnectionSummary[] {
  return (
    dashboard?.connections.filter(
      (connection) => connection.status !== "revoked" && connection.definitionId === definition.id,
    ) ?? []
  );
}

/**
 * The accounts an MCP server's own OAuth authorized. The Host keeps them with
 * the installation rather than the definition, apart from provider accounts.
 */
export function mcpAccountsFor(
  platform: IntegrationPlatformDashboardView | null,
  entry: InstallationEntry,
): readonly McpAccount[] {
  return (
    platform?.connections.filter(
      (connection) =>
        connection.status !== "revoked" && connection.installationId === entry.installation.id,
    ) ?? []
  );
}

export function catalogReadiness(
  integration: DefinedIntegration,
  dashboard: IntegrationDashboard | null,
  platform: IntegrationPlatformDashboardView | null,
): CatalogReadiness {
  if (!integration.entry)
    return { kind: "install", canInstall: dashboard?.isAdministrator ?? false };
  // Anything but an active installation is unavailable, disabled included: its
  // servers cannot run, so offering "Connect" would collect an account against
  // an integration that will refuse every call.
  const inactive = inactiveInstallation(integration.definition.name, integration.entry);
  if (inactive) return { installation: inactive, kind: "inactive" };
  if (
    integration.entry.servers.some(
      ({ connectionRequirement }) => connectionRequirement.kind === "mcp-oauth",
    )
  ) {
    const mcpAccounts = mcpAccountsFor(platform, integration.entry);
    if (mcpAccounts.some(({ status }) => status !== "connected"))
      return { kind: "needs-attention" };
    return mcpAccounts.length > 0 ? { kind: "ready" } : { kind: "request-driven" };
  }
  const accounts = accountsFor(dashboard, integration.definition);
  if (accounts.some(connectionNeedsReconnect)) return { kind: "needs-attention" };
  if (accounts.length > 0) return { kind: "ready" };
  // An installed app with no computer yet needs a choice, not a sign-in, and
  // the card says which choice rather than the generic "Connect".
  if (isComputerApp(integration.definition)) return { kind: "choose-computer" };
  const requiresApplication = integration.entry.servers.some(
    ({ connectionRequirement }) =>
      connectionRequirement.kind === "provider" &&
      connectionRequirement.providerApplicationRequired,
  );
  if (requiresApplication) {
    if (dashboard && canSetUpOwnApp(dashboard, integration.definition.provider)) {
      return { kind: "connectable" };
    }
    const authorization = dashboard?.providerAuthorizations[integration.definition.provider];
    if (
      authorization?.code === "PROVIDER_APPLICATION_REQUIRED" ||
      authorization?.code === "OAUTH_SOURCE_UNAVAILABLE"
    )
      return { kind: "admin-setup", canConfigure: dashboard?.isAdministrator ?? false };
  }
  return { kind: "connectable" };
}

/** Deterministic hue per integration so monograms are tinted, never random. */
export function integrationHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

export function providerLabel(provider: IntegrationProvider): string {
  return provider.replaceAll(/[.-]/g, " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

export function secretFieldLabel(field: string): string {
  return field
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

/** A status as every chip says it: "needs-attention" reads "Needs attention". */
export { integrationStatusLabel as statusLabel };

export function statusChipClass(status: string): string {
  return status === "connected" || status === "active"
    ? "chip--ok"
    : status === "needs-attention" || status === "pending" || status === "paused"
      ? "chip--warn"
      : status === "revoked" || status === "disabled"
        ? "chip--bad"
        : "";
}

export function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Something went wrong";
}
