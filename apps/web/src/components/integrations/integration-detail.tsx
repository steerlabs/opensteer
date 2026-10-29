import { useState } from "react";
import { requestAgentProposedDetail } from "@opensteer/core";
import type {
  IntegrationAccess,
  IntegrationConnectionSummary,
  IntegrationDashboard,
  IntegrationPlatformDashboardView,
  IntegrationTool,
} from "@opensteer/integration-core";
import type { MachineSummary } from "@opensteer/protocol";
import {
  apiKeyDisclosure,
  computerAppAccessLabel,
  computerAppPlatformRequirementLabel,
  computerAppStateDotClass,
  computerAppStateLabel,
  computerConnectionState,
  computerUseNoMac,
  computerUseStatusLine,
  computerUseView,
  integrationAccountDetail,
  operationCount,
  phoneUseNoPhone,
  phoneUseStatusLine,
  phoneUseView,
} from "@opensteer/client/integrations";
import { Link } from "react-router";
import { Icon } from "../icon.js";
import { ExternalLink } from "../external-link.js";
import { AgentProposedChip } from "./agent-proposed-chip.js";
import { ApiKeyForm } from "./api-key-form.js";
import { connectAvailability, connectableApiKeyMethod } from "@opensteer/client/integrations";
import { ComputerAppPicker } from "../computer-apps/computer-app-picker.js";
import {
  accountRepair,
  accountsFor,
  agentProposed,
  inactiveInstallation,
  isComputerApp,
  mcpAccountsFor,
  statusChipClass,
  statusLabel,
  type DefinedIntegration,
} from "./helpers.js";
import { IntegrationIcon } from "./integration-icon.js";

/**
 * One integration, in full: the user's accounts on it, every way to connect a
 * new one (all derived from the definition's auth methods), and what agents
 * can do with it once granted.
 */
