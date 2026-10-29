import { useState } from "react";
import type {
  IntegrationDashboard,
  IntegrationPlatformDashboardView,
} from "@opensteer/integration-core";
import { computerAppPlatformRequirementLabel } from "@opensteer/client/integrations";
import { Icon } from "../icon.js";
import { AgentProposedChip } from "./agent-proposed-chip.js";
import {
  agentProposed,
  catalogReadiness,
  inactiveInstallation,
  statusChipClass,
  type DefinedIntegration,
  type InstallationEntry,
} from "./helpers.js";
import { IntegrationIcon } from "./integration-icon.js";

type Readiness = ReturnType<typeof catalogReadiness>;

/**
 * Every service this deployment has installed, proposals included. What needs
 * somebody comes first; the rest keep the catalog's order.
 */
export function InstalledServicesSection({
  dashboard,
  integrations,
  onOpen,
  platform,
}: {
  readonly dashboard: IntegrationDashboard | null;
  readonly integrations: readonly DefinedIntegration[];
  readonly onOpen: (definitionId: string) => void;
  readonly platform: IntegrationPlatformDashboardView | null;
}) {
  const cards = integrations
    .filter(({ entry }) => entry !== null)
    .map((integration) => ({
      integration,
      readiness: catalogReadiness(integration, dashboard, platform),
    }));
  if (cards.length === 0) return null;
  const needsSomeone = ({ readiness }: { readonly readiness: Readiness }) =>
    readiness.kind === "inactive" || readiness.kind === "needs-attention";
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Installed services</h2>
      </div>
      <div className="intg-grid">
        {[...cards.filter(needsSomeone), ...cards.filter((card) => !needsSomeone(card))].map(
          ({ integration, readiness }) => (
            <ServiceCard
              integration={integration}
              key={integration.definition.id}
              onOpen={onOpen}
              readiness={readiness}
            />
          ),
        )}
      </div>
    </section>
  );
}

/** The Opensteer presets this deployment has not installed. */
export function AddServiceSection({
  dashboard,
  integrations,
  onOpen,
  platform,
}: {
  readonly dashboard: IntegrationDashboard | null;
  readonly integrations: readonly DefinedIntegration[];
  readonly onOpen: (definitionId: string) => void;
  readonly platform: IntegrationPlatformDashboardView | null;
}) {
  const presets = integrations.filter(({ entry }) => entry === null);
  if (presets.length === 0) return null;
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Add a service</h2>
        <span className="section__hint">Presets from Opensteer’s reviewed catalog.</span>
      </div>
      <div className="intg-grid">
        {presets.map((integration) => (
          <ServiceCard
            integration={integration}
            key={integration.definition.id}
            onOpen={onOpen}
            readiness={catalogReadiness(integration, dashboard, platform)}
          />
        ))}
      </div>
    </section>
  );
}

function ServiceCard({
  integration,
  onOpen,
  readiness,
}: {
  readonly integration: DefinedIntegration;
  readonly onOpen: (definitionId: string) => void;
  readonly readiness: Readiness;
}) {
  // Which computer can run it is the app's own fact, so the card states it
  // wherever it is read — a phone browsing the catalog included.
  const requirement = computerAppPlatformRequirementLabel(integration.definition);
  return (
    <button className="intg-card" onClick={() => onOpen(integration.definition.id)} type="button">
      <IntegrationIcon
        icon={integration.definition.icon}
        id={integration.definition.id}
        name={integration.definition.name}
      />
      <span className="intg-card__body">
        <span className="intg-card__name">{integration.definition.name}</span>
        <span className="intg-card__description">{integration.definition.description}</span>
        {requirement ? <span className="intg-card__requirement">{requirement}</span> : null}
        <span className="intg-card__meta">
          <span className="intg-card__state">
            {readiness.kind === "inactive" ? (
              <span className={`chip ${statusChipClass(readiness.installation.status)}`}>
                {readiness.installation.label}
              </span>
            ) : readiness.kind === "needs-attention" ? (
              <span className="chip chip--warn">Needs attention</span>
            ) : readiness.kind === "admin-setup" ? (
              <span className="chip chip--warn">
                {readiness.canConfigure ? "Set up" : "Admin setup needed"}
              </span>
            ) : readiness.kind === "install" ? (
              <span className="intg-card__connect">
                {readiness.canInstall ? "Install" : "Admin install needed"}
                {readiness.canInstall ? <Icon name="arrow-right" /> : null}
              </span>
            ) : readiness.kind === "request-driven" ? (
              <span className="chip">No account yet</span>
            ) : readiness.kind === "ready" ? (
              <span className="chip chip--ok">Connected</span>
            ) : readiness.kind === "choose-computer" ? (
              <span className="intg-card__connect">
                Choose a computer <Icon name="arrow-right" />
              </span>
            ) : (
              <span className="intg-card__connect">
                Connect <Icon name="arrow-right" />
              </span>
            )}
          </span>
          {agentProposed(integration.entry) ? <AgentProposedChip /> : null}
        </span>
      </span>
    </button>
  );
}

