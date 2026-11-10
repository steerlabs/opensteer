import { hostDeploymentPolicy } from "@opensteer/client/host";
import { pluginPath } from "@opensteer/client/settings";
import { useIntegrationAuthorizationTracking } from "../../integrations/use-integration-authorization-tracking.js";
import { RunnerIdSchema } from "@opensteer/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams, useNavigate } from "react-router";
import type {
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
import {
  authorizationConnection,
  connectAvailability,
  initialConnectSource,
  repositoryAccountStep,
} from "@opensteer/client/integrations";
import { selectedDeploymentFrom } from "../../desktop/desktop-deployment-selection.js";
import { settingsDeploymentName } from "../settings/copy.js";
import { createConnectOperations } from "./connect-operations.js";

import { useToast } from "../toast.js";
import { workspaceAccessSectionId } from "./grants-section.js";
import { message, platformIntegrations, providerLabel } from "./helpers.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";

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
export function useIntegrationEditor({
  embedded = false,
  initialDefinitionId,
  installerOnly = false,
  children,
  onConnected,
  onAuthorizationStarted,
  onComputerSetupRequested,
  headerAction,
  placementAnchor,
}: {
  readonly headerAction?: ReactNode;
  readonly placementAnchor?: string;
  readonly children?: ReactNode;
  readonly onConnected?: (connectionId: string) => Promise<void>;
  readonly onAuthorizationStarted?: (attemptId: string) => void;
  readonly onComputerSetupRequested?: (runnerId: string) => void;
  readonly embedded?: boolean;
  readonly initialDefinitionId?: string;
  readonly installerOnly?: boolean;
}) {
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
          deploymentPolicy: hostDeploymentPolicy(snapshot) ?? null,
          hostsDeploymentOnThisComputer: desktopDeployment?.onThisComputer === true,
          localRunnerId: localExecutionStatus?.runner.runnerId ?? null,
          machines: snapshot.machines,
        });
  const hostName = settingsDeploymentName({
    deployment: selectedDeploymentFrom(deploymentAccess, desktopDeployment),
    identityConfig: snapshot.identityConfig,
  });
  const navigate = useNavigate();
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
  const workspaceKind: "main" | "project" = workspace?.kind === "project" ? "project" : "main";

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
  const [view, setView] = useState<View>(
    initialDefinitionId
      ? { kind: "detail", definitionId: initialDefinitionId }
      : { kind: installerOnly ? "install" : "overview" },
  );
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
    const scroller = rootRef.current?.closest(".settings-content, .page");
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
  const started = useRef(onAuthorizationStarted);
  started.current = onAuthorizationStarted;
  const connectOperations = useMemo(() => {
    const operations = createConnectOperations(client, tracking);
    return {
      ...operations,
      beginAuthorization: async (input: Parameters<typeof operations.beginAuthorization>[0]) => {
        const attempt = await operations.beginAuthorization(input);
        started.current?.(attempt.attemptId);
        return attempt;
      },
    };
  }, [client, tracking]);

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
        if (status.status === "completed" && connection) await onConnected?.(connection.id);
        if (controller.signal.aborted) return;
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

  const { integrations } = useMemo(() => platformIntegrations(platform), [platform]);
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
  /**
   * Deep link from a Project's settings: its access, chosen and brought into
   * view once the page has drawn it. With a provider too, that integration's
   * own page opens instead and leads back here.
   */
  const workspaceParam = searchParams.get("workspace");
  const [revealAccess, setRevealAccess] = useState(false);
  useEffect(() => {
    if (!workspaceParam) return;
    if (snapshot.workspaces.some(({ id }) => id === workspaceParam)) {
      setWorkspaceId(workspaceParam);
      if (!searchParams.has("provider")) setRevealAccess(true);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("workspace");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, snapshot.workspaces, workspaceParam]);
  useEffect(() => {
    if (!revealAccess || !dashboard) return;
    document.getElementById(workspaceAccessSectionId)?.scrollIntoView({ block: "start" });
  }, [dashboard, revealAccess]);
  const focusParam = searchParams.get("provider");
  useEffect(() => {
    if (!focusParam || !platform) return;
    const defined =
      integrations.find(({ definition }) => definition.id === focusParam) ??
      integrations.find(({ definition }) => definition.provider === focusParam);
    if (defined) {
      setError(null);
      setView({ definitionId: defined.definition.id, kind: "detail" });
      const next = new URLSearchParams(searchParams);
      next.delete("provider");
      void navigate(
        `${pluginPath({ kind: "service", definitionId: defined.definition.id })}?${next}`,
        { replace: true },
      );
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete("provider");
    setSearchParams(next, { replace: true });
  }, [focusParam, integrations, platform, searchParams, setSearchParams, navigate]);

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
      const knownConnections = new Set(dashboard?.connections.map((connection) => connection.id));
      const connected = await run(async () => {
        return client.dispatch({
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
      if (connected.type !== "integration.apiKey.connect")
        throw new Error("Integration key command mismatch.");
      if (onConnected) {
        const loaded = await client.rpc["integrations.get"]({}).then(unwrapRpcResult);
        const matches = loaded.connections.filter(
          (connection) =>
            connection.definitionId === input.definitionId &&
            (input.connectionId
              ? connection.id === input.connectionId
              : !knownConnections.has(connection.id)),
        );
        if (matches.length !== 1)
          throw new Error(
            "The connected account could not be identified. Review its placement in Plugins.",
          );
        await onConnected(matches[0]!.id);
      }
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
      onComputerSetupRequested?.(input.runnerId);
      setNotice({
        title: "Setup requested",
        detail: `On ${snapshot.machines.find((machine) => machine.id === input.runnerId)?.name ?? "that computer"}, open Opensteer → Settings → Computers to approve this app.`,
      });
    });

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

  const openDetail = (definitionId: string) => {
    setError(null);
    setView({ kind: "detail", definitionId });
  };
  return {
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
    onConnected,
    headerAction,
    children,
    revealAccess,
    placementAnchor,
    navigate,
    openDetail,
  };
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

export function integrationResultTitle(result: IntegrationResult): string {
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

export function integrationResultDetail(status: IntegrationResult["status"]): string {
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
export const authorizationReturnPath = "/settings/plugins";