export function IntegrationDetail({
  dashboard,
  error,
  hostConnected,
  integration,
  localMachineId = null,
  machines,
  onBack,
  onConnectApiKey,
  onConnectOauth,
  onDisconnect,
  onDisconnectMcp,
  onInstall,
  onReconnectKey,
  onRepositoryAccess,
  onTurnOnComputer,
  onUninstall,
  pending,
  platform,
  reconnectConnectionId,
}: {
  readonly dashboard: IntegrationDashboard;
  readonly error: string | null;
  readonly hostConnected: boolean;
  readonly integration: DefinedIntegration;
  /** The computer the desktop app showing this page runs on; null in a browser. */
  readonly localMachineId?: string | null;
  /** Every computer this viewer can see, for an app that runs on one. */
  readonly machines: readonly MachineSummary[];
  readonly onBack: () => void;
  readonly onConnectApiKey: (input: {
    readonly authMethodId: string;
    readonly connectionId?: string | undefined;
    readonly displayName?: string | undefined;
    readonly values: Readonly<Record<string, string>>;
  }) => void;
  /** Starts a sign-in; given an account, the sign-in is to reconnect that one. */
  readonly onConnectOauth: (account: IntegrationConnectionSummary | null) => void;
  readonly onDisconnect: (connectionId: string) => void;
  readonly onDisconnectMcp: (connectionId: string) => void;
  /** Installs the catalog snapshot this page shows. */
  readonly onInstall: (digest: string) => void;
  /** Opens key replacement for this connection; null closes the form. */
  readonly onReconnectKey: (connectionId: string | null) => void;
  readonly onRepositoryAccess?: (connectionId: string) => void;
  readonly onTurnOnComputer: (input: {
    readonly access: IntegrationAccess;
    readonly definitionId: string;
    readonly runnerId: string;
  }) => void;
  readonly onUninstall: (installationId: string) => void;
  readonly pending: boolean;
  readonly platform: IntegrationPlatformDashboardView | null;
  /** A connection made with a key that this page replaces the key of. */
  readonly reconnectConnectionId: string | null;
}) {
  const { definition, entry } = integration;
  const proposed = agentProposed(integration.entry);
  const inactive = entry ? inactiveInstallation(definition.name, entry) : null;
  // The Host refuses to connect or call an installation that is not active,
  // so nothing here offers either for one. A preset not yet installed is
  // installed first, below.
  const active = entry?.installation.status === "active";
  // Not a catalog preset: an installation that brought its own definition, such
  // as an agent's proposal, has no other exit from this deployment.
  const removable =
    integration.digest === null && dashboard.isAdministrator
      ? integration.entry.installation.id
      : null;
  const computerApp = isComputerApp(definition);
  // Computer use is set up, and its apps approved, on each Mac's own page: it
  // has one connection per app, not one per computer, so it has no picker here.
  const computerUse = definition.computerApp?.kind === "gui";
  // A phone is added over USB; each phone's page owns its access controls.
  const phoneUse = definition.computerApp?.kind === "display";
  const platformRequirement = computerAppPlatformRequirementLabel(definition);
  const oauthMethod = definition.authMethods.find((method) => method.kind === "oauth");
  const declaresApiKey = definition.authMethods.some((method) => method.kind === "api-key");
  const apiKeyMethod = connectableApiKeyMethod(definition);
  const mcpOauthMethod = definition.authMethods.find((method) => method.kind === "mcp-oauth");
  /** The connection, or installation, whose removal waits for a second click. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Whether the person asked for another key beside the accounts listed. */
  const [addingKey, setAddingKey] = useState(false);
  const accounts = accountsFor(dashboard, definition);
  const mcpAccounts = entry ? mcpAccountsFor(platform, entry) : [];
  const disconnectButton = (connectionId: string, disconnect: (connectionId: string) => void) => (
    <button
      className={`btn btn--small ${confirming === connectionId ? "btn--danger" : ""}`}
      disabled={pending}
      onClick={() => {
        if (confirming === connectionId) disconnect(connectionId);
        else setConfirming(connectionId);
      }}
      type="button"
    >
      {confirming === connectionId ? "Confirm disconnect" : "Disconnect"}
    </button>
  );
  const reconnecting =
    reconnectConnectionId === null
      ? null
      : (dashboard.connections.find(
          ({ connectionMethod, id }) =>
            id === reconnectConnectionId && connectionMethod === "api-key",
        ) ?? null);
  // A key form opens at once with no account to keep, and otherwise on request.
  const keyFormOpen =
    active &&
    apiKeyMethod !== null &&
    (accounts.length === 0 || reconnecting !== null || addingKey);
  const keyFormLinksSetup = keyFormOpen && Boolean(apiKeyDisclosure(definition)?.setupUrl);
  const applicationRequired =
    entry?.servers.some(
      ({ connectionRequirement }) =>
        connectionRequirement.kind === "provider" &&
        connectionRequirement.providerApplicationRequired,
    ) ?? false;
  const availability = connectAvailability(dashboard, definition.provider);
  // Setting up a sign-in app is part of connecting now, so the Connect sheet is
  // the single way in; only a surface that may not launch authorization at all
  // stops it here.
  const connectable = !applicationRequired || availability.kind !== "other-surface";
  const activeTools = entry?.tools.filter(({ status }) => status === "active") ?? [];
  const activeSkills = entry?.skills.filter(({ status }) => status === "active") ?? [];
  // A computer app materializes the same catalog operations once per computer
  // connection, so listing the rows would repeat "Read messages" per computer
  // and overstate what the app does. The rows stay the authorization inventory;
  // this overview describes the contract, which is one list per app.
  const overviewTools = computerApp ? distinctOperations(activeTools) : activeTools;

  return (
    <>
      <button className="page__back" disabled={pending} onClick={onBack} type="button">
        <Icon name="arrow-left" /> All integrations
      </button>

      <header className="intg-hero">
        <IntegrationIcon
          icon={definition.icon}
          id={definition.id}
          name={definition.name}
          size="lg"
        />
        <div className="intg-hero__copy">
          <h2 className="intg-hero__name">{definition.name}</h2>
          <p className="intg-hero__description">{definition.description}</p>
          {/* The requirement is the app's, not this browser's: it says which
              computer can run it, wherever this page is being read. */}
          {platformRequirement ? (
            <p className="intg-hero__requirement">{platformRequirement}</p>
          ) : null}
          {proposed ? (
            <>
              <AgentProposedChip className="intg-provenance" />
              <p className="intg-hero__provenance">{requestAgentProposedDetail}</p>
            </>
          ) : null}
        </div>
        {/* An open key form says where to create the key, so the page does not say it again. */}
        {definition.setupUrl && !keyFormLinksSetup ? (
          <ExternalLink className="btn btn--small intg-hero__setup" href={definition.setupUrl}>
            {new URL(definition.setupUrl).hostname} <Icon name="external-link" />
          </ExternalLink>
        ) : null}
      </header>

      {error ? (
        <div className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </div>
      ) : null}

      {integration.digest !== null && integration.entry === null ? (
        <section className="section">
          <div className="notice notice--accent">
            <Icon name="puzzle" />
            <div>
              <strong>Install this Opensteer preset</strong>
              <p>
                {`Install ${definition.name} so agents can use it.`}
                {oauthMethod
                  ? " You’ll connect your account next."
                  : declaresApiKey
                    ? " You’ll add your key next."
                    : ""}
                {" Installing doesn’t give any Workspace access."}
              </p>
            </div>
          </div>
          {dashboard.isAdministrator ? (
            <button
              className="btn btn--primary"
              disabled={pending}
              onClick={() => onInstall(integration.digest)}
              type="button"
            >
              {pending ? "Installing…" : `Install ${definition.name}`}
            </button>
          ) : (
            <p className="section__hint">
              An administrator of this deployment must install this preset.
            </p>
          )}
        </section>
      ) : null}

      {inactive ? (
        <section className="section">
          <div className="notice notice--error" role="alert">
            <Icon name="alert-circle" />
            <div>
              <strong>{inactive.title}</strong>
              <p>{inactive.detail}</p>
            </div>
          </div>
          {/* Installing a preset again retries a snapshot the Host could not
              use, and leaves one it turned off as it is. Anything else an
              administrator can only uninstall, below. */}
          {integration.digest !== null && inactive.status === "needs-attention" ? (
            dashboard.isAdministrator ? (
              <button
                className="btn btn--primary"
                disabled={pending}
                onClick={() => onInstall(integration.digest)}
                type="button"
              >
                {pending ? "Reinstalling…" : `Reinstall ${definition.name}`}
              </button>
            ) : (
              <p className="section__hint">
                An administrator of this deployment must reinstall this preset.
              </p>
            )
          ) : integration.digest === null && !dashboard.isAdministrator ? (
            <p className="section__hint">An administrator of this deployment can uninstall it.</p>
          ) : null}
        </section>
      ) : null}

      {entry && accounts.length + mcpAccounts.length > 0 ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Connected accounts</h2>
            <span className="section__hint">Permissions apply to the account you choose.</span>
          </div>
          <div className="card">
            {accounts.map((connection) => {
              const computer = connection.computer;
              const state = computer
                ? computerConnectionState({ connection, definition, machines })
                : null;
              // Blocking is the owner's decision, undone on that Mac; it is
              // neither ready nor something to disconnect from here.
              const blocked = Boolean(computer?.blockedAt);
              const machineName =
                machines.find(({ id }) => id === computer?.runnerId)?.name ?? "that Mac";
              const repair = accountRepair(integration, connection);
              const disconnect = (
                <div className="card__row-actions">
                  {repair === "replace-key" && connection.id !== reconnecting?.id ? (
                    <button
                      className="btn btn--primary btn--small"
                      disabled={pending}
                      onClick={() => onReconnectKey(connection.id)}
                      type="button"
                    >
                      Reconnect
                    </button>
                  ) : null}
                  {repair === "sign-in" ? (
                    <button
                      className="btn btn--primary btn--small"
                      disabled={!connectable || pending}
                      onClick={() => onConnectOauth(connection)}
                      type="button"
                    >
                      Reconnect
                    </button>
                  ) : null}
                  {repair === "choose-repositories" && onRepositoryAccess ? (
                    <button
                      className="btn btn--primary btn--small"
                      disabled={pending}
                      onClick={() => onRepositoryAccess(connection.id)}
                      type="button"
                    >
                      Set up repositories
                    </button>
                  ) : null}
                  {computer ? (
                    <Link
                      className="btn btn--small"
                      to={`/settings/computers/${encodeURIComponent(computer.runnerId)}`}
                    >
                      Manage
                    </Link>
                  ) : null}
                  {blocked ? null : disconnectButton(connection.id, onDisconnect)}
                </div>
              );
              return (
                <div className="card__row" key={connection.id}>
                  <div className="card__row-body">
                    <span className="card__row-title">
                      {connection.displayName}
                      {blocked ? (
                        <span className="chip chip--bad">Blocked</span>
                      ) : computer && definition.computerApp ? (
                        <span className="chip">
                          {computerAppAccessLabel(definition.computerApp, computer.access)}
                        </span>
                      ) : (
                        <span className={`chip ${statusChipClass(connection.status)}`}>
                          {statusLabel(connection.status)}
                        </span>
                      )}
                    </span>
                    {blocked ? (
                      <span className="card__row-detail computer-apps__status">
                        <span aria-hidden className="status-dot status-dot--idle" />
                        {`${definition.name} · Unblock on ${machineName}`}
                      </span>
                    ) : computer && state ? (
                      <span className="card__row-detail computer-apps__status">
                        <span
                          aria-hidden
                          className={`status-dot ${computerAppStateDotClass(state)}`}
                        />
                        {`${definition.name} · ${computerAppStateLabel(state)}`}
                      </span>
                    ) : (
                      <span className="card__row-detail">
                        {`${integrationAccountDetail(connection, accounts)} · ${
                          connection.connectionMethod === "api-key" ? "API key" : "OAuth"
                        }`}
                        {connection.statusDetail ? ` · ${connection.statusDetail}` : ""}
                      </span>
                    )}
                  </div>
                  {disconnect}
                </div>
              );
            })}
            {mcpAccounts.map((connection) => (
              <div className="card__row" key={connection.connectionId}>
                <div className="card__row-body">
                  <span className="card__row-title">
                    {connection.displayName}
                    <span className={`chip ${statusChipClass(connection.status)}`}>
                      {statusLabel(connection.status)}
                    </span>
                  </span>
                  <span className="card__row-detail">
                    {`${integrationAccountDetail(
                      { ...connection, id: connection.connectionId },
                      mcpAccounts.map((peer) => ({ ...peer, id: peer.connectionId })),
                    )} · OAuth`}
                  </span>
                </div>
                <div className="card__row-actions">
                  {disconnectButton(connection.connectionId, onDisconnectMcp)}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {active && computerUse ? (
        <ComputerUseMacs
          dashboard={dashboard}
          definition={definition}
          hostConnected={hostConnected}
          localMachineId={localMachineId}
          machines={machines}
        />
      ) : null}

      {active && phoneUse ? (
        <AgentPhones
          dashboard={dashboard}
          definition={definition}
          hostConnected={hostConnected}
          machines={machines}
        />
      ) : null}

      {active && computerApp && !computerUse && !phoneUse ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">
              {accounts.length > 0 ? "Another computer" : "Choose a computer"}
            </h2>
            <span className="section__hint">
              {definition.name} runs on the computer you pick. Agents anywhere in this deployment
              reach it through Opensteer, and nothing else on that computer is opened.
            </span>
          </div>
          <ComputerAppPicker
            busy={pending}
            connections={dashboard.connections}
            definition={definition}
            machines={machines}
            onTurnOn={({ access, runnerId }) =>
              onTurnOnComputer({ access, definitionId: definition.id, runnerId })
            }
          />
        </section>
      ) : null}

      {active && oauthMethod ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">
              {accounts.length > 0 ? "Connect another account" : "Connect your account"}
            </h2>
            <span className="section__hint">
              Connect this {definition.name} service account, then choose the exact tools and skills
              a Workspace may use.
            </span>
          </div>
          {applicationRequired && availability.kind !== "ready" ? (
            <div className="notice notice--warn">
              <Icon name="alert-circle" />
              <div>
                <strong>
                  {availability.kind === "other-surface"
                    ? "Connect this account on the computer running this deployment"
                    : "No sign-in app is ready yet"}
                </strong>
                <p>{availability.detail}</p>
                {availability.kind !== "other-surface" && availability.canSetUpOwnApp ? (
                  <p>Connecting walks through registering your own app.</p>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="form-actions">
            <button
              className="btn btn--primary"
              disabled={!connectable || pending}
              onClick={() => onConnectOauth(null)}
              type="button"
            >
              {pending ? "Opening…" : `Connect ${definition.name}`}
            </button>
          </div>
        </section>
      ) : null}

      {/* A key names no account, so a form left open beside existing ones
          turns a pasted key into another account: it opens on request. */}
      {active && apiKeyMethod && !keyFormOpen ? (
        <section className="section">
          <div className="form-actions">
            <button
              className="btn"
              disabled={pending}
              onClick={() => setAddingKey(true)}
              type="button"
            >
              {oauthMethod ? "Use an API key" : "Add another key"}
            </button>
          </div>
        </section>
      ) : keyFormOpen && apiKeyMethod ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">
              {reconnecting
                ? `Replace the key for ${reconnecting.displayName}`
                : oauthMethod
                  ? "Or use an API key"
                  : accounts.length > 0
                    ? "Add another key"
                    : "Add your API key"}
            </h2>
          </div>
          <div className="card">
            <ApiKeyForm
              definition={definition}
              proposed={proposed}
              {...(reconnecting ? { displayName: reconnecting.displayName } : {})}
              error={error}
              key={reconnecting?.id ?? "new"}
              method={apiKeyMethod}
              onSubmit={({ displayName, values }) =>
                onConnectApiKey({
                  authMethodId: apiKeyMethod.id,
                  ...(reconnecting ? { connectionId: reconnecting.id } : {}),
                  displayName,
                  values,
                })
              }
              pending={pending}
              {...(addingKey || reconnecting
                ? {
                    secondaryAction: (
                      <button
                        className="btn"
                        disabled={pending}
                        onClick={() => {
                          setAddingKey(false);
                          onReconnectKey(null);
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                    ),
                  }
                : {})}
            />
          </div>
        </section>
      ) : null}

      {/* An MCP sign-in begins from the request that names the tools it is
          for, so this page can show and remove its accounts but not start one. */}
      {active && mcpOauthMethod && mcpAccounts.length === 0 ? (
        <section className="section">
          <div className="notice">
            <Icon name="key" />
            <div>
              <strong>No account yet</strong>
              <p>
                When an agent first needs this integration, you’ll review the tools it wants to use
                and sign in. Installing doesn’t give any Workspace access.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {active && mcpOauthMethod && mcpAccounts.some(({ status }) => status !== "connected") ? (
        <section className="section">
          <div className="notice notice--warn">
            <Icon name="alert-circle" />
            <div>
              <strong>Authorize {definition.name} again</strong>
              <p>
                MCP sign-ins start from an agent&apos;s request, which shows the exact tools it
                needs. The next request that needs {definition.name} asks you to authorize it again.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {active && overviewTools.length + activeSkills.length > 0 ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">What agents can do</h2>
            <span className="section__hint">
              {operationCount(overviewTools.length)}
              {activeSkills.length > 0
                ? ` · ${activeSkills.length} skill${activeSkills.length === 1 ? "" : "s"}`
                : ""}
              {computerApp ? ", granted on the computer you pick." : ""}
            </span>
          </div>
          <div className="intg-tool-cloud">
            {activeSkills.map((skill) => (
              <span className="chip chip--scope" key={skill.id} title={skill.description}>
                <Icon name="sparkles" /> {skill.name}
              </span>
            ))}
            {overviewTools.slice(0, 24).map((tool) => (
              <span className="chip chip--scope" key={tool.id} title={tool.description}>
                {tool.title}
              </span>
            ))}
            {overviewTools.length > 24 ? (
              <span className="chip chip--scope">+{overviewTools.length - 24} more</span>
            ) : null}
          </div>
        </section>
      ) : null}

      {removable ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Uninstall</h2>
            <span className="section__hint">
              Removes {definition.name} from this deployment, with every account connected to it and
              its pending requests.
            </span>
          </div>
          <div className="form-actions">
            <button
              className={`btn ${confirming === removable ? "btn--danger" : ""}`}
              disabled={pending}
              onClick={() => {
                if (confirming === removable) onUninstall(removable);
                else setConfirming(removable);
              }}
              type="button"
            >
              {confirming === removable ? "Confirm uninstall" : `Uninstall ${definition.name}`}
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * One row per operation the app's servers offer. Two computers connected to the
 * same app hold identical operation rows, because the catalog — not the
 * computer — defines them.
 */
function distinctOperations(tools: readonly IntegrationTool[]): readonly IntegrationTool[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    const operation = `${tool.serverId}:${tool.name}`;
    if (seen.has(operation)) return false;
    seen.add(operation);
    return true;
  });
}

/** Each Mac that can run Computer use, its state in a line, and the way to its page. */
function ComputerUseMacs({
  dashboard,
  definition,
  hostConnected,
  localMachineId,
  machines,
}: {
  readonly dashboard: IntegrationDashboard | null;
  readonly definition: DefinedIntegration["definition"];
  readonly hostConnected: boolean;
  readonly localMachineId: string | null;
  readonly machines: readonly MachineSummary[];
}) {
  const macs = machines.flatMap((machine) => {
    const view = computerUseView({
      connections: dashboard?.connections ?? [],
      definitions: [definition],
      hostConnected,
      machine,
    });
    return view ? [{ machine, view }] : [];
  });
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Macs</h2>
        <span className="section__hint">
          Set up {definition.name} and choose the apps agents can use on each Mac&apos;s page.
        </span>
      </div>
      <div className="card">
        {macs.length === 0 ? (
          <div className="card__empty computer-use-empty">
            <p className="computer-use-empty__title">{computerUseNoMac.title}</p>
            <p className="computer-use-empty__detail">{computerUseNoMac.detail}</p>
            <Link className="btn btn--small" to="/settings/computers">
              {computerUseNoMac.action}
            </Link>
          </div>
        ) : (
          macs.map(({ machine, view }) => (
            <div className="card__row" key={machine.id}>
              <span className="card__row-glyph">
                <Icon name="laptop" />
              </span>
              <div className="card__row-body">
                <span className="card__row-title">{machine.name}</span>
                <span className="card__row-detail">
                  {computerUseStatusLine(view, {
                    here: machine.id === localMachineId,
                    machineName: machine.name,
                  })}
                </span>
              </div>
              <div className="card__row-actions">
                <Link
                  className="btn btn--small"
                  to={`/settings/computers/${encodeURIComponent(machine.id)}`}
                >
                  Open
                </Link>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/** Each Android phone agents can use, its state in a line, and the way to its page. */
function AgentPhones({
  dashboard,
  definition,
  hostConnected,
  machines,
}: {
  readonly dashboard: IntegrationDashboard | null;
  readonly definition: DefinedIntegration["definition"];
  readonly hostConnected: boolean;
  readonly machines: readonly MachineSummary[];
}) {
  const phones = machines.flatMap((machine) => {
    const view = phoneUseView({
      connections: dashboard?.connections ?? [],
      definitions: [definition],
      hostConnected,
      machine,
    });
    return view ? [{ machine, view }] : [];
  });
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Phones</h2>
        <span className="section__hint">
          Each phone is added from Computers. Set its access on its computer page.
        </span>
      </div>
      <div className="card">
        {phones.length === 0 ? (
          <div className="card__empty computer-use-empty">
            <p className="computer-use-empty__title">{phoneUseNoPhone.title}</p>
            <p className="computer-use-empty__detail">{phoneUseNoPhone.detail}</p>
            <Link className="btn btn--small" to="/settings/computers">
              {phoneUseNoPhone.action}
            </Link>
          </div>
        ) : (
          phones.map(({ machine, view }) => (
            <div className="card__row" key={machine.id}>
              <span className="card__row-glyph">
                <Icon name="phone" />
              </span>
              <div className="card__row-body">
                <span className="card__row-title">{machine.name}</span>
                <span className="card__row-detail">{phoneUseStatusLine(view, machine.name)}</span>
              </div>
              <div className="card__row-actions">
                <Link
                  className="btn btn--small"
                  to={`/settings/computers/${encodeURIComponent(machine.id)}`}
                >
                  Open
                </Link>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
