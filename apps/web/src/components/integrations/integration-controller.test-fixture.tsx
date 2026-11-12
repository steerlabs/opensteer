import { Link } from "react-router";
import type { CreateIntegrationGrant } from "@opensteer/integration-core";

import { ConnectFlow, RepositoryAccessSetup } from "./connect-flow.js";
import { integrationAccountTitle } from "@opensteer/client/integrations";

import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageHeader, PageTopbar } from "../page-header.js";
import { AccountsSection } from "./accounts-section.js";
import { ComputerAppConnectionsSection } from "./computer-apps-section.js";
import { IntegrationInstaller } from "./admin-forms.js";
import {
  AddServiceSection,
  InstalledServicesSection,
  PluginsAndMcpSection,
} from "./catalog-section.js";
import { GrantsSection, workspaceAccessSectionId } from "./grants-section.js";
import { platformIntegrations } from "./helpers.js";
import { IntegrationDetail } from "./integration-detail.js";
import { canRespondToRequests, mutationIdempotencyKey } from "@opensteer/client/host";

import {
  useIntegrationEditor,
  integrationResultTitle,
  integrationResultDetail,
  authorizationReturnPath,
} from "./use-integration-editor.js";
/** Test-only composition preserving controller authority and race regressions. */
export function IntegrationControllerFixture(props: Parameters<typeof useIntegrationEditor>[0]) {
  const {
    client,
    embedded,
    rootRef,
    openMobileNavigation,
    readError,
    view,
    result,
    workspaceKind,
    repositorySetup,
    pending,
    recheckRepositorySetup,
    error,
    notice,
    dashboard,
    integrations,
    platform,
    disconnectConnection,
    disconnectMcpConnection,
    setError,
    setView,
    setUpRepositories,
    signIn,
    snapshot,
    grants,
    run,
    selectedWorkspaceId,
    simpleAction,
    setWorkspaceId,
    setNotice,
    uninstallIntegration,
    detailIntegration,
    localMachineId,
    hostName,
    connectApiKey,
    openAt,
    installCatalog,
    turnOnComputerApp,
    installRemoteMcp,
    connectIntegration,
    connecting,
    setConnecting,
    reload,
    toast,
    connectOperations,
    openDetail,
  } = useIntegrationEditor(props);
  const { installations: otherInstallations } = platformIntegrations(platform);
  return (
    <div className={embedded ? "connected-apps__panel" : "page"} ref={rootRef}>
      {embedded ? null : (
        <PageTopbar onOpenNavigation={openMobileNavigation} title="Integrations" />
      )}
      <div className="page__inner">
        {/* Embedded, the Connected apps heading and its tab already name this page. */}
        {embedded ? null : (
          <PageHeader
            back={
              <Link className="page__back" to="/settings/plugins">
                <Icon name="arrow-left" />
                Settings
              </Link>
            }
            description="Connect your accounts, install integrations, and decide exactly which tools each project can use."
            eyebrow="Connections"
            title="Integrations"
          />
        )}

        {readError ? (
          <div className="notice notice--error" role="alert">
            <Icon name="alert-circle" />
            <span>{readError}</span>
          </div>
        ) : null}

        {view.kind === "overview" ? (
          <>
            {result ? (
              <div
                className={`notice ${result.status === "connected" ? "notice--accent" : "notice--warn"}`}
              >
                <Icon name={result.status === "connected" ? "check-circle" : "alert-circle"} />
                <div>
                  <strong>{integrationResultTitle(result)}</strong>
                  <p>
                    {result.status === "connected"
                      ? workspaceKind === "main"
                        ? "The account is ready for Opensteer and your tasks."
                        : "The account is ready for exact tools you authorize."
                      : integrationResultDetail(result.status)}
                  </p>
                </div>
              </div>
            ) : null}
            {repositorySetup ? (
              <div className="card card--padded">
                <RepositoryAccessSetup access={repositorySetup.access} />
                <div className="form-actions">
                  <button
                    className="btn btn--primary"
                    disabled={pending}
                    onClick={() => void recheckRepositorySetup()}
                    type="button"
                  >
                    {pending ? "Checking…" : "Recheck repository access"}
                  </button>
                </div>
              </div>
            ) : null}
            {error ? (
              <div className="notice notice--error" role="alert">
                <Icon name="alert-circle" />
                <span>{error}</span>
              </div>
            ) : null}
            {notice ? (
              <div className="notice notice--warn">
                <Icon name="alert-circle" />
                <div>
                  <strong>{notice.title}</strong>
                  <p>{notice.detail}</p>
                </div>
              </div>
            ) : null}
            {!dashboard && !readError ? (
              <div className="card">
                <LoadingRows label="Loading integrations" />
              </div>
            ) : (
              <>
                <InstalledServicesSection
                  dashboard={dashboard}
                  integrations={integrations}
                  onOpen={openDetail}
                  platform={platform}
                />
                <AccountsSection
                  dashboard={dashboard}
                  integrations={integrations}
                  onDisconnect={(connectionId) => disconnectConnection(connectionId)}
                  onDisconnectMcp={(connectionId) => disconnectMcpConnection(connectionId)}
                  onOpen={openDetail}
                  onReconnectKey={(definitionId, reconnectConnectionId) => {
                    setError(null);
                    setView({ definitionId, kind: "detail", reconnectConnectionId });
                  }}
                  onRepositoryAccess={setUpRepositories}
                  onSignIn={signIn}
                  pending={pending}
                  platform={platform}
                />
                <ComputerAppConnectionsSection
                  dashboard={dashboard}
                  integrations={integrations}
                  machines={snapshot.machines}
                />
                <GrantsSection
                  dashboard={dashboard}
                  grants={grants}
                  loading={grants === null && !readError}
                  onCreate={async (input: CreateIntegrationGrant) => {
                    await run(async () => {
                      await client.dispatch({
                        idempotencyKey: mutationIdempotencyKey(
                          `integration-grant:${input.workspaceId}`,
                        ),
                        input,
                        type: "integration.grant.create",
                      });
                    });
                  }}
                  onRevoke={(grantId) =>
                    selectedWorkspaceId
                      ? simpleAction(() =>
                          client
                            .dispatch({
                              grantId,
                              idempotencyKey: mutationIdempotencyKey(
                                `integration-grant:${grantId}`,
                              ),
                              type: "integration.grant.revoke",
                            })
                            .then(() => undefined),
                        )
                      : undefined
                  }
                  onWorkspace={setWorkspaceId}
                  pending={pending}
                  platform={platform}
                  workspaceId={selectedWorkspaceId}
                  workspaceKind={workspaceKind}
                  workspaces={snapshot.workspaces}
                />
                <PluginsAndMcpSection
                  entries={otherInstallations.filter(
                    (e) => e.installation.sourceKind !== "plugin" || e.servers.length > 0,
                  )}
                  isAdministrator={dashboard?.isAdministrator ?? false}
                  onInstall={() => {
                    setError(null);
                    setNotice(null);
                    setView({ kind: "install" });
                  }}
                  onUninstall={(installationId) => void uninstallIntegration(installationId)}
                  pending={pending}
                />
                <AddServiceSection
                  dashboard={dashboard}
                  integrations={integrations}
                  onOpen={openDetail}
                  platform={platform}
                />
              </>
            )}
          </>
        ) : null}

        {view.kind === "detail" && detailIntegration && dashboard ? (
          <IntegrationDetail
            dashboard={dashboard}
            error={error}
            hostConnected={canRespondToRequests(snapshot)}
            hostName={hostName}
            integration={detailIntegration}
            localMachineId={localMachineId}
            machines={snapshot.machines}
            onBack={() => {
              setError(null);
              setView({ kind: "overview" });
            }}
            onConnectApiKey={(input) =>
              void connectApiKey({ ...input, definitionId: detailIntegration.definition.id })
            }
            reconnectConnectionId={
              view.kind === "detail" ? (view.reconnectConnectionId ?? null) : null
            }
            onChooseSignIn={() => signIn(detailIntegration.definition.id, null, true)}
            onConnectOauth={(account) => signIn(detailIntegration.definition.id, account)}
            onWorkspaceAccess={() => {
              openAt.current = workspaceAccessSectionId;
              setError(null);
              setView({ kind: "overview" });
            }}
            onDisconnect={(connectionId) => disconnectConnection(connectionId)}
            onDisconnectMcp={(connectionId) => disconnectMcpConnection(connectionId)}
            onInstall={(digest) =>
              void installCatalog({ definitionId: detailIntegration.definition.id, digest })
            }
            onReconnectKey={(reconnectConnectionId) => {
              setError(null);
              setView({
                definitionId: detailIntegration.definition.id,
                kind: "detail",
                ...(reconnectConnectionId === null ? {} : { reconnectConnectionId }),
              });
            }}
            onRepositoryAccess={setUpRepositories}
            onTurnOnComputer={(input) => turnOnComputerApp(input)}
            onUninstall={(installationId) => void uninstallIntegration(installationId)}
            pending={pending}
            platform={platform}
          />
        ) : null}

        {view.kind === "install" && dashboard?.isAdministrator ? (
          <IntegrationInstaller
            error={error}
            onBack={() => {
              setError(null);
              setView({ kind: "overview" });
            }}
            onRemoteMcp={(input) => void installRemoteMcp(input)}
            pending={pending}
          />
        ) : null}

        {connectIntegration && dashboard ? (
          <ConnectFlow
            begun={connecting?.begun ?? null}
            dashboard={dashboard}
            definition={connectIntegration.definition}
            key={connecting?.definitionId}
            onClose={() => {
              setConnecting(null);
              // The sheet can change an account without connecting it: a
              // sign-in GitHub rejected now needs Reconnect, not repositories.
              void reload().catch(() => undefined);
            }}
            onConnected={(connectionId) => {
              // The account's own row says it is connected; the sheet has nothing left to show.
              setConnecting(null);
              void reload()
                .then((loaded) => {
                  const connection = loaded?.connections.find(({ id }) => id === connectionId);
                  toast.success(
                    `${connection ? integrationAccountTitle(connection) : connectIntegration.definition.name} is connected`,
                  );
                })
                .catch(() => undefined);
            }}
            operations={connectOperations}
            purpose={
              connecting?.account
                ? `Sign in to ${connectIntegration.definition.name} as ${
                    connecting.account.accountIdentifier?.trim() || connecting.account.displayName
                  } to reconnect it.`
                : `Sign in with the ${connectIntegration.definition.name} account you want agents to use.`
            }
            returnPath={authorizationReturnPath}
          />
        ) : null}
      </div>
    </div>
  );
}
