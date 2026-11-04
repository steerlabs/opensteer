import { useIntegrationAuthorizationTracking } from "../integrations/use-integration-authorization-tracking.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  IntegrationAuthorizationAttemptIdSchema,
  type IntegrationAccess,
  type IntegrationAuthorizationStart,
  type IntegrationAuthorizationStatus,
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
  integrationAuthorizationFinish,
  finishDesktopIntegrationAuthorization,
  beginIntegrationAuthorization,
  waitForIntegrationAuthorization,
} from "../integrations/integration-authorization.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";
import { ActionNote } from "./action-rows.js";
import { Icon } from "./icon.js";
import { IntegrationInstallReview } from "./integration-install-review.js";
import { useShell } from "./app-shell.js";
import { ApiKeyForm } from "./integrations/api-key-form.js";
import { RepositoryAccessSetup } from "./integrations/connect-flow.js";
import { IntegrationIcon } from "./integrations/integration-icon.js";
import { AgentProposedChip } from "./integrations/agent-proposed-chip.js";
import { SegmentedControl } from "./segmented-control.js";
import {
  connectCard,
  integrationRequestStillPending,
  integrationInstallNextStep,
  integrationAccountDetail,
  installationDefinition,
  type AccessRequestAccount,
  accessPlan,
  authorizationConnection,
  accessServerChoices,
  accountConnectable,
  collapsedAccountRows,
  computerAccessUpgrade,
  connectAvailability,
  effectiveIntegrationAccess,
  repositoryAccountStep,
  resolveIntegrationAccess,
  type AccessPlan,
  type ConnectCard,
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
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
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
  const [connected, setConnected] = useState<AccessRequestAccount | null>(null);
  /**
   * The last thing the person asked the card to do. Try again repeats exactly
   * that: a failed sign-in for another account must never become approval of
   * the account already selected.
   */
  const lastAction = useRef<"allow" | "connect" | null>(null);
  const answerAfterConnect = useRef<{
    requestId: string;
    connectionId: string;
    access: IntegrationAccess;
  } | null>(null);
  const [authorization, setAuthorization] = useState<IntegrationAuthorizationStart | null>(null);
  const authorizationController = useRef<AbortController | null>(null);
  const operationGeneration = useRef(0);
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
        await finishDesktopIntegrationAuthorization(desktopBridge(), hostClient, parsed.data);
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
    operationGeneration.current += 1;
    authorizationController.current?.abort();
    setAuthorization(null);
    setRequestSettled(false);
    setLoaded(null);
    setConnected(null);
    setSelectedAccountId(null);
    setSelectedAccess(null);
    setError(null);
    setApiKeyError(null);
    setApiKeyOpen(false);
    setConnectOpen(false);
    setAccountsExpanded(false);
    setDetailsOpen(false);
    setComputerSetupNotice(null);
    setRepositorySetup(null);
    setPending(false);
    answerAfterConnect.current = null;
  }, [request.id, hostClient]);

  useEffect(() => {
    let cancelled = false;
    if (!requestPayload || !targetWorkspaceKind) return;
    Promise.all([
      hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
      hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    ])
      .then(([dashboard, platform]) => {
        if (!cancelled)
          setLoaded((current) => ({
            dashboard,
            platform,
            request:
              current &&
              ((requestPayload.installationId === null &&
                current.request.installationId !== null) ||
                (requestPayload.requestedServerId === null &&
                  current.request.requestedServerId !== null))
                ? current.request
                : requestPayload,
          }));
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
    const generation = ++operationGeneration.current;
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      if (operationGeneration.current === generation) {
        answerAfterConnect.current = null;
        setError(errorMessage(reason));
      }
    } finally {
      if (operationGeneration.current === generation) setPending(false);
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

  useEffect(() => {
    if (
      !loaded ||
      !targetWorkspace ||
      !plan ||
      repositorySetup ||
      authorization ||
      pending ||
      !answerAfterConnect.current
    )
      return;
    const completion = answerAfterConnect.current;
    const reviewedAccess = effectiveIntegrationAccess(
      plan.requestedAccess,
      selectedAccess === "read-write",
    );
    if (completion.requestId !== request.id || completion.access !== reviewedAccess) {
      answerAfterConnect.current = null;
      return;
    }
    const selected = plan.selectedAccount;
    if (
      !selected ||
      selected.id !== selectedAccountId ||
      selected.id !== completion.connectionId ||
      computerAccessUpgrade(
        plan,
        effectiveIntegrationAccess(plan.requestedAccess, selectedAccess === "read-write"),
      )
    )
      return;
    answerAfterConnect.current = null;
    void run(async () => {
      if (
        targetWorkspace.kind === "project" ||
        (await integrationRequestStillPending(hostClient, request.originatingThreadId, request.id))
      ) {
        await resolveIntegrationAccess(hostClient, {
          access: effectiveIntegrationAccess(plan.requestedAccess, selectedAccess === "read-write"),
          accountsCount: plan.accounts.length,
          installationTitle: plan.installationTitle,
          requestId: request.id,
          selectedAccount: selected,
          targetKind: targetWorkspace.kind,
        });
      }
      if (await integrationRequestStillPending(hostClient, request.originatingThreadId, request.id))
        throw new Error("The account is connected, but this request is still waiting. Try again.");
      setConnected(selected);
    });
  }, [
    loaded,
    plan,
    targetWorkspace,
    repositorySetup,
    authorization,
    pending,
    selectedAccess,
    request.id,
    selectedAccountId,
  ]);
  const handOffAuthorization = async (
    started: IntegrationAuthorizationStart,
    context: LoadedAccessRequest | null = loaded,
    returned?: IntegrationAuthorizationStatus,
  ) => {
    const controller = new AbortController();
    authorizationController.current?.abort();
    authorizationController.current = controller;
    answerAfterConnect.current = null;
    setAuthorization(started);
    try {
      const status =
        returned ??
        (await waitForIntegrationAuthorization({
          attemptId: started.attemptId,
          client: hostClient,
          expiresAt: started.expiresAt,
          signal: controller.signal,
        }));
      if (controller.signal.aborted) return;
      await finishDesktopIntegrationAuthorization(desktopBridge(), hostClient, started.attemptId);
      tracking.finished(started.attemptId);
      const outcome = integrationAuthorizationError(status.status, status.failureCode);
      if (outcome) throw new Error(outcome);
      if (!status.connectionId)
        throw new Error(
          "Authorization finished without recording an account. Start the connection again.",
        );
      const dashboard = unwrapRpcResult(await hostClient.rpc["integrations.get"]({}));
      if (controller.signal.aborted) return;
      const connection = authorizationConnection(dashboard, status.connectionId);
      answerAfterConnect.current = {
        requestId: request.id,
        connectionId: status.connectionId,
        access: effectiveIntegrationAccess(
          context?.request.access ?? requestPayload!.access,
          selectedAccess === "read-write",
        ),
      };
      if (connection?.provider === "github") {
        takeRepositoryStep(controller);
        setRepositorySetup({ access: null, connectionId: connection.id });
        const access = await checkRepositorySetup(connection.id, controller.signal);
        if (!access) return;
        if (!access.ready) {
          updateRepositorySetup(connection.id, access);
          return;
        }
        closeRepositorySetup(connection.id);
      }
      const platform = unwrapRpcResult(await hostClient.rpc["integration.platform.get"]({}));
      if (controller.signal.aborted) return;
      const next = context ? { ...context, dashboard, platform } : null;
      const nextPlan = next ? accessPlan(next, status.connectionId) : null;
      if (!nextPlan?.selectedAccount || nextPlan.selectedAccount.id !== status.connectionId)
        throw new Error(
          "Authorization finished without recording the requested account. Start the connection again.",
        );
      setLoaded(next);
      setSelectedAccountId(status.connectionId);
      setReload((value) => value + 1);
    } catch (reason) {
      if (authorizationController.current === controller) answerAfterConnect.current = null;
      if (!controller.signal.aborted) throw reason;
    } finally {
      if (authorizationController.current === controller) {
        authorizationController.current = null;
        setAuthorization(null);
      }
    }
  };

  if (!requestPayload)
    return <ActionNote alert>This integration access Request is invalid.</ActionNote>;
  if (!targetWorkspace || !loaded)
    return (
      <>
        <ActionNote alert={Boolean(error)}>
          {error ??
            (!targetWorkspace
              ? snapshot.workspaceWindow.hasMore
                ? "Checking target Workspace…"
                : "The target Workspace is no longer available."
              : "Checking account access…")}
        </ActionNote>
        {error || (!targetWorkspace && !snapshot.workspaceWindow.hasMore) ? (
          <button className="btn" disabled={disabled || pending} onClick={decline} type="button">
            Not now
          </button>
        ) : null}
        {error ? (
          <button
            className="btn btn--primary"
            onClick={() => {
              setError(null);
              setReload((value) => value + 1);
            }}
          >
            Try again
          </button>
        ) : null}
      </>
    );
  const card = connectCard({
    loaded,
    workspace: targetWorkspace,
    selectedAccountId,
    allowChanges: selectedAccess === "read-write",
    agentProposed: request.presentation.agentProposed === true,
    connecting: authorization !== null,
    error,
    connectedAccount: connected,
    answered: requestSettled,
    repositories: repositorySetup !== null,
  });
  const install = () =>
    void run(async () => {
      const definition = requestPayload.manifest
        ? installationDefinition(requestPayload.manifest)
        : null;
      const oauth =
        card.autoInstall && definition?.authMethods.some((method) => method.kind === "oauth");
      let prepared: LoadedAccessRequest | null = null;
      const prepare = async () => {
        await hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey(`request:${request.id}:install`),
          requestId: request.id,
          response: { kind: "choice", optionId: "installed" },
          type: "request.respond",
        });
        let before: string | undefined;
        let updated: Request | undefined;
        do {
          const page = unwrapRpcResult(
            await hostClient.rpc["thread.requests.list"]({
              threadId: request.originatingThreadId,
              limit: 100,
              ...(before ? { before } : {}),
            }),
          );
          updated = page.requests.find((candidate) => candidate.id === request.id);
          if (updated || !page.window.hasMore) break;
          if (!page.window.nextBefore)
            throw new Error("Thread Request page is missing its continuation cursor.");
          before = page.window.nextBefore;
        } while (before);
        if (updated?.payload.kind !== "integration.access")
          throw new Error("This connection request is no longer available.");
        const [dashboard, platform] = await Promise.all([
          hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
          hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
        ]);
        const next = { dashboard, platform, request: updated.payload };
        prepared = next;
        setLoaded(next);
        return next;
      };
      if (!oauth) {
        const next = await prepare();
        const nextPlan = accessPlan(next, null);
        if (card.autoInstall && nextPlan?.requirement.kind === "none") {
          await resolveIntegrationAccess(hostClient, {
            access: effectiveIntegrationAccess(
              nextPlan.requestedAccess,
              selectedAccess === "read-write",
            ),
            accountsCount: 0,
            installationTitle: nextPlan.installationTitle,
            requestId: request.id,
            selectedAccount: null,
            targetKind: targetWorkspace.kind,
          });
          if (
            await integrationRequestStillPending(
              hostClient,
              request.originatingThreadId,
              request.id,
            )
          )
            throw new Error("This request is still waiting. Try again.");
          setRequestSettled(true);
        }
        return;
      }
      const started = await beginIntegrationAuthorization({
        bridge: desktopBridge(),
        client: hostClient,
        onStarted: tracking.started,
        returnPath: `/threads/${encodeURIComponent(threadId)}`,
        begin: async (returnPath) => {
          const next = await prepare();
          const nextCard = connectCard({
            loaded: next,
            workspace: targetWorkspace,
            allowChanges: selectedAccess === "read-write",
          });
          if (!nextCard.plan?.definition || !nextCard.source)
            throw new Error("Open integration settings to finish this connection.");
          const result = await hostClient.dispatch({
            idempotencyKey: mutationIdempotencyKey(
              `integration-auth:${nextCard.plan.definition.id}`,
            ),
            input: {
              definitionId: nextCard.plan.definition.id,
              exactApplicationSource: nextCard.source,
              returnPath,
              surface: integrationAuthorizationSurface(desktopBridge()),
              ...integrationAuthorizationFinish(desktopBridge(), hostClient),
            },
            type: "integration.authorization.begin",
          });
          if (result.type !== "integration.authorization.begin")
            throw new Error("Integration authorization command mismatch.");
          return result;
        },
      });
      await handOffAuthorization(started, prepared);
    });
  const chooseServer = (serverId: string) =>
    void run(async () => {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${request.id}:server:${serverId}`),
        requestId: request.id,
        response: { kind: "choice", optionId: `server:${serverId}` },
        type: "request.respond",
      });
      await hostClient.refresh();
      setReload((value) => value + 1);
    });
  if (connected)
    return (
      <div className="connect-card__result" role="status">
        <span aria-hidden className="connect-card__result-mark">
          <Icon name="check" />
        </span>
        {card.success}
      </div>
    );
  if (requestSettled) return <ActionNote>Request answered</ActionNote>;
  const foot = (actions: ReactNode, access: ReactNode = null) => (
    <ConnectCardFoot
      access={access}
      actions={actions}
      details={card.details}
      detailsOpen={detailsOpen}
      onDetails={() => setDetailsOpen((open) => !open)}
      scope={card.scope}
    />
  );
  if (!plan)
    return (
      <div className="connect-card">
        <ConnectCardHead card={card} />
        {foot(
          <>
            {card.primary && card.primary.kind !== "server" ? (
              <button
                aria-busy={pending}
                className="btn btn--primary"
                disabled={pending || disabled}
                onClick={install}
              >
                {pending ? <span aria-hidden className="spinner spinner--on-accent" /> : null}
                {card.primary.label}
              </button>
            ) : null}
            <button className="btn btn--ghost" disabled={pending || disabled} onClick={decline}>
              {card.secondary}
            </button>
          </>,
        )}
        {card.installReview ? (
          <IntegrationInstallReview manifest={requestPayload.manifest} />
        ) : null}
        {card.installReview ? (
          <ActionNote>
            {integrationInstallNextStep({
              canInstall: loaded.dashboard.isAdministrator,
              continuesToAccess: true,
              installedTitle: null,
            })}
          </ActionNote>
        ) : null}
        {card.error ? <ActionNote alert>{card.error}</ActionNote> : null}
        {serverChoices.length > 0 ? (
          <div className="connect-card__list">
            {serverChoices.map((server) => (
              <button
                className="connect-card__row"
                key={server.id}
                disabled={pending || disabled}
                onClick={() => chooseServer(server.id)}
                type="button"
              >
                <span className="connect-card__row-text">Continue with {server.name}</span>
                <Icon name="chevron-right" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );

  // Only an OAuth posture depends on a provider application; an API-key
  // integration is connectable with no deployment configuration at all.
  const provider =
    plan.definition !== null &&
    plan.requirement.kind === "provider" &&
    plan.requirement.providerApplicationRequired
      ? plan.requirement.provider
      : null;
  const availability = provider ? connectAvailability(loaded.dashboard, provider) : null;
  const connectPossible = availability === null || availability.kind !== "other-surface";
  const canConnectAccount = connectPossible && accountConnectable(plan);
  const hasAccount = plan.accounts.length > 0;
  const apiKeyMethod = plan.apiKeyMethod;
  // A Request that names an account is answered by that account or not at
  // all, so the only connection worth making for it is the one that repairs it.
  const pinned = plan.requestedConnectionId !== null;
  const reconnect = plan.requestedAccountMissing ? plan.requestedAccountReconnect : null;
  // A key repair is the key itself, so its form is the reconnect, shown at once.
  const showApiKeyForm =
    canConnectAccount &&
    apiKeyMethod !== null &&
    (pinned ? reconnect?.method === "api-key" : apiKeyOpen || !hasAccount);
  // A key reconnects the exact account a Request names: nothing else can say
  // which account an unidentified key belongs to.
  const reconnectedConnectionId = reconnect?.method === "api-key" ? reconnect.account.id : null;
  const settingsPath = plan.definition
    ? `/settings/plugins?provider=${encodeURIComponent(plan.definition.id)}`
    : "/settings/plugins";
  const computerRequirement = plan.requirement.kind === "computer";
  // A computer is chosen here, inline: there is no sign-in to hand off to.
  const showComputerPicker = computerRequirement && !pinned && (connectOpen || !hasAccount);
  const effectiveAccess: IntegrationAccess = effectiveIntegrationAccess(
    plan.requestedAccess,
    selectedAccess === "read-write",
  );
  // A Workspace cannot receive access above the selected computer's ceiling.
  // This uses the access the person is about to grant, including an optional
  // expansion of a read Request, rather than only the Request's original floor.
  const sendUpgrade = computerAccessUpgrade(plan, effectiveAccess);
  const computerAppPresentation = plan.definition?.computerApp;
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
      .then((result) => {
        if (result.type !== "integration.apiKey.connect") {
          throw new Error("No connected account is recorded here. Try again.");
        }
        // An older Host does not say which account the key made; the person
        // then chooses it with Use rather than the card guessing.
        if (result.connectionId) {
          answerAfterConnect.current = {
            requestId: request.id,
            connectionId: result.connectionId,
            access: effectiveAccess,
          };
          setSelectedAccountId(result.connectionId);
        }
        setApiKeyOpen(false);
        setReload((value) => value + 1);
      })
      .catch((reason: unknown) => setApiKeyError(errorMessage(reason)))
      .finally(() => setPending(false));
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
      await finishDesktopIntegrationAuthorization(
        desktopBridge(),
        hostClient,
        authorization.attemptId,
      );
      tracking.finished(authorization.attemptId);
      if (authorizationController.current !== controller) return;
      const generation = ++operationGeneration.current;
      controller?.abort();
      authorizationController.current = null;
      setAuthorization(null);
      setPending(false);
      const outcome = integrationAuthorizationError(status.status, status.failureCode);
      if (outcome) {
        answerAfterConnect.current = null;
        setError(outcome);
        return;
      }
      setPending(true);
      try {
        await handOffAuthorization(authorization, loaded, status);
      } catch (reason) {
        if (operationGeneration.current === generation) setError(errorMessage(reason));
      } finally {
        if (operationGeneration.current === generation) setPending(false);
      }
    } catch (reason) {
      if (authorizationController.current === controller) setError(errorMessage(reason));
    }
  };

  const connect = () => {
    lastAction.current = "connect";
    const bridge = desktopBridge();
    repositoryCheck.current?.abort();
    if (provider && plan.definition) {
      const source = card.source;
      if (source === null) {
        setError("Choose a sign-in account in Settings to continue.");
        return;
      }
      void run(async () => {
        const started = await connectOperations.beginAuthorization({
          applicationSource: source,
          definitionId: plan.definition!.id,
          returnPath: `/threads/${encodeURIComponent(threadId)}`,
        });
        await handOffAuthorization(started);
      });
      return;
    }
    if (plan.requirement.kind === "mcp-oauth" && loaded.request.requestedServerId) {
      void run(async () => {
        const started = await beginIntegrationAuthorization({
          bridge,
          client: hostClient,
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
                serverId: IntegrationServerIdSchema.parse(loaded.request.requestedServerId),
                surface: integrationAuthorizationSurface(bridge),
                ...integrationAuthorizationFinish(bridge, hostClient),
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

  const allow = () => {
    lastAction.current = "allow";
    void run(async () => {
      await resolveIntegrationAccess(hostClient, {
        access: effectiveAccess,
        accountsCount: plan.accounts.length,
        installationTitle: plan.installationTitle,
        requestId: request.id,
        selectedAccount: plan.selectedAccount,
        targetKind: targetWorkspace.kind,
      });
      if (await integrationRequestStillPending(hostClient, request.originatingThreadId, request.id))
        throw new Error("This request is still waiting. Try again.");
      if (plan.selectedAccount) setConnected(plan.selectedAccount);
      else setRequestSettled(true);
    });
  };

  const primary = () => {
    if (card.primary?.kind === "retry") {
      setError(null);
      if (repositorySetup) setReload((value) => value + 1);
      else if (lastAction.current === "allow" && plan.selectedAccount) allow();
      else if (card.source || plan.requirement.kind === "mcp-oauth") connect();
      else setReload((value) => value + 1);
      return;
    }
    if (card.primary?.kind === "repositories") {
      void recheckRepositorySetup();
      return;
    }
    if (card.primary?.kind === "use") {
      allow();
      return;
    }
    if (sendUpgrade) {
      setComputerApp({ access: "read-write", runnerId: sendUpgrade.runnerId });
      return;
    }
    if (computerRequirement) setConnectOpen(true);
    else if (apiKeyMethod) setApiKeyOpen(true);
    else connect();
  };
  const accountRows = accountsExpanded
    ? { rows: card.accounts, hidden: 0 }
    : collapsedAccountRows(card.accounts, collapsedAccountLimit);
  const addAccount = () => {
    if (computerRequirement) setConnectOpen(true);
    else if (apiKeyMethod) setApiKeyOpen(true);
    else connect();
  };
  const showAdd = card.canConnectAnother && hasAccount && !showApiKeyForm && !showComputerPicker;
  const accessChoice = card.canAllowChanges ? (
    <SegmentedControl
      ariaLabel="Access"
      className="connect-card__access"
      disabled={pending || disabled}
      onChange={(value: IntegrationAccess) => setSelectedAccess(value)}
      options={[
        {
          label: computerAppPresentation?.accessLabels.read ?? "Read only",
          value: "read",
        },
        {
          label: computerAppPresentation?.accessLabels.readWrite ?? "Read and write",
          value: "read-write",
        },
      ]}
      value={effectiveAccess}
    />
  ) : null;
  return (
    <div
      className="connect-card"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          event.target === event.currentTarget &&
          !pending &&
          !disabled
        ) {
          event.preventDefault();
          primary();
        }
      }}
    >
      <ConnectCardHead card={card} />
      {/* First in focus order, placed at the foot of the card by CSS. */}
      {!showApiKeyForm
        ? foot(
            <>
              {card.primary ? (
                card.primary.kind === "settings" ? (
                  <Link className="btn btn--primary" to={settingsPath}>
                    {card.primary.label}
                  </Link>
                ) : (
                  <button
                    aria-busy={pending}
                    className="btn btn--primary"
                    disabled={pending || disabled}
                    onClick={primary}
                    type="button"
                  >
                    {pending ? <span aria-hidden className="spinner spinner--on-accent" /> : null}
                    {card.primary.label}
                  </button>
                )
              ) : null}
              {authorization ? (
                <button
                  className="btn btn--ghost"
                  onClick={() => void cancelAuthorization()}
                  type="button"
                >
                  Cancel
                </button>
              ) : (
                <button
                  className="btn btn--ghost"
                  disabled={pending || disabled}
                  onClick={decline}
                  type="button"
                >
                  {card.secondary}
                </button>
              )}
            </>,
            accessChoice,
          )
        : foot(null)}
      {card.error ? <ActionNote alert>{card.error}</ActionNote> : null}
      {computerSetupNotice ? (
        <>
          <ActionNote>{computerSetupNotice}</ActionNote>
          <button
            className="btn"
            disabled={pending || disabled}
            onClick={() => setReload((value) => value + 1)}
            type="button"
          >
            Check setup
          </button>
        </>
      ) : null}
      {accountRows.rows.length > 0 || authorization || showAdd ? (
        <div className="connect-card__list">
          {accountRows.rows.length > 0 ? (
            <div
              aria-label="Account"
              className={`connect-card__accounts${accountsExpanded ? " connect-card__accounts--expanded" : ""}`}
              role="radiogroup"
            >
              {accountRows.rows.map((account, index) => (
                <button
                  aria-checked={account.selected}
                  className="connect-card__row connect-card__account"
                  disabled={pending || disabled || authorization !== null}
                  key={account.id}
                  onClick={() => setSelectedAccountId(account.id)}
                  onKeyDown={(event) => {
                    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key))
                      return;
                    event.preventDefault();
                    const rows = accountRows.rows;
                    const offset = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
                    const next = (index + offset + rows.length) % rows.length;
                    setSelectedAccountId(rows[next]!.id);
                    (
                      event.currentTarget.parentElement?.children[next] as HTMLElement | undefined
                    )?.focus();
                  }}
                  role="radio"
                  tabIndex={account.selected ? 0 : -1}
                  type="button"
                >
                  <span aria-hidden className="connect-card__avatar">
                    {accountInitial(account.label)}
                  </span>
                  <span className="connect-card__row-text">
                    <span className="connect-card__row-label">{account.label}</span>
                    {account.detail ? <small>{account.detail}</small> : null}
                  </span>
                  <span aria-hidden className="connect-card__radio" />
                </button>
              ))}
            </div>
          ) : null}
          {accountRows.hidden > 0 ? (
            <button
              aria-expanded={false}
              className="connect-card__row connect-card__more"
              onClick={() => setAccountsExpanded(true)}
              type="button"
            >
              <span className="connect-card__row-text">Show {accountRows.hidden} more</span>
              <Icon name="chevron-down" />
            </button>
          ) : null}
          {authorization ? (
            <div className="connect-card__row connect-card__pending" role="status">
              <span aria-hidden className="spinner" />
              <span className="connect-card__row-text">Finish signing in in your browser</span>
            </div>
          ) : showAdd ? (
            <button
              className="connect-card__row connect-card__add"
              disabled={pending || disabled}
              onClick={addAccount}
              type="button"
            >
              <span aria-hidden className="connect-card__avatar connect-card__avatar--add">
                <Icon name="plus" />
              </span>
              <span className="connect-card__row-text">
                {computerRequirement ? "Use another computer" : "Add another account"}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
      {reconnect ? (
        <div className="connect-card__reconnect">
          <strong>{reconnect.account.displayName}</strong>
          <p>
            {integrationAccountDetail(reconnect.account, [reconnect.account, ...plan.accounts])} ·
            Needs attention
          </p>
        </div>
      ) : null}
      {reconnect?.statusDetail ? <ActionNote>{reconnect.statusDetail}</ActionNote> : null}
      {plan.requirement.kind === "mcp-oauth" && !hasAccount ? (
        <label className="action-field">
          <span>Account name</span>
          <input
            className="text-input"
            maxLength={160}
            onChange={(event) => setAccountName(event.target.value)}
            value={accountName || `${plan.installationTitle} account`}
          />
        </label>
      ) : null}
      {showApiKeyForm && apiKeyMethod && plan.definition ? (
        <ApiKeyForm
          definition={plan.definition}
          proposed={card.proposed}
          {...(reconnect?.method === "api-key"
            ? { displayName: reconnect.account.displayName }
            : {})}
          primaryLabel={
            apiKeyError
              ? "Try again"
              : reconnect
                ? `Reconnect ${reconnect.account.accountIdentifier ?? reconnect.account.displayName}`
                : `Connect ${card.name}`
          }
          error={apiKeyError}
          method={apiKeyMethod}
          onSubmit={connectApiKey}
          pending={pending || disabled}
          secondaryAction={
            apiKeyOpen && hasAccount ? (
              <button
                className="btn"
                disabled={pending}
                onClick={() => setApiKeyOpen(false)}
                type="button"
              >
                Cancel
              </button>
            ) : (
              <button
                className="btn"
                disabled={pending || disabled}
                onClick={decline}
                type="button"
              >
                Not now
              </button>
            )
          }
        />
      ) : null}
      {showComputerPicker && plan.definition ? (
        <ComputerAppPicker
          busy={pending || disabled}
          connections={loaded.dashboard.connections}
          definition={plan.definition}
          machines={snapshot.machines}
          onTurnOn={setComputerApp}
        />
      ) : null}
      {sendUpgrade ? (
        <ActionNote>{`${plan.definition?.computerApp?.accessLabels.readWrite ?? "Changes"} must be enabled on ${sendUpgrade.displayName} before this access can be allowed. ${plan.definition?.computerApp?.accessSummaries.readWrite ?? ""}`}</ActionNote>
      ) : null}
      {repositorySetup ? (
        <div className="action-field">
          <strong>Choose GitHub repositories</strong>
          <RepositoryAccessSetup access={repositorySetup.access} />
          <button
            className="btn"
            onClick={() => {
              repositoryCheck.current?.abort();
              setRepositorySetup(null);
            }}
            type="button"
          >
            Finish later
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Rows shown before "Show more"; a phone shows fewer, where the card covers more. */
const collapsedAccountLimit = 3;

function accountInitial(label: string): string {
  return (label.trim()[0] ?? "?").toLocaleUpperCase();
}

function ConnectCardHead({ card }: { readonly card: ConnectCard }) {
  return (
    <div className="connect-card__heading">
      <IntegrationIcon id={card.iconId} name={card.name} />
      <div className="connect-card__titles">
        <span className="connect-card__title">
          <strong>{card.title}</strong>
          {card.proposed ? <AgentProposedChip /> : null}
        </span>
        {card.reason ? <p className="connect-card__reason">{card.reason}</p> : null}
      </div>
    </div>
  );
}

/**
 * The card's last line: where the access lands, which opens what it means, and
 * the answer. It comes first in the markup so the primary action is the first
 * focus stop, and CSS places it at the foot.
 */
function ConnectCardFoot({
  access,
  actions,
  details,
  detailsOpen,
  onDetails,
  scope,
}: {
  readonly access: ReactNode;
  readonly actions: ReactNode;
  readonly details: readonly string[];
  readonly detailsOpen: boolean;
  readonly onDetails: () => void;
  readonly scope: string | null;
}) {
  const canOpen = details.length > 0;
  return (
    <div className="connect-card__foot">
      <div className="connect-card__foot-row">
        {actions === null ? null : <div className="connect-card__actions">{actions}</div>}
        {access}
        {canOpen ? (
          <button
            aria-expanded={detailsOpen}
            className="connect-card__scope"
            onClick={onDetails}
            type="button"
          >
            <span>{scope ?? "Details"}</span>
            <Icon name="chevron-down" />
          </button>
        ) : scope === null ? (
          <span className="connect-card__scope-gap" />
        ) : (
          <span className="connect-card__scope">{scope}</span>
        )}
      </div>
      {canOpen && detailsOpen ? (
        <div className="connect-card__details">
          {details.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
    </div>
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