/**
 * Everything installed that has no definition for the services above to
 * manage: Agent Plugins and remote MCP servers. An administrator can remove any
 * of them, which is the only exit an installation that materialized badly has.
 */
export function PluginsAndMcpSection({
  entries,
  isAdministrator,
  onInstall,
  onUninstall,
  pending,
}: {
  readonly entries: readonly InstallationEntry[];
  readonly isAdministrator: boolean;
  readonly onInstall: () => void;
  readonly onUninstall: (installationId: string) => void;
  readonly pending: boolean;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (entries.length === 0 && !isAdministrator) return null;
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Agent Plugins and MCP servers</h2>
        <span className="section__hint">Added to this deployment.</span>
      </div>
      {entries.length > 0 ? (
        <div className="card">
          {entries.map((entry) => {
            const { installation, servers, skills, tools } = entry;
            const offerings = [
              ...skills.slice(0, 4).map(({ name }) => name),
              ...tools.slice(0, 4).map(({ title }) => title),
            ];
            const extra = skills.length + tools.length - 8;
            const inactive = inactiveInstallation(installation.title, entry);
            return (
              <div
                className="card__row"
                id={installationRowId(installation.id)}
                key={installation.id}
              >
                <span className="card__row-glyph">
                  <Icon name="puzzle" />
                </span>
                <div className="card__row-body">
                  <span className="card__row-title">
                    {installation.title}
                    {inactive ? (
                      <span className={`chip ${statusChipClass(inactive.status)}`}>
                        {inactive.label}
                      </span>
                    ) : null}
                  </span>
                  <span className="card__row-detail">
                    {installation.sourceKind === "agent-plugin"
                      ? "Agent Plugin 1.0"
                      : installation.sourceKind === "proposed"
                        ? "Agent-proposed"
                        : "Remote MCP"}
                    {servers.some(
                      ({ connectionRequirement }) => connectionRequirement.kind !== "none",
                    )
                      ? " · account required"
                      : ""}
                    {offerings.length > 0 ? ` · ${offerings.join(" · ")}` : ""}
                    {extra > 0 ? ` · +${extra} more` : ""}
                  </span>
                  {inactive ? <span className="card__row-detail">{inactive.detail}</span> : null}
                </div>
                {isAdministrator ? (
                  <div className="card__row-actions">
                    <button
                      className={`btn btn--small ${
                        confirming === installation.id ? "btn--danger" : ""
                      }`}
                      disabled={pending}
                      onClick={() => {
                        if (confirming === installation.id) onUninstall(installation.id);
                        else setConfirming(installation.id);
                      }}
                      type="button"
                    >
                      {confirming === installation.id ? "Confirm uninstall" : "Uninstall"}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {isAdministrator ? (
        <button className="btn" onClick={onInstall} type="button">
          <Icon name="plus" /> Add Agent Plugin or MCP
        </button>
      ) : null}
    </section>
  );
}

/** Stable anchor so a deep link can scroll one installed row into view. */
export function installationRowId(installationId: string): string {
  return `installation-${installationId}`;
}
