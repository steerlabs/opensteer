import { useState } from "react";
import type {
  IntegrationConnectionSummary,
  IntegrationDashboard,
  IntegrationPlatformDashboardView,
} from "@opensteer/integration-core";
import { integrationAccountDetail } from "@opensteer/client/integrations";
import { Icon } from "../icon.js";
import { AgentProposedChip } from "./agent-proposed-chip.js";
import {
  accountRepair,
  agentProposed,
  providerLabel,
  statusChipClass,
  statusLabel,
  type DefinedIntegration,
} from "./helpers.js";
import { IntegrationIcon } from "./integration-icon.js";
import { accountConnections } from "./computer-apps-section.js";

/**
 * Every account the signed-in user owns, across OAuth, API-key, and MCP
 * authorizations — one list, because they are one concept: a credential that
 * grants become scoped to.
 *
 * An app on a computer is not one of those: it holds no credential and is
 * named by a computer rather than by a person, so it is listed apart.
 */
export function AccountsSection({
  dashboard,
  integrations,
  onDisconnect,
  onDisconnectMcp,
  onOpen,
  onReconnectKey,
  onRepositoryAccess,
  onSignIn,
  pending,
  platform,
}: {
  readonly dashboard: IntegrationDashboard | null;
  readonly integrations: readonly DefinedIntegration[];
  readonly onDisconnect: (connectionId: string) => void;
  readonly onDisconnectMcp: (connectionId: string) => void;
  readonly onOpen: (definitionId: string) => void;
  /** Replaces the key of a connection made with one, keeping the connection. */
  readonly onReconnectKey: (definitionId: string, connectionId: string) => void;
  readonly onRepositoryAccess: (connectionId: string) => void;
  /** Signs in again as the account, which the Host then updates in place. */
  readonly onSignIn: (definitionId: string, account: IntegrationConnectionSummary) => void;
  readonly pending: boolean;
  readonly platform: IntegrationPlatformDashboardView | null;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const connections = accountConnections(dashboard?.connections ?? []);
  const mcpConnections = platform?.connections.filter(({ status }) => status !== "revoked") ?? [];
  if (connections.length === 0 && mcpConnections.length === 0) return null;
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Your accounts</h2>
      </div>
      <div className="card">
        {connections.map((connection) => {
          const integration = integrations.find(
            ({ definition }) => definition.id === connection.definitionId,
          );
          const accountDetail = integrationAccountDetail(
            connection,
            connections.filter(({ definitionId }) => definitionId === connection.definitionId),
          );
          const repair = accountRepair(integration, connection);
          const definition = integration?.definition ?? null;
          return (
            <div className="card__row" key={connection.id}>
              {integration ? (
                <IntegrationIcon
                  icon={integration.definition.icon}
                  id={integration.definition.id}
                  name={integration.definition.name}
                />
              ) : (
                <span className="card__row-glyph">
                  <Icon name="key" />
                </span>
              )}
              <div className="card__row-body">
                <span className="card__row-title">
                  {connection.displayName}
                  <span className={`chip ${statusChipClass(connection.status)}`}>
                    {statusLabel(connection.status)}
                  </span>
                  {connection.connectionMethod === "api-key" ? (
                    <span className="chip">API key</span>
                  ) : null}
                  {agentProposed(integration?.entry) ? <AgentProposedChip /> : null}
                </span>
                <span className="card__row-detail">
                  {withService(
                    accountDetail,
                    connection.displayName,
                    definition?.name ?? providerLabel(connection.provider),
                  )}
                  {connection.statusDetail ? ` · ${connection.statusDetail}` : ""}
                </span>
              </div>
              <div className="card__row-actions">
                {repair && integration ? (
                  <button
                    className="btn btn--primary btn--small"
                    disabled={pending}
                    onClick={() =>
                      repair === "replace-key"
                        ? onReconnectKey(integration.definition.id, connection.id)
                        : repair === "sign-in"
                          ? onSignIn(integration.definition.id, connection)
                          : onRepositoryAccess(connection.id)
                    }
                    type="button"
                  >
                    {repair === "choose-repositories" ? "Set up repositories" : "Reconnect"}
                  </button>
                ) : null}
                {integration ? (
                  <button
                    className="btn btn--small"
                    onClick={() => onOpen(integration.definition.id)}
                    type="button"
                  >
                    Manage
                  </button>
                ) : (
                  <button
                    className={`btn btn--small ${confirming === connection.id ? "btn--danger" : ""}`}
                    disabled={pending}
                    onClick={() => {
                      if (confirming === connection.id) onDisconnect(connection.id);
                      else setConfirming(connection.id);
                    }}
                    type="button"
                  >
                    {confirming === connection.id ? "Confirm disconnect" : "Disconnect"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {mcpConnections.map((connection) => {
          const entry = platform?.installations.find(
            ({ installation: candidate }) => candidate.id === connection.installationId,
          );
          const accountDetail = integrationAccountDetail(
            { ...connection, id: connection.connectionId },
            mcpConnections
              .filter(({ installationId }) => installationId === connection.installationId)
              .map((peer) => ({ ...peer, id: peer.connectionId })),
          );
          return (
            <div className="card__row" key={connection.connectionId}>
              <span className="card__row-glyph">
                <Icon name="key" />
              </span>
              <div className="card__row-body">
                <span className="card__row-title">
                  {connection.displayName}
                  <span className={`chip ${statusChipClass(connection.status)}`}>
                    {statusLabel(connection.status)}
                  </span>
                  {agentProposed(entry) ? <AgentProposedChip /> : null}
                </span>
                <span className="card__row-detail">
                  {withService(
                    accountDetail,
                    connection.displayName,
                    entry?.installation.title ?? "MCP server",
                  )}
                </span>
              </div>
              <div className="card__row-actions">
                <button
                  className={`btn btn--small ${
                    confirming === connection.connectionId ? "btn--danger" : ""
                  }`}
                  disabled={pending}
                  onClick={() => {
                    if (confirming === connection.connectionId)
                      onDisconnectMcp(connection.connectionId);
                    else setConfirming(connection.connectionId);
                  }}
                  type="button"
                >
                  {confirming === connection.connectionId ? "Confirm disconnect" : "Disconnect"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Names the account's service, unless the account is already named after it. */
function withService(detail: string, displayName: string, service: string): string {
  return displayName.trim().toLocaleLowerCase() === service.trim().toLocaleLowerCase()
    ? detail
    : `${detail} · ${service}`;
}
