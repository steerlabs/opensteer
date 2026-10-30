import { useIntegrationAuthorizationTracking } from "../integrations/use-integration-authorization-tracking.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  IntegrationAuthorizationAttemptIdSchema,
  type IntegrationAccess,
  type IntegrationAuthorizationStart,
  type IntegrationRepositoryAccess,
} from "@opensteer/integration-core";
// Deep import: the package index pulls in node:crypto, which cannot load in the browser.
import { IntegrationServerIdSchema } from "@opensteer/integration-core/ids";
import { Link, useSearchParams } from "react-router";
import type { Request } from "@opensteer/core";
import { desktopBridge } from "../desktop/desktop-bridge.js";
import {
  integrationAuthorizationError,
  integrationAuthorizationSurface,
  beginIntegrationAuthorization,
  waitForIntegrationAuthorization,
} from "../integrations/integration-authorization.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";
import { ActionNote } from "./action-rows.js";
import { Icon } from "./icon.js";
import { IntegrationInstallReview } from "./integration-install-review.js";
import { useShell } from "./app-shell.js";
import { accountOptionLabel, IntegrationAccountIdentity } from "./integrations/account-identity.js";
import { ApiKeyForm } from "./integrations/api-key-form.js";
import { ConnectFlow, RepositoryAccessSetup } from "./integrations/connect-flow.js";
import { Dialog } from "./dialog.js";
import {
  accessPlan,
  authorizationConnection,
  accessServerChoices,
  accountConnectable,
  changingOperationCount,
  computerAccessUpgrade,
  connectAvailability,
  effectiveIntegrationAccess,
  grantedIntegrationAccess,
  integrationAccessSummary,
  integrationInstallNextStep,
  mainConnectAllowsNote,
  matchingInstallationForManifest,
  operationCount,
  repositoryAccountStep,
  requestedAccountUnavailableDetail,
  resolveIntegrationAccess,
  type AccessPlan,
  type LoadedAccessRequest,
} from "@opensteer/client/integrations";
import { RunnerIdSchema } from "@opensteer/core";
import { androidPhoneDefinitionId } from "@opensteer/protocol";
import { ComputerAppPicker } from "./computer-apps/computer-app-picker.js";
import { createConnectOperations } from "./integrations/connect-operations.js";

