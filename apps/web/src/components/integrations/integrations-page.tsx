import { useIntegrationAuthorizationTracking } from "../../integrations/use-integration-authorization-tracking.js";
import { RunnerIdSchema } from "@opensteer/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type {
  CreateIntegrationGrant,
  IntegrationAccess,
  IntegrationAuthorizationStart,
  IntegrationConnectionSummary,
  IntegrationDashboard,
  IntegrationGrant,
  IntegrationPlatformDashboardView,
  IntegrationAuthorizationStatus,
  IntegrationRepositoryAccess,
  InstallRemoteMcp,
} from "@opensteer/integration-core";
import {
  IntegrationAuthorizationAttemptIdSchema,
  IntegrationConnectionIdSchema,
} from "@opensteer/integration-core";
import { useShell } from "../app-shell.js";
import { currentDeviceMachineId } from "../computers-page.js";
import {
  integrationAuthorizationError,
  waitForIntegrationAuthorization,
} from "../../integrations/integration-authorization.js";
import { ConnectFlow, RepositoryAccessSetup } from "./connect-flow.js";
import {
  authorizationConnection,
  connectAvailability,
  initialConnectSource,
  integrationAccountTitle,
  repositoryAccountStep,
} from "@opensteer/client/integrations";
import { selectedDeploymentFrom } from "../../desktop/desktop-deployment-selection.js";
import { settingsDeploymentName } from "../settings/copy.js";
import { createConnectOperations } from "./connect-operations.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageHeader, PageTopbar } from "../page-header.js";
import { useToast } from "../toast.js";
import { AccountsSection } from "./accounts-section.js";
import { ComputerAppConnectionsSection } from "./computer-apps-section.js";
import { IntegrationInstaller } from "./admin-forms.js";
import {
  AddServiceSection,
  installationRowId,
  InstalledServicesSection,
  PluginsAndMcpSection,
} from "./catalog-section.js";
import { GrantsSection, workspaceAccessSectionId } from "./grants-section.js";
import { message, platformIntegrations, providerLabel } from "./helpers.js";
import { IntegrationDetail } from "./integration-detail.js";
import {
  canRespondToRequests,
  mutationIdempotencyKey,
  unwrapRpcResult,
} from "@opensteer/client/host";

type View =
  | { readonly kind: "overview" }
  | {
      readonly definitionId: string;
      readonly kind: "detail";
      /** A connection made with a key whose key the page replaces. */
      readonly reconnectConnectionId?: string;
    }
  | { readonly kind: "install" };

interface IntegrationResult {
  /** What the account was connected to, as the person knows it. */
  readonly name: string | null;
  readonly status: "connected" | "denied" | "cancelled" | "expired" | "failed";
}

