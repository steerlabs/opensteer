import { Link } from "react-router";
import type { CreateIntegrationGrant } from "@opensteer/integration-core";

import { ConnectFlow, RepositoryAccessSetup } from "./connect-flow.js";
import { integrationAccountTitle } from "@opensteer/client/integrations";

import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageHeader, PageTopbar } from "../page-header.js";
import { IntegrationInstaller } from "./admin-forms.js";
import { GrantsSection, agentAccessSectionId } from "./grants-section.js";
import { message } from "./helpers.js";
import { IntegrationDetail } from "./integration-detail.js";
import { canRespondToRequests, mutationIdempotencyKey } from "@opensteer/client/host";

import {
  useIntegrationEditor,
  integrationResultTitle,
  integrationResultDetail,
  authorizationReturnPath,
} from "./use-integration-editor.js";
export function IntegrationsPage(props: Parameters<typeof useIntegrationEditor>[0]) {
  const {
    client,
    embedded,
    rootRef,
    openMobileNavigation,
    readError,
    view,
    result,
    repositorySetup,
    pending,
    recheckRepositorySetup,
    error,
    notice,
    dashboard,
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
    simpleAction,
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
    onConnected,
    headerAction,
    children,
    revealAccess,
    setRevealAccess,
    navigate,
  } = useIntegrationEditor(props);
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
            description="Connect your accounts, install integrations, and decide exactly which tools your agent can use."
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
                      ? "The account is ready for the tools you allow your agent."
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
            {!dashboard && !readError && !children ? (
              <div className="card">
                <LoadingRows label="Loading integrations" />
              </div>
            ) : (
              <>
                {revealAccess ? (
                  <GrantsSection
                    dashboard={dashboard}
                    grants={grants}
                    loading={grants === null && !readError}
                    onCreate={async (input: CreateIntegrationGrant) => {
                      await run(async () => {
                        await client.dispatch({
                          idempotencyKey: mutationIdempotencyKey(
                            `integration-grant:${input.installationId}`,
                          ),
                          input,
                          type: "integration.grant.create",
                        });
                      });
                    }}
                    onRevoke={(grantId) =>
                      simpleAction(() =>
                        client
                          .dispatch({
                            grantId,
                            idempotencyKey: mutationIdempotencyKey(`integration-grant:${grantId}`),
                            type: "integration.grant.revoke",
                          })
                          .then(() => undefined),
                      )
                    }
                    pending={pending}
                    platform={platform}
                  />
                ) : null}
              </>
            )}
          </>
        ) : null}

        {view.kind === "overview" ? children : null}
        {view.kind === "detail" && detailIntegration && dashboard ? (
          <IntegrationDetail
            headerAction={headerAction}
            dashboard={dashboard}
            error={error}
            hostConnected={canRespondToRequests(snapshot)}
            hostName={hostName}
            integration={detailIntegration}
            localMachineId={localMachineId}
            machines={snapshot.machines}
            onBack={() => {
              setError(null);
              void navigate("/settings/plugins");
            }}
            onConnectApiKey={(input) =>
              void connectApiKey({ ...input, definitionId: detailIntegration.definition.id })
            }
            reconnectConnectionId={
              view.kind === "detail" ? (view.reconnectConnectionId ?? null) : null
            }
            onChooseSignIn={() => signIn(detailIntegration.definition.id, null, true)}
            onConnectOauth={(account) => signIn(detailIntegration.definition.id, account)}
            onAgentAccess={() => {
              openAt.current = agentAccessSectionId;
              setRevealAccess(true);
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
                .then(async (loaded) => {
                  await onConnected?.(connectionId);
                  const connection = loaded?.connections.find(({ id }) => id === connectionId);
                  toast.success(
                    `${connection ? integrationAccountTitle(connection) : connectIntegration.definition.name} is connected`,
                  );
                })
                .catch((reason: unknown) => setError(message(reason)));
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