export function ThreadIntegrationAction({
  disabled = false,
  request,
  threadId,
}: {
  readonly disabled?: boolean;
  readonly request: Request;
  readonly threadId: string;
}) {
  const { hostClient, snapshot } = useShell();
  const [loaded, setLoaded] = useState<LoadedAccessRequest | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedAccess, setSelectedAccess] = useState<IntegrationAccess | null>(null);
  const [accountName, setAccountName] = useState("");
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [computerSetupNotice, setComputerSetupNotice] = useState<string | null>(null);
  const [repositorySetup, setRepositorySetup] = useState<{
    readonly access: IntegrationRepositoryAccess | null;
    readonly connectionId: string;
  } | null>(null);
  const tracking = useIntegrationAuthorizationTracking();
  const connectOperations = useMemo(
    () => createConnectOperations(hostClient, tracking),
    [hostClient, tracking],
  );
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [requestSettled, setRequestSettled] = useState(false);
  const [authorization, setAuthorization] = useState<IntegrationAuthorizationStart | null>(null);
  const authorizationController = useRef<AbortController | null>(null);
  /**
   * The browser return whose repository step this card has shown. Opening a
   * new sign-in cancels the return, and closing that sheet would run it again
   * and show a step the person may have set aside.
   */
  const shownReturn = useRef<string | null>(null);
  const [searchParams] = useSearchParams();
  const requestPayload = request.payload.kind === "integration.access" ? request.payload : null;
  const targetWorkspace = snapshot.workspaces.find(({ id }) => id === request.targetWorkspaceId);
  const targetWorkspaceKind = targetWorkspace?.kind;

  useEffect(() => {
    if (!requestPayload || targetWorkspace || !snapshot.workspaceWindow.hasMore) return;
    // A newer snapshot can bring the target while this page is out, and its
    // failure is then no longer this card's.
    let cancelled = false;
    void hostClient.loadEarlierWorkspaces().catch((reason: unknown) => {
      if (!cancelled) setError(errorMessage(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [
    hostClient,
    reload,
    requestPayload,
    snapshot.workspaceWindow.hasMore,
    snapshot.workspaceWindow.itemCount,
    targetWorkspace,
  ]);

  useEffect(() => {
    if (connectOpen || authorization) return;
    const returned = searchParams.get("integrationAttempt");
    if (!returned) return;
    // A callback query is an identifier, never a result.
    const parsed = IntegrationAuthorizationAttemptIdSchema.safeParse(returned);
    if (!parsed.success) return;
    if (shownReturn.current === parsed.data) {
      tracking.finished(parsed.data);
      return;
    }
    let cancelled = false;
    let terminal = false;
    const controller = new AbortController();
    // The attempt may still be running when the browser comes back, so this
    // keeps reading the durable record rather than calling it a failure.
    void waitForIntegrationAuthorization({
      attemptId: parsed.data,
      client: hostClient,
      signal: controller.signal,
    })
      .then(async (status) => {
        if (controller.signal.aborted) return;
        terminal = true;
        const outcome = integrationAuthorizationError(status.status, status.failureCode);
        if (outcome) setError(outcome);
        else {
          if (status.connectionId) {
            const dashboard = unwrapRpcResult(await hostClient.rpc["integrations.get"]({}));
            if (controller.signal.aborted) return;
            const connection = authorizationConnection(dashboard, status.connectionId);
            if (connection?.provider === "github") {
              shownReturn.current = parsed.data;
              takeRepositoryStep(controller);
              setRepositorySetup({ access: null, connectionId: connection.id });
              const access = await checkRepositorySetup(connection.id, controller.signal);
              if (access === null) return;
              if (!access.ready) {
                updateRepositorySetup(connection.id, access);
                return;
              }
              closeRepositorySetup(connection.id);
            }
            setSelectedAccountId(status.connectionId);
          }
          setReload((value) => value + 1);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (cancelled || !terminal) return;
        tracking.finished(parsed.data);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hostClient, connectOpen, authorization, searchParams, tracking]);

  /**
   * The one repository check that may change the repository step and what the
   * card says about it: the browser return's once it opens its step, or a
   * recheck. Each takes the step from the one before, which then changes
   * nothing.
   */
  const repositoryCheck = useRef<AbortController | null>(null);
  const takeRepositoryStep = (controller = new AbortController()): AbortSignal => {
    repositoryCheck.current?.abort();
    repositoryCheck.current = controller;
    return controller.signal;
  };

  /**
   * GitHub's repository check from this card. After a refusal the card reloads
   * and follows the Host (`repositoryAccountStep`): a sign-in GitHub rejected
   * closes the repository step, and the card offers connecting again. Answers
   * no access to show after a refusal, or once the check no longer owns the
   * step. A sign-in opened since also cancels the return's check, whose error
   * would replace that sheet and abandon its attempt.
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
      setError(errorMessage(reason));
      // An account that cannot be reloaded keeps its repository step.
      const dashboard = await connectOperations.reloadDashboard().catch(() => null);
      if (signal.aborted) return null;
      const next = dashboard === null ? null : repositoryAccountStep(dashboard, connectionId);
      if (next === null || next.kind === "repository-access") return null;
      closeRepositorySetup(connectionId);
      if (next.kind === "sign-in") setError(next.detail ?? errorMessage(reason));
      else {
        setError(null);
        setSelectedAccountId(connectionId);
        setReload((value) => value + 1);
      }
      return null;
    }
  }

  /**
   * A check answers only the repository step it was started from. "Finish
   * later" closes that step while the check is out, and it stays closed.
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
      setSelectedAccountId(connectionId);
      closeRepositorySetup(connectionId);
      setReload((value) => value + 1);
    } finally {
      setPending(false);
    }
  };

  useEffect(
    () => () => {
      authorizationController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    setRequestSettled(false);
  }, [request.id]);

  useEffect(() => {
    let cancelled = false;
    if (!requestPayload || !targetWorkspaceKind) return;
    setLoaded(null);
    Promise.all([
      hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
      hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    ])
      .then(([dashboard, platform]) => {
        if (!cancelled) setLoaded({ dashboard, platform, request: requestPayload });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [hostClient, reload, request.targetWorkspaceId, requestPayload, targetWorkspaceKind]);

  const plan = useMemo(
    () => (loaded ? accessPlan(loaded, selectedAccountId) : null),
    [loaded, selectedAccountId],
  );
  const serverChoices = loaded ? accessServerChoices(loaded) : [];

  // A failure is said on this card, where the action was taken, and nowhere
  // else: the app-wide banner would repeat it and outlive the Request.
  const run = async (operation: () => Promise<void>) => {
    if (pending || disabled) return;
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  const decline = () =>
    void run(() =>
      hostClient
        .dispatch({
          idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
          requestId: request.id,
          response: { kind: "external", value: { decision: "declined" } },
          type: "request.respond",
        })
        .then(() => undefined),
    );

  if (requestSettled) return null;
  if (!requestPayload) {
    return <ActionNote alert>This integration access Request is invalid.</ActionNote>;
  }

  if (error) {
    return (
      <>
        <ActionNote alert>{error}</ActionNote>
        <div className="action-buttons">
          <button className="btn" disabled={pending} onClick={decline} type="button">
            Not now
          </button>
          <button
            className="btn btn--primary"
            disabled={pending}
            onClick={() => {
              setLoaded(null);
              setError(null);
              setReload((value) => value + 1);
            }}
            type="button"
          >
            Try again
          </button>
        </div>
      </>
    );
  }
  if (!targetWorkspace) {
    if (snapshot.workspaceWindow.hasMore) {
      return <ActionNote>Checking target Workspace…</ActionNote>;
    }
    return (
      <>
        <ActionNote alert>The target Workspace is no longer available.</ActionNote>
        <div className="action-buttons">
          <button className="btn" disabled={pending} onClick={decline} type="button">
            Decline request
          </button>
        </div>
      </>
    );
  }
  if (!loaded) return <ActionNote>Checking account access…</ActionNote>;
  if (requestPayload.installationId === null) {
    const alreadyInstalled = matchingInstallationForManifest(
      loaded.platform,
      requestPayload.manifest,
    );
    const install = () =>
      void run(() =>
        hostClient
          .dispatch({
            idempotencyKey: mutationIdempotencyKey(`request:${request.id}:install`),
            requestId: request.id,
            response: { kind: "choice", optionId: "installed" },
            type: "request.respond",
          })
          .then(() => undefined),
      );
    return (
      <>
        <IntegrationInstallReview manifest={requestPayload.manifest} />
        <ActionNote>
          {integrationInstallNextStep({
            canInstall: loaded.dashboard.isAdministrator,
            continuesToAccess: true,
            installedTitle: alreadyInstalled?.installation.title ?? null,
          })}
        </ActionNote>
        <div className="action-buttons">
          <button className="btn" disabled={pending} onClick={decline} type="button">
            Not now
          </button>
          {loaded.dashboard.isAdministrator || alreadyInstalled !== null ? (
            <button className="btn btn--primary" disabled={pending} onClick={install} type="button">
              {alreadyInstalled ? "Continue" : "Install and continue"}
            </button>
          ) : null}
        </div>
      </>
    );
  }
  if (serverChoices.length > 0) {
    const chooseServer = (serverId: string) =>
      void run(() =>
        hostClient
          .dispatch({
            idempotencyKey: mutationIdempotencyKey(`request:${request.id}:server:${serverId}`),
            requestId: request.id,
            response: { kind: "choice", optionId: `server:${serverId}` },
            type: "request.respond",
          })
          .then(() => undefined),
      );
    return (
      <>
        <ActionNote>{`Choose the ${serverChoices[0]!.installationTitle} server this request should use.`}</ActionNote>
        <div className="action-buttons">
          <button className="btn" disabled={pending} onClick={decline} type="button">
            Not now
          </button>
          {serverChoices.map((server) => (
            <button
              className="btn btn--primary"
              disabled={pending}
              key={server.id}
              onClick={() => chooseServer(server.id)}
              type="button"
            >
              Continue with {server.name}
            </button>
          ))}
        </div>
      </>
    );
  }
  if (!plan) {
    return (
      <>
        <ActionNote alert>The requested integration is no longer installed.</ActionNote>
        <div className="action-buttons">
          <button className="btn" disabled={pending} onClick={decline} type="button">
            Decline request
          </button>
        </div>
      </>
    );
  }

  // Only an OAuth posture depends on a provider application; an API-key
  // integration is connectable with no deployment configuration at all.
  const provider =
    plan.definition !== null &&
    plan.requirement.kind === "provider" &&
    plan.requirement.providerApplicationRequired
      ? plan.requirement.provider
      : null;
  const availability = provider ? connectAvailability(loaded.dashboard, provider) : null;
  // An MCP server's sign-in returns to the Host's own callback, which only a
  // browser on that computer reaches; the Host refuses to begin one from here.
  const mcpElsewhere =
    plan.requirement.kind === "mcp-oauth" &&
    loaded.platform.authorizationSurface === "personal-remote";
  // Registering a sign-in app is part of connecting, so only a device that can
  // finish no sign-in takes the connect action away.
  const connectPossible =
    !mcpElsewhere && (availability === null || availability.kind !== "other-surface");
  const canConnectAccount = connectPossible && accountConnectable(plan);
  const hasAccount = plan.accounts.length > 0;
  const apiKeyMethod = plan.apiKeyMethod;
  // A Request that names an account is answered by that account or not at
  // all, so the only connection worth making for it is the one that repairs it.
  const pinned = plan.requestedConnectionId !== null;
  const reconnect = plan.requestedAccountMissing ? plan.requestedAccountReconnect : null;
  const unavailable = plan.requestedAccountMissing && reconnect === null;
  // A key repair is the key itself, so its form is the reconnect, shown at once.
  const showApiKeyForm =
    canConnectAccount &&
    apiKeyMethod !== null &&
    (pinned ? reconnect?.method === "api-key" : apiKeyOpen || !hasAccount);
  // A key reconnects the exact account a Request names: nothing else can say
  // which account an unidentified key belongs to.
  const reconnectedConnectionId = reconnect?.method === "api-key" ? reconnect.account.id : null;
  const settingsPath = plan.definition
    ? `/settings/apps/tools?provider=${encodeURIComponent(plan.definition.id)}`
    : "/settings/apps/tools";
  const computerRequirement = plan.requirement.kind === "computer";
  // A computer is chosen here, inline: there is no sign-in to hand off to.
  const showComputerPicker = computerRequirement && !pinned && (connectOpen || !hasAccount);
  const connectOffered =
    (!pinned || reconnect?.method === "sign-in") && canConnectAccount && !showComputerPicker;
  const effectiveAccess: IntegrationAccess = effectiveIntegrationAccess(
    plan.requestedAccess,
    selectedAccess === "read-write",
  );
  const grantedAccess = grantedIntegrationAccess({
    allowChanges: selectedAccess === "read-write",
    plan,
    workspaceKind: targetWorkspace.kind,
  });
  // A Workspace cannot receive access above the selected computer's ceiling.
  // This uses the access the person is about to grant, including an optional
  // expansion of a read Request, rather than only the Request's original floor.
  const sendUpgrade = computerAccessUpgrade(plan, effectiveAccess);
  const computerAppPresentation = plan.definition?.computerApp;
  const optionalWriteAccess =
    plan.writeCount > 0 || computerAppPresentation?.accessLevels.length === 2;

  const setComputerApp = (input: {
    readonly access: IntegrationAccess;
    readonly runnerId: string;
  }) =>
    void run(async () => {
      if (!plan.definition) throw new Error("Computer app definition is unavailable.");
      const computerName =
        snapshot.machines.find((machine) => machine.id === input.runnerId)?.name ?? "that computer";
      const command = {
        idempotencyKey: mutationIdempotencyKey(`integration-computer:${plan.definition.id}`),
        input: {
          access: input.access,
          app: null,
          definitionId: plan.definition.id,
          kind: "app" as const,
          runnerId: RunnerIdSchema.parse(input.runnerId),
        },
      };
      // The owner sets a phone's access here; a Mac app is approved on that Mac.
      if (plan.definition.id === androidPhoneDefinitionId) {
        const result = await hostClient.dispatch({
          ...command,
          type: "integration.computer.setup.set",
        });
        if (result.type !== "integration.computer.setup.set") {
          throw new Error("Phone access did not change.");
        }
        setComputerSetupNotice(`Agents can now use ${computerName} at the access you chose.`);
        setReload((value) => value + 1);
      } else {
        const result = await hostClient.dispatch({
          ...command,
          type: "integration.computer.setup.request",
        });
        if (result.type !== "integration.computer.setup.request") {
          throw new Error("Integration computer command mismatch.");
        }
        setComputerSetupNotice(
          `Setup requested. On ${computerName}, open Opensteer → Settings → Computers to approve ${plan.definition.name}.`,
        );
      }
      setConnectOpen(false);
    });

  const connectApiKey = (input: {
    readonly displayName?: string | undefined;
    readonly values: Readonly<Record<string, string>>;
  }) => {
    if (!apiKeyMethod || !plan.definition || pending) return;
    setPending(true);
    setApiKeyError(null);
    void hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey(`integration-key:${plan.definition.id}`),
        input: {
          authMethodId: apiKeyMethod.id,
          ...(reconnectedConnectionId === null ? {} : { connectionId: reconnectedConnectionId }),
          definitionId: plan.definition.id,
          displayName: input.displayName,
          values: { ...input.values },
        },
        type: "integration.apiKey.connect",
      })
      .then(() => {
        setApiKeyOpen(false);
        setReload((value) => value + 1);
      })
      .catch((reason: unknown) => setApiKeyError(errorMessage(reason)))
      .finally(() => setPending(false));
  };

  const handOffAuthorization = async (started: IntegrationAuthorizationStart) => {
    const controller = new AbortController();
    authorizationController.current?.abort();
    authorizationController.current = controller;
    setAuthorization(started);
    try {
      const status = await waitForIntegrationAuthorization({
        attemptId: started.attemptId,
        client: hostClient,
        expiresAt: started.expiresAt,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      tracking.finished(started.attemptId);
      const outcome = integrationAuthorizationError(status.status, status.failureCode);
      if (outcome) throw new Error(outcome);
      if (status.connectionId) setSelectedAccountId(status.connectionId);
      setReload((value) => value + 1);
    } catch (reason) {
      if (!controller.signal.aborted) throw reason;
    } finally {
      if (authorizationController.current === controller) {
        authorizationController.current = null;
        setAuthorization(null);
      }
    }
  };

  /**
   * Cancel belongs to the sign-in that shows it. A sign-in that finished
   * while the answer was out, or one started since, is not its to end.
   */
  const cancelAuthorization = async () => {
    if (!authorization) return;
    const controller = authorizationController.current;
    try {
      const status = await hostClient.dispatch({
        attemptId: authorization.attemptId,
        idempotencyKey: mutationIdempotencyKey(`integration-auth:${authorization.attemptId}`),
        type: "integration.authorization.cancel",
      });
      if (status.type !== "integration.authorization.cancel") {
        throw new Error("Integration authorization cancellation command mismatch.");
      }
      tracking.finished(authorization.attemptId);
      if (authorizationController.current !== controller) return;
      controller?.abort();
      setAuthorization(null);
      const outcome = integrationAuthorizationError(status.status, status.failureCode);
      if (outcome !== null) {
        setError(outcome);
        return;
      }
      if (status.connectionId) setSelectedAccountId(status.connectionId);
      setError(null);
      setReload((value) => value + 1);
    } catch (reason) {
      if (authorizationController.current === controller) setError(errorMessage(reason));
    }
  };

  const connect = () => {
    const bridge = desktopBridge();
    // A provider connection is the shared Connect sheet: it owns the choice of
    // sign-in app, its own-app setup, and the durable attempt.
    if (provider) {
      setConnectOpen(true);
      return;
    }
    if (plan.requirement.kind === "mcp-oauth" && requestPayload.requestedServerId) {
      void run(async () => {
        const started = await beginIntegrationAuthorization({
          bridge,
          onStarted: tracking.started,
          returnPath: `/threads/${encodeURIComponent(threadId)}`,
          begin: async (returnPath) => {
            const result = await hostClient.dispatch({
              idempotencyKey: mutationIdempotencyKey(
                `integration-mcp:${requestPayload.requestedServerId}`,
              ),
              input: {
                requestId: request.id,
                displayName: accountName.trim() || `${plan.installationTitle} account`,
                returnPath,
                serverId: IntegrationServerIdSchema.parse(requestPayload.requestedServerId),
                surface: integrationAuthorizationSurface(bridge),
              },
              type: "integration.mcp.authorization.begin",
            });
            if (result.type !== "integration.mcp.authorization.begin") {
              throw new Error("MCP authorization command mismatch.");
            }
            return result;
          },
        });
        await handOffAuthorization(started);
      });
    }
  };

  const allow = () =>
    void run(() =>
      resolveIntegrationAccess(hostClient, {
        access: effectiveAccess,
        accountsCount: plan.accounts.length,
        installationTitle: plan.installationTitle,
        requestId: request.id,
        selectedAccount: plan.selectedAccount,
        targetKind: targetWorkspace.kind,
      }),
    );

  const declineButton = (
    <button className="btn" disabled={pending} onClick={decline} type="button">
      {unavailable ? "Decline request" : "Not now"}
    </button>
  );

  return (
    <>
      {computerSetupNotice ? <ActionNote>{computerSetupNotice}</ActionNote> : null}
      <ActionNote>
        {plan.readCount + plan.writeCount === 0
          ? `Allow ${plan.installationTitle} in ${targetWorkspace.name}`
          : integrationAccessSummary(plan, grantedAccess)}
      </ActionNote>
      {targetWorkspace.kind === "specialized" ? (
        <ActionNote>{`Access will be granted to ${targetWorkspace.name}.`}</ActionNote>
      ) : !computerRequirement && (showApiKeyForm || connectOffered) ? (
        <ActionNote>{mainConnectAllowsNote(targetWorkspace.name)}</ActionNote>
      ) : null}
      {plan.selectedAccount ? (
        <div className="action-field">
          <span>Account</span>
          {plan.accounts.length > 1 && integrationAccountCanChange(plan) ? (
            <select
              aria-label="Account"
              className="select-input"
              onChange={(event) => setSelectedAccountId(event.target.value)}
              value={plan.selectedAccount.id}
            >
              {plan.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {accountOptionLabel(account, plan.accounts)}
                </option>
              ))}
            </select>
          ) : null}
          <div className="intg-account-selection">
            <span className="intg-account-selection__icon">
              <Icon name="user" />
            </span>
            <IntegrationAccountIdentity account={plan.selectedAccount} accounts={plan.accounts} />
            <span className="chip chip--ok">Connected</span>
          </div>
        </div>
      ) : null}
      {reconnect ? (
        <div className="action-field">
          <span className="action-field__title">{`Reconnect ${plan.integrationName}`}</span>
          <div className="intg-account-selection">
            <span className="intg-account-selection__icon">
              <Icon name="user" />
            </span>
            <IntegrationAccountIdentity
              account={reconnect.account}
              accounts={[reconnect.account, ...plan.accounts]}
            />
            <span className="chip chip--warn">Needs attention</span>
          </div>
          {reconnect.statusDetail ? <ActionNote>{reconnect.statusDetail}</ActionNote> : null}
        </div>
      ) : unavailable ? (
        <ActionNote alert>{requestedAccountUnavailableDetail}</ActionNote>
      ) : null}
      {plan.requirement.kind === "mcp-oauth" && plan.accounts.length === 0 ? (
        <label className="action-field">
          <span>Account name</span>
          <input
            className="text-input"
            maxLength={160}
            onChange={(event) => setAccountName(event.target.value)}
            placeholder={`${plan.installationTitle} account`}
            value={accountName}
          />
        </label>
      ) : null}
      {targetWorkspace.kind === "specialized" &&
      optionalWriteAccess &&
      plan.requestedAccess === "read" ? (
        <label className="check-item">
          <input
            checked={effectiveAccess === "read-write"}
            onChange={(event) => setSelectedAccess(event.target.checked ? "read-write" : "read")}
            type="checkbox"
          />
          <span className="check-item__meta">
            <span className="check-item__label">
              {computerAppPresentation?.accessLabels.readWrite ?? "Allow changes"}
            </span>
            <span className="check-item__detail">
              {computerAppPresentation?.accessSummaries.readWrite ??
                `Read-write access, ${changingOperationCount(plan.writeCount)}`}
            </span>
          </span>
        </label>
      ) : null}
      {targetWorkspace.kind === "specialized" && plan.requestedAccess === "read-write" ? (
        <ActionNote>
          {plan.writeCount > 0
            ? `This task requires read-write access, including ${changingOperationCount(plan.writeCount)}.`
            : "This task requires read-write access. It allows changes when operations become available."}
        </ActionNote>
      ) : null}
      {mcpElsewhere ? (
        <ActionNote>
          This sign-in returns to the computer running Opensteer, so finish it there.
        </ActionNote>
      ) : null}
      {availability && availability.kind !== "ready" ? (
        <ActionNote>{availability.detail}</ActionNote>
      ) : null}
      {authorization ? (
        <ActionNote>
          Finish connecting in your browser. Opensteer will update automatically.
        </ActionNote>
      ) : null}
      {showApiKeyForm && apiKeyMethod && plan.definition ? (
        <ApiKeyForm
          definition={plan.definition}
          proposed={plan.proposed}
          {...(reconnect?.method === "api-key"
            ? { displayName: reconnect.account.displayName }
            : {})}
          error={apiKeyError}
          method={apiKeyMethod}
          onSubmit={connectApiKey}
          pending={pending}
          secondaryAction={
            // A form the person opened beside an account they could use closes
            // back to it; otherwise the form is the answer, and declining the other.
            apiKeyOpen ? (
              <button
                className="btn"
                disabled={pending}
                onClick={() => setApiKeyOpen(false)}
                type="button"
              >
                Cancel
              </button>
            ) : (
              declineButton
            )
          }
        />
      ) : null}
      {showComputerPicker && plan.definition ? (
        <ComputerAppPicker
          busy={pending}
          connections={loaded.dashboard.connections}
          definition={plan.definition}
          machines={snapshot.machines}
          onTurnOn={setComputerApp}
        />
      ) : null}
      {sendUpgrade ? (
        <ActionNote>
          {`${plan.definition?.computerApp?.accessLabels.readWrite ?? "Changes"} must be enabled on ${sendUpgrade.displayName} before this access can be allowed. ${
            plan.definition?.computerApp?.accessSummaries.readWrite ?? ""
          }`}
        </ActionNote>
      ) : null}
      {/* While the key form is shown, its own row holds the answers. */}
      {showApiKeyForm ? null : (
        <div className="action-buttons">
          {authorization ? (
            <button className="btn" onClick={() => void cancelAuthorization()} type="button">
              Cancel
            </button>
          ) : (
            declineButton
          )}
          {availability?.kind === "other-surface" ? (
            <Link className="btn" to={settingsPath}>
              Open integration settings
            </Link>
          ) : null}
          {sendUpgrade ? (
            <button
              className="btn btn--primary"
              disabled={pending}
              onClick={() =>
                setComputerApp({ access: "read-write", runnerId: sendUpgrade.runnerId })
              }
              type="button"
            >
              {plan.definition?.id === androidPhoneDefinitionId
                ? `Allow ${plan.definition.computerApp?.accessLabels.readWrite ?? "control"} on ${sendUpgrade.displayName}`
                : `Request sending access on ${sendUpgrade.displayName}`}
            </button>
          ) : null}
          <IntegrationAccountActions
            authorizationActive={authorization !== null}
            canAllow={
              !plan.requestedAccountMissing &&
              // Approving would grant an access the connection cannot carry, so
              // the ceiling is raised first, deliberately, or not at all.
              sendUpgrade === null &&
              (plan.requirement.kind === "none" || plan.selectedAccount !== null)
            }
            canConnect={connectOffered}
            computerApp={computerRequirement}
            hasAccount={hasAccount}
            onAllow={allow}
            onConnect={
              computerRequirement
                ? () => setConnectOpen(true)
                : apiKeyMethod
                  ? () => setApiKeyOpen(true)
                  : connect
            }
            pending={pending}
            reconnectRequired={reconnect !== null}
            primaryLabel={
              targetWorkspace.kind === "main"
                ? "Use this account"
                : `Allow in ${targetWorkspace.name}`
            }
          />
        </div>
      )}
      {connectOpen && provider && plan.definition ? (
        <ConnectFlow
          dashboard={loaded.dashboard}
          definition={plan.definition}
          onClose={() => setConnectOpen(false)}
          onConnected={(connectionId) => {
            setSelectedAccountId(connectionId);
            setReload((value) => value + 1);
          }}
          operations={connectOperations}
          purpose={connectPurpose(plan, grantedAccess)}
          requestedBy={plan.installationTitle}
          returnPath={`/threads/${encodeURIComponent(threadId)}`}
        />
      ) : null}
      {repositorySetup ? (
        <Dialog
          footer={
            <>
              <button className="btn" onClick={() => setRepositorySetup(null)} type="button">
                Finish later
              </button>
              <button
                className="btn btn--primary"
                disabled={pending}
                onClick={() => void recheckRepositorySetup()}
                type="button"
              >
                {pending ? "Checking…" : "Recheck repository access"}
              </button>
            </>
          }
          labelledBy="github-repository-access"
          onClose={() => setRepositorySetup(null)}
          title="Choose GitHub repositories"
        >
          <RepositoryAccessSetup access={repositorySetup.access} />
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * The sentence a person approves, built from the operations this Request can
 * actually reach — not from the access it asked for.
 */
export function connectPurpose(
  plan: Pick<AccessPlan, "integrationName" | "readCount" | "writeCount">,
  access: IntegrationAccess,
): string {
  const total = plan.readCount + (access === "read-write" ? plan.writeCount : 0);
  if (total === 0) {
    return `Connect a ${plan.integrationName} account for this integration.`;
  }
  return access === "read-write"
    ? `Connect a ${plan.integrationName} account so this integration can read and make changes through ${operationCount(total)} you approve.`
    : `Connect a ${plan.integrationName} account so this integration can read through ${operationCount(total)} you approve.`;
}

export function IntegrationAccountActions({
  authorizationActive,
  canAllow,
  canConnect,
  computerApp = false,
  hasAccount,
  onAllow,
  onConnect,
  pending,
  primaryLabel,
  reconnectRequired = false,
}: {
  readonly authorizationActive: boolean;
  readonly canAllow: boolean;
  readonly canConnect: boolean;
  /** An app on a computer is turned on for a computer, never signed in to. */
  readonly computerApp?: boolean;
  readonly hasAccount: boolean;
  readonly onAllow: () => void;
  readonly onConnect: () => void;
  readonly pending: boolean;
  readonly primaryLabel: string;
  readonly reconnectRequired?: boolean;
}) {
  if (authorizationActive) return null;
  return (
    <>
      {canConnect ? (
        <button
          className={hasAccount && !reconnectRequired ? "btn" : "btn btn--primary"}
          disabled={pending}
          onClick={onConnect}
          type="button"
        >
          {reconnectRequired
            ? "Reconnect account"
            : computerApp
              ? hasAccount
                ? "Use another computer"
                : "Choose a computer"
              : hasAccount
                ? "Connect another account"
                : "Connect account"}
        </button>
      ) : null}
      {canAllow ? (
        <button className="btn btn--primary" disabled={pending} onClick={onAllow} type="button">
          {primaryLabel}
        </button>
      ) : null}
    </>
  );
}

/** A Request that names an exact account cannot be redirected by its surface. */
export function integrationAccountCanChange(
  plan: Pick<AccessPlan, "requestedConnectionId">,
): boolean {
  return plan.requestedConnectionId === null;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The integration request could not be loaded.";
}