/** Routed integrations surface: catalog, accounts, and Workspace grants. */
export function IntegrationsPage({ embedded = false }: { readonly embedded?: boolean }) {
  const {
    deploymentAccess,
    desktopBridge,
    desktopDeployment,
    hostClient: client,
    localExecutionStatus,
    openMobileNavigation,
    snapshot,
  } = useShell();
  // Only the desktop app knows which computer it runs on; a browser is never "here".
  const localMachineId =
    desktopBridge === null
      ? null
      : currentDeviceMachineId({
          deploymentKind: snapshot.deploymentShape?.kind ?? null,
          hostsDeploymentOnThisComputer: desktopDeployment?.onThisComputer === true,
          localRunnerId: localExecutionStatus?.runner.runnerId ?? null,
          machines: snapshot.machines,
        });
  const hostName = settingsDeploymentName({
    deployment: selectedDeploymentFrom(deploymentAccess, desktopDeployment),
    identityConfig: snapshot.identityConfig,
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const homeWorkspaceId =
    snapshot.homeWorkspaceId ??
    snapshot.workspaces.find((workspace) => workspace.kind === "main")?.id ??
    snapshot.workspaces[0]?.id ??
    null;
  const [workspaceId, setWorkspaceId] = useState<string | null>(homeWorkspaceId);
  const selectedWorkspaceId = workspaceId ?? homeWorkspaceId;
  const workspace =
    snapshot.workspaces.find((candidate) => candidate.id === selectedWorkspaceId) ?? null;
  const workspaceKind: "main" | "specialized" =
    workspace?.kind === "specialized" ? "specialized" : "main";

  const [dashboard, setDashboard] = useState<IntegrationDashboard | null>(null);
  const [platform, setPlatform] = useState<IntegrationPlatformDashboardView | null>(null);
  const [loadedGrants, setLoadedGrants] = useState<{
    readonly grants: readonly IntegrationGrant[];
    readonly workspaceId: string;
  } | null>(null);
  // Grants read for another Workspace are not this one's, even for a moment:
  // until a read for this one answers, its access is unknown, not empty.
  const grants = loadedGrants?.workspaceId === selectedWorkspaceId ? loadedGrants.grants : null;
  /**
   * The Workspace selected now. An action started under another one reloads
   * after the person has changed it, and reads for this one.
   */
  const selectedWorkspace = useRef(selectedWorkspaceId);
  selectedWorkspace.current = selectedWorkspaceId;
  /** The newest read still out, and the answer its callers and older ones wait for. */
  const latestRead = useRef<{
    readonly answer: PromiseWithResolvers<IntegrationDashboard | null>;
    readonly read: Promise<unknown>;
  } | null>(null);
  const [view, setView] = useState<View>({ kind: "overview" });
  const rootRef = useRef<HTMLDivElement>(null);
  const page = view.kind === "detail" ? view.definitionId : null;
  /** A section of the overview the next view change opens at, rather than its top. */
  const openAt = useRef<string | null>(null);
  // The overview and each integration's page are one Connected apps scroll
  // owner, so a page opens at its top, not at the offset the last one was left.
  useLayoutEffect(() => {
    const anchor = openAt.current === null ? null : document.getElementById(openAt.current);
    openAt.current = null;
    if (anchor) {
      anchor.scrollIntoView({ block: "start" });
      return;
    }
    const scroller = rootRef.current?.closest(".connected-apps__inner, .page");
    if (scroller) scroller.scrollTop = 0;
  }, [page]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    readonly detail: string;
    readonly title: string;
  } | null>(null);
  const [result, setResult] = useState<IntegrationResult | null>(null);
  /**
   * The definition whose Connect sheet is open, and the account it signs in
   * again as when it is reconnecting one; the sheet owns its own attempt.
   */
  const [connecting, setConnecting] = useState<{
    readonly account: IntegrationConnectionSummary | null;
    /** The sign-in the click began, which the sheet follows; absent, the sheet asks first. */
    readonly begun: Promise<IntegrationAuthorizationStart> | null;
    readonly definitionId: string;
  } | null>(null);
  const [repositorySetup, setRepositorySetup] = useState<{
    readonly access: IntegrationRepositoryAccess | null;
    readonly connectionId: string;
  } | null>(null);
  const toast = useToast();
  const tracking = useIntegrationAuthorizationTracking();
  const connectOperations = useMemo(
    () => createConnectOperations(client, tracking),
    [client, tracking],
  );

  // A web callback returns only the opaque attempt id. The authenticated
  // status resource remains the authority for the outcome.
  useEffect(() => {
    if (connecting) return;
    const returned = searchParams.get("integrationAttempt");
    if (!returned) return;
    // A callback query is an identifier, never a result: an unreadable one is
    // simply not an attempt this Host will answer for.
    const parsed = IntegrationAuthorizationAttemptIdSchema.safeParse(returned);
    if (!parsed.success) return;
    const attemptId = parsed.data;
    // Opening a sign-in cancels the return, which runs again once the sheet
    // closes. A check that takes the return's repository step aborts it
    // instead, and the return is finished then: its own check may still be
    // out when a sheet is opened and closed.
    let cancelled = false;
    let terminal = false;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      if (!cancelled) tracking.finished(attemptId);
    });
    // The return names the attempt and nothing else. An attempt the provider
    // has not finished answering is still running, so this keeps reading it
    // until the Host calls it terminal or its own window closes.
    void waitForIntegrationAuthorization({ attemptId, client, signal: controller.signal })
      .then(async (status) => {
        if (controller.signal.aborted) return;
        terminal = true;
        setError(integrationAuthorizationError(status.status, status.failureCode));
        const loaded = await reload().catch(() => null);
        if (loaded === null || controller.signal.aborted) return;
        // The attempt saying "completed" is half the answer; a connected row is
        // the other half, and without it nothing here reports a connection.
        const connection = loaded ? authorizationConnection(loaded, status.connectionId) : null;
        if (connection?.provider === "github") {
          // The repository step is this return's answer, not a result shown before it.
          takeRepositoryStep(controller);
          setRepositorySetup({ access: null, connectionId: connection.id });
          setResult(null);
          const access = await checkRepositorySetup(connection.id, controller.signal);
          if (access === null) return;
          if (!access.ready) {
            updateRepositorySetup(connection.id, access);
            return;
          }
          closeRepositorySetup(connection.id);
        }
        setResult({
          name: connection ? providerLabel(connection.provider) : null,
          status:
            status.status === "completed" && !connection
              ? "failed"
              : authorizationResultStatus(status.status),
        });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(message(reason));
      })
      .finally(() => {
        if (cancelled || !terminal) return;
        tracking.finished(attemptId);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, connectOperations, connecting, searchParams, tracking]);

  /**
   * The one repository check that may change the repository step and what the
   * page says about it: the browser return's once it opens its step, a
   * recheck, or "Set up repositories". Each takes the step from the one
   * before, which then changes nothing.
   */
  const repositoryCheck = useRef<AbortController | null>(null);
  const takeRepositoryStep = (controller = new AbortController()): AbortSignal => {
    repositoryCheck.current?.abort();
    repositoryCheck.current = controller;
    return controller.signal;
  };

  /**
   * GitHub's repository check from this page. After a refusal the page reloads
   * and follows the Host (`repositoryAccountStep`): an account that needs a
   * sign-in offers Reconnect in its own row, and its repository step closes.
   * Answers no access to show after a refusal, or once the check no longer
   * owns the step.
   */
  async function checkRepositorySetup(
    connectionId: string,
    signal: AbortSignal,
  ): Promise<IntegrationRepositoryAccess | null> {
    try {
      const access = await connectOperations.checkRepositoryAccess(connectionId);
      return signal.aborted ? null : access;
    } catch (reason) {
      if (signal.aborted) return null;
      setError(message(reason));
      // An account that cannot be reloaded keeps its repository step.
      const loaded = await reload().catch(() => null);
      if (signal.aborted) return null;
      const next = loaded === null ? null : repositoryAccountStep(loaded, connectionId);
      if (next === null || next.kind === "repository-access") return null;
      closeRepositorySetup(connectionId);
      if (next.kind === "sign-in") setError(next.detail ?? message(reason));
      else {
        setError(null);
        setResult({ name: providerLabel("github"), status: "connected" });
      }
      return null;
    }
  }

  /**
   * A check answers only its own account's step: "Set up repositories" checks
   * one account while another's step can be open.
   */
  const updateRepositorySetup = (connectionId: string, access: IntegrationRepositoryAccess) =>
    setRepositorySetup((current) =>
      current?.connectionId === connectionId ? { access, connectionId } : current,
    );
  const closeRepositorySetup = (connectionId: string) =>
    setRepositorySetup((current) => (current?.connectionId === connectionId ? null : current));

  const recheckRepositorySetup = async (): Promise<void> => {
    if (!repositorySetup) return;
    const { connectionId } = repositorySetup;
    const signal = takeRepositoryStep();
    setPending(true);
    setError(null);
    try {
      const access = await checkRepositorySetup(connectionId, signal);
      if (access === null) return;
      if (!access.ready) {
        updateRepositorySetup(connectionId, access);
        return;
      }
      const loaded = await reload().catch(() => null);
      if (loaded === null || signal.aborted) return;
      closeRepositorySetup(connectionId);
      setResult({ name: providerLabel("github"), status: "connected" });
    } finally {
      setPending(false);
    }
  };

  /**
   * Every read of the page's data. Reads overlap: the first load, a Workspace
   * change, the reload after a change, a browser return. Only the newest
   * commits, with the grants of the Workspace it read them for, and every
   * caller still waiting gets its answer then. An older request still out is
   * ignored, so nothing is derived from a snapshot the page has already
   * replaced, and no change stays pending behind it.
   */
  function reload(): Promise<IntegrationDashboard | null> {
    const workspaceId = selectedWorkspace.current;
    if (!workspaceId) return Promise.resolve(null);
    setReadError(null);
    setLoadedGrants(null);
    const read = Promise.all([
      client.rpc["integrations.get"]({}).then(unwrapRpcResult),
      client.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
      client.rpc["integration.grants.list"]({ workspaceId }).then(
        (response) => unwrapRpcResult(response).grants,
      ),
    ]);
    const answer =
      latestRead.current?.answer ?? Promise.withResolvers<IntegrationDashboard | null>();
    latestRead.current = { answer, read };
    void read.then(
      ([loaded, loadedPlatform, grants]) => {
        if (latestRead.current?.read !== read) return;
        latestRead.current = null;
        setReadError(null);
        setDashboard(loaded);
        setPlatform(loadedPlatform);
        setLoadedGrants({ grants, workspaceId });
        answer.resolve(loaded);
      },
      (reason: unknown) => {
        if (latestRead.current?.read !== read) return;
        latestRead.current = null;
        setReadError(message(reason));
        answer.reject(reason);
      },
    );
    return answer.promise;
  }

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [client, selectedWorkspaceId]);

  const { installations: otherInstallations, integrations } = useMemo(
    () => platformIntegrations(platform),
    [platform],
  );
  const detailIntegration =
    view.kind === "detail"
      ? (integrations.find(({ definition }) => definition.id === view.definitionId) ?? null)
      : null;
  const connectIntegration =
    connecting === null
      ? null
      : (integrations.find(({ definition }) => definition.id === connecting.definitionId) ?? null);
  /**
   * Deep link from a Thread action card. The caller knows a provider or a
   * definition id, never an installation id, so both resolve here — an
   * integration with a definition, catalog or proposed, opens its detail view,
   * anything else scrolls its installed row in.
   */
  const focusParam = searchParams.get("provider");
  useEffect(() => {
    if (!focusParam || !platform) return;
    const defined =
      integrations.find(({ definition }) => definition.id === focusParam) ??
      integrations.find(({ definition }) => definition.provider === focusParam);
    if (defined) {
      setError(null);
      setView({ definitionId: defined.definition.id, kind: "detail" });
    } else {
      const installed = otherInstallations.find(
        ({ installation }) => installation.id === focusParam || installation.name === focusParam,
      );
      if (installed) {
        document
          .getElementById(installationRowId(installed.installation.id))
          ?.scrollIntoView({ block: "center" });
      }
    }
    const next = new URLSearchParams(searchParams);
    next.delete("provider");
    setSearchParams(next, { replace: true });
  }, [focusParam, integrations, otherInstallations, platform, searchParams, setSearchParams]);

  async function run<T>(operation: () => Promise<T>, options?: { readonly keepView?: boolean }) {
    setPending(true);
    if (!options?.keepView) setError(null);
    try {
      let result: T;
      try {
        result = await operation();
      } catch (reason) {
        setError(message(reason));
        throw reason;
      }
      await reload();
      return result;
    } finally {
      setPending(false);
    }
  }

  async function connectApiKey(input: {
    readonly authMethodId: string;
    readonly connectionId?: string | undefined;
    readonly definitionId: string;
    readonly displayName?: string | undefined;
    readonly values: Readonly<Record<string, string>>;
  }) {
    try {
      await run(async () => {
        await client.dispatch({
          idempotencyKey: mutationIdempotencyKey(`integration-key:${input.definitionId}`),
          input: {
            authMethodId: input.authMethodId,
            ...(input.connectionId === undefined
              ? {}
              : { connectionId: IntegrationConnectionIdSchema.parse(input.connectionId) }),
            definitionId: input.definitionId,
            displayName: input.displayName,
            values: { ...input.values },
          },
          type: "integration.apiKey.connect",
        });
      });
      setResult({
        name:
          integrations.find(({ definition }) => definition.id === input.definitionId)?.definition
            .name ?? null,
        status: "connected",
      });
      setView({ kind: "overview" });
    } catch {
      /* surfaced inline */
    }
  }

  async function installAgentPlugin(directory: string, runnerId: string | null) {
    try {
      const installed = await run(async () => {
        const installed = await client.dispatch({
          idempotencyKey: mutationIdempotencyKey("integration-plugin"),
          input: { directory, ...(runnerId ? { runnerId } : {}) },
          type: "integration.agentPlugin.install",
        });
        if (installed.type !== "integration.agentPlugin.install") {
          throw new Error("Integration plugin command mismatch.");
        }
        return installed;
      });
      if (installed.issues.length > 0) {
        setNotice({
          detail: `Installed with ${installed.issues.length} skipped component${installed.issues.length === 1 ? "" : "s"}: ${installed.issues
            .slice(0, 3)
            .map(({ entry, message: issue }) => `${entry ?? "plugin"}: ${issue}`)
            .join("; ")}`,
          title: "Installation result",
        });
      } else {
        setNotice(null);
        toast.success("Agent plugin installed.");
      }
      setView({ kind: "overview" });
    } catch {
      /* surfaced inline */
    }
  }

  async function installRemoteMcp(input: InstallRemoteMcp) {
    try {
      await run(async () => {
        await client.dispatch({
          idempotencyKey: mutationIdempotencyKey("integration-remote-mcp"),
          input,
          type: "integration.remoteMcp.install",
        });
      });
      setView({ kind: "overview" });
    } catch {
      /* surfaced inline */
    }
  }

  /**
   * Removal takes the installation's dependents with it, and the counts the
   * Host returns are the only place the user learns what else went.
   */
  async function uninstallIntegration(installationId: string) {
    try {
      const removed = await run(async () => {
        const removed = await client.dispatch({
          idempotencyKey: mutationIdempotencyKey(`integration-uninstall:${installationId}`),
          installationId,
          type: "integration.uninstall",
        });
        if (removed.type !== "integration.uninstall") {
          throw new Error("Integration uninstall command mismatch.");
        }
        return removed;
      });
      // An integration uninstalled from its own page has nothing left to show.
      setView({ kind: "overview" });
      setNotice(
        removed.removedConnections === 0 && removed.cancelledRequests === 0
          ? null
          : {
              detail: `${removed.removedConnections} connected account${
                removed.removedConnections === 1 ? "" : "s"
              } removed, ${removed.cancelledRequests} pending request${
                removed.cancelledRequests === 1 ? "" : "s"
              } cancelled.`,
              title: "Uninstall result",
            },
      );
    } catch {
      /* surfaced inline */
    }
  }

  async function installCatalog(input: { readonly definitionId: string; readonly digest: string }) {
    try {
      await run(
        async () => {
          await client.dispatch({
            idempotencyKey: mutationIdempotencyKey(`integration-catalog:${input.definitionId}`),
            input,
            type: "integration.catalog.install",
          });
        },
        { keepView: true },
      );
    } catch {
      /* surfaced inline */
    }
  }

  const simpleAction = (operation: () => Promise<void>) => {
    void run(operation).catch(() => {
      /* surfaced inline */
    });
  };

  /**
   * Opensteer forgets the credential either way; whether the provider did is
   * something only the Host knows, and the user has to be told when it did not
   * so they can finish the revocation themselves.
   */
  const disconnectConnection = (connectionId: string) =>
    simpleAction(async () => {
      const disconnected = await client.dispatch({
        connectionId,
        idempotencyKey: mutationIdempotencyKey(`integration-disconnect:${connectionId}`),
        type: "integration.disconnect",
      });
      if (disconnected.type !== "integration.disconnect") {
        throw new Error("Integration disconnect command mismatch.");
      }
      setNotice(
        disconnected.notice === null
          ? null
          : { detail: disconnected.notice, title: "Token not revoked at the provider" },
      );
    });

  const disconnectMcpConnection = (connectionId: string) =>
    simpleAction(() =>
      client
        .dispatch({
          connectionId,
          idempotencyKey: mutationIdempotencyKey(`integration-mcp-disconnect:${connectionId}`),
          type: "integration.mcp.disconnect",
        })
        .then(() => undefined),
    );

  /**
   * Turning an app on for one computer. It is the connect step for a computer
   * definition, so it lands back on the same overview a sign-in would.
   */
  const turnOnComputerApp = (input: {
    readonly access: IntegrationAccess;
    readonly definitionId: string;
    readonly runnerId: string;
  }) =>
    simpleAction(async () => {
      const result = await client.dispatch({
        idempotencyKey: mutationIdempotencyKey(`integration-computer:${input.definitionId}`),
        input: {
          access: input.access,
          app: null,
          definitionId: input.definitionId,
          kind: "app",
          runnerId: RunnerIdSchema.parse(input.runnerId),
        },
        type: "integration.computer.setup.request",
      });
      if (result.type !== "integration.computer.setup.request") {
        throw new Error("Integration computer command mismatch.");
      }
      setNotice({
        title: "Setup requested",
        detail: `On ${snapshot.machines.find((machine) => machine.id === input.runnerId)?.name ?? "that computer"}, open Opensteer → Settings → Computers to approve this app.`,
      });
    });

  const openDetail = (definitionId: string) => {
    setError(null);
    setView({ definitionId, kind: "detail" });
  };

  /**
   * Connect or reconnect goes straight to the provider when the Host has an app
   * selected that this device can finish with. It begins inside the click, the
   * only moment a browser tab may open, and the sheet follows it from there.
   * Anything left to choose opens the sheet on that choice instead.
   */
  const signIn = (
    definitionId: string,
    account: IntegrationConnectionSummary | null,
    choose = false,
  ) => {
    setError(null);
    setResult(null);
    const provider = integrations.find(({ definition }) => definition.id === definitionId)
      ?.definition.provider;
    const source =
      !choose && dashboard && provider && connectAvailability(dashboard, provider).kind === "ready"
        ? initialConnectSource(dashboard, provider)
        : null;
    const begun = source
      ? connectOperations.beginAuthorization({
          applicationSource: source,
          definitionId,
          returnPath: authorizationReturnPath,
        })
      : null;
    // The sheet observes the outcome once it mounts; until then nothing is unhandled.
    begun?.catch(() => undefined);
    setConnecting({ account, begun, definitionId });
  };

  /** GitHub finishes connecting once its app can reach the repositories chosen. */
  const setUpRepositories = (connectionId: string) => {
    const signal = takeRepositoryStep();
    setPending(true);
    setError(null);
    void checkRepositorySetup(connectionId, signal)
      .then(async (access) => {
        if (access === null) return;
        if (access.ready) await reload().catch(() => undefined);
        else {
          setRepositorySetup({ access, connectionId });
          setView({ kind: "overview" });
        }
      })
      .catch((reason: unknown) => {
        if (!signal.aborted) setError(message(reason));
      })
      .finally(() => setPending(false));
  };

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
              <Link className="page__back" to="/settings/apps/tools">
                <Icon name="arrow-left" />
                Settings
              </Link>
            }
            description="Connect your accounts, install integrations, and decide exactly which tools and skills each specialist can use."
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
                        : "The account is ready for exact tools and skills you authorize."
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
                              workspaceId: selectedWorkspaceId,
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
                  entries={otherInstallations}
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
            computers={snapshot.machines.filter(({ computerUse }) => computerUse !== null)}
            error={error}
            onAgentPlugin={(directory, runnerId) => void installAgentPlugin(directory, runnerId)}
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

function authorizationResultStatus(
  status: IntegrationAuthorizationStatus["status"],
): IntegrationResult["status"] {
  switch (status) {
    case "completed":
      return "connected";
    case "denied":
    case "cancelled":
    case "expired":
      return status;
    case "pending":
    case "launched":
    case "failed":
      return "failed";
  }
}

function integrationResultTitle(result: IntegrationResult): string {
  const account = result.name ?? "Integration";
  switch (result.status) {
    case "connected":
      return `${account} connected`;
    case "denied":
      return `${account} access not approved`;
    case "cancelled":
      return `${account} connection cancelled`;
    case "expired":
      return `${account} authorization expired`;
    case "failed":
      return `${account} connection failed`;
  }
}

function integrationResultDetail(status: IntegrationResult["status"]): string {
  switch (status) {
    case "connected":
      return "The account is connected.";
    case "denied":
      return "The provider did not grant access. No account was connected.";
    case "cancelled":
      return "Authorization was cancelled. No account was connected.";
    case "expired":
      return "The authorization window expired. Start the connection again.";
    case "failed":
      return "The provider could not complete authorization. Start the connection again.";
  }
}

/** Where a canonical browser sign-in returns to; the Host omits it for another device. */
const authorizationReturnPath = "/settings/apps/tools";
