import { requestDecision, type RequestView } from "@opensteer/client/host";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IntegrationAccess } from "@opensteer/integration-core";
import type { Request } from "@opensteer/core";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";
import {
  accessPlan,
  collapsedAccountRows,
  computerAccessUpgrade,
  computerAppSetupRequested,
  connectCard,
  effectiveIntegrationAccess,
  integrationRequestStillPending,
  loadAccessRequest,
  type ReviewedAccessRequest,
  resolveIntegrationAccess,
  setPhoneUseAccess,
  type AccessRequestAccount,
  type ConnectCard,
} from "@opensteer/client/integrations";
import { isPhoneDisplayDefinitionId, RunnerIdSchema } from "@opensteer/core";
import { createClientRead } from "@opensteer/client/reads";
import { useClientRead } from "@opensteer/client/react";
import { ActionLine } from "./action-line.js";
import { readWords, Refusal, requestAnswer, useAction } from "./use-action.js";
import { LoadingRows } from "./loading-rows.js";
import { ActionNote } from "./action-rows.js";
import { useShell } from "./app-shell.js";
import { ComputerAppPicker } from "./computer-apps/computer-app-picker.js";
import { Icon } from "./icon.js";
import { IntegrationIcon } from "./integration-icon.js";
import { SegmentedControl } from "./segmented-control.js";

/**
 * An agent's ask for a device data app on a computer or phone, or for a local
 * server: choose the computer, set how much it may do, and allow it.
 */
export function ThreadIntegrationAction({
  disabled = false,
  request,
}: {
  readonly disabled?: boolean;
  readonly request: RequestView;
  readonly threadId: string;
}) {
  const { hostClient, snapshot } = useShell();
  const [updatedAccess, setLoaded] = useState<ReviewedAccessRequest | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedAccess, setSelectedAccess] = useState<IntegrationAccess | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [computerSetupNotice, setComputerSetupNotice] = useState<string | null>(null);
  const [requestSettled, setRequestSettled] = useState(false);
  const [connected, setConnected] = useState<AccessRequestAccount | null>(null);
  /** What Try again repeats: a failed install must never become approval. */
  const lastAction = useRef<"allow" | "install" | null>(null);
  const requestPayload = request.payload.kind === "integration.access" ? request.payload : null;

  const resource = useMemo(
    () =>
      createClientRead(hostClient, {
        key: `integration-access:${request.id}`,
        label: "this account",
        read: () =>
          Promise.all([
            hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
            hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
          ]).then(([dashboard, platform]) => ({ dashboard, platform })),
      }),
    [hostClient, request.id],
  );
  const access = useClientRead(requestPayload ? resource : null);
  const refresh = access.refresh;
  const loaded = access.data && updatedAccess?.id === request.id ? updatedAccess : null;
  const decision = (view = loaded) => requestDecision(view ?? request);
  const answering = useAction(
    hostClient,
    {
      ...requestAnswer,
      execute: (operation: () => Promise<void>) => operation(),
      reconcile: async () => {
        refresh();
        return (await integrationRequestStillPending(
          hostClient,
          request.originatingThreadId,
          request.id,
        ))
          ? null
          : { kind: "confirmed", value: undefined };
      },
    },
    `integration-request:${request.id}`,
  );
  const pending = answering.running;
  const error = answering.outcome?.kind !== "not-sent" ? (answering.line?.text ?? null) : null;
  const line = answering.line ? <ActionLine line={answering.line} wrap /> : null;

  useEffect(() => {
    setRequestSettled(false);
    setLoaded(null);
    setConnected(null);
    setSelectedAccountId(null);
    setSelectedAccess(null);
    setPickerOpen(false);
    setAccountsExpanded(false);
    setDetailsOpen(false);
    setComputerSetupNotice(null);
  }, [request.id, hostClient]);

  useEffect(() => {
    if (!access.data || !requestPayload) {
      setLoaded(null);
      return;
    }
    const data = access.data;
    setLoaded((current) => loadAccessRequest(data, request, current));
  }, [access.data, request]);
  const plan = useMemo(
    () => (loaded ? accessPlan(loaded, selectedAccountId) : null),
    [loaded, selectedAccountId],
  );

  // A failure is said on this card, where the action was taken, and nowhere else.
  const run = (operation: () => Promise<void>) => {
    if (pending || disabled) return;
    return answering.run(operation);
  };

  const decline = () =>
    void run(() =>
      hostClient
        .dispatch({
          idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
          ...decision(),
          response: { kind: "external", value: { decision: "declined" } },
          type: "request.respond",
        })
        .then(() => undefined),
    );

  if (!requestPayload)
    return (
      <>
        <RequestNameHead request={request} />
        <ActionNote alert>This access Request is invalid.</ActionNote>
      </>
    );
  if (!loaded)
    return (
      <>
        <RequestNameHead request={request} />
        {access.issue ? (
          <ActionNote alert>{readWords(access.issue) ?? ""}</ActionNote>
        ) : (
          <LoadingRows label="Checking access" rows={2} />
        )}
        {line}
        {access.issue ? (
          <>
            <button className="btn" disabled={disabled || pending} onClick={decline} type="button">
              Not now
            </button>
            <button className="btn btn--primary" onClick={refresh} type="button">
              Try again
            </button>
          </>
        ) : null}
      </>
    );
  const card = connectCard({
    loaded,
    selectedAccountId,
    allowChanges: selectedAccess === "read-write",
    error,
    connectedAccount: connected,
    answered: requestSettled,
  });

  /** Installs the catalog app the Request names; the Request then asks for its computer. */
  const install = () => {
    lastAction.current = "install";
    void run(async () => {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${request.id}:install`),
        ...decision(),
        response: { kind: "choice", optionId: "installed" },
        type: "request.respond",
      });
      const updated = await hostClient.readRequest(request.originatingThreadId, request.id);
      if (updated?.status !== "pending" || updated.payload.kind !== "integration.access")
        throw new Error("This request is no longer available.");
      const [dashboard, platform] = await Promise.all([
        hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
        hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
      ]);
      setLoaded(loadAccessRequest({ dashboard, platform }, updated));
    });
  };
  const chooseServer = (serverId: string) =>
    void run(async () => {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${request.id}:server:${serverId}`),
        ...decision(),
        response: { kind: "choice", optionId: `server:${serverId}` },
        type: "request.respond",
      });
      await hostClient.refresh();
      refresh();
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
  if (requestSettled)
    return (
      <>
        <RequestNameHead request={request} />
        <ActionNote>Request answered</ActionNote>
      </>
    );
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
                type="button"
              >
                {pending ? <span aria-hidden className="spinner spinner--on-accent" /> : null}
                {card.primary.label}
              </button>
            ) : null}
            <button
              className="btn btn--ghost"
              disabled={pending || disabled}
              onClick={decline}
              type="button"
            >
              {card.secondary}
            </button>
          </>,
        )}
        {line ?? (card.error ? <ActionNote alert>{card.error}</ActionNote> : null)}
        {card.serverChoices.length > 0 ? (
          <div className="connect-card__list">
            {card.serverChoices.map((server) => (
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

  const computerRequirement = plan.requirement.kind === "computer";
  const hasAccount = plan.accounts.length > 0;
  const pinned = plan.requestedConnectionId !== null;
  // A computer is chosen here, inline: there is no sign-in to hand off to.
  const showComputerPicker = computerRequirement && !pinned && (pickerOpen || !hasAccount);
  const effectiveAccess = effectiveIntegrationAccess(
    plan.requestedAccess,
    selectedAccess === "read-write",
  );
  // Access never goes above the selected computer's ceiling, including an
  // optional expansion of a read Request.
  const sendUpgrade = computerAccessUpgrade(plan, effectiveAccess);
  const computerApp = plan.definition?.computerApp;
  const setComputerApp = (input: {
    readonly access: IntegrationAccess;
    readonly runnerId: string;
  }) =>
    void run(async () => {
      if (!plan.definition) throw new Error("Computer app definition is unavailable.");
      const computer = snapshot.machines.find((machine) => machine.id === input.runnerId);
      const computerName = computer?.name ?? "that computer";
      // The owner sets a phone's access here; a Mac app is approved on that Mac.
      if (isPhoneDisplayDefinitionId(plan.definition.id)) {
        if (!computer) throw new Error("That phone isn’t one of your devices any more.");
        await setPhoneUseAccess(hostClient, computer, input.access);
        setComputerSetupNotice(`Agents can now use ${computerName} at the access you chose.`);
        refresh();
        setPickerOpen(false);
        return;
      }
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
      const result = await hostClient.dispatch({
        ...command,
        type: "integration.computer.setup.request",
      });
      if (result.type !== "integration.computer.setup.request") {
        throw new Error("Integration computer command mismatch.");
      }
      setComputerSetupNotice(computerAppSetupRequested(plan.definition.name, computerName));
      setPickerOpen(false);
    });

  const allow = () => {
    lastAction.current = "allow";
    void run(async () => {
      await resolveIntegrationAccess(hostClient, {
        access: effectiveAccess,
        accountsCount: plan.accounts.length,
        installationTitle: plan.installationTitle,
        ...decision(),
        selectedAccount: plan.selectedAccount,
      });
      if (await integrationRequestStillPending(hostClient, request.originatingThreadId, request.id))
        throw new Refusal("This request is still waiting. Try again.");
      if (plan.selectedAccount) setConnected(plan.selectedAccount);
      else setRequestSettled(true);
    });
  };

  const primary = () => {
    if (card.primary?.kind === "retry") {
      answering.dismiss();
      if (lastAction.current === "allow") allow();
      else refresh();
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
    if (computerRequirement) setPickerOpen(true);
  };
  const accountRows = accountsExpanded
    ? { rows: card.accounts, hidden: 0 }
    : collapsedAccountRows(card.accounts, collapsedAccountLimit);
  const showAdd = card.canConnectAnother && hasAccount && !showComputerPicker;
  const accessChoice = card.canAllowChanges ? (
    <SegmentedControl
      ariaLabel="Access"
      className="connect-card__access"
      disabled={pending || disabled}
      onChange={(value: IntegrationAccess) => setSelectedAccess(value)}
      options={[
        { label: computerApp?.accessLabels.read ?? "Read only", value: "read" },
        { label: computerApp?.accessLabels.readWrite ?? "Read and write", value: "read-write" },
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
      {foot(
        <>
          {card.primary ? (
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
          ) : null}
          <button
            className="btn btn--ghost"
            disabled={pending || disabled}
            onClick={decline}
            type="button"
          >
            {card.secondary}
          </button>
        </>,
        accessChoice,
      )}
      {line ?? (card.error ? <ActionNote alert>{card.error}</ActionNote> : null)}
      {computerSetupNotice ? (
        <>
          <ActionNote>{computerSetupNotice}</ActionNote>
          <button
            className="btn"
            disabled={pending || disabled}
            onClick={() => refresh()}
            type="button"
          >
            Check setup
          </button>
        </>
      ) : null}
      {accountRows.rows.length > 0 || showAdd ? (
        <div className="connect-card__list">
          {accountRows.rows.length > 0 ? (
            <div
              aria-label="Computer"
              className={`connect-card__accounts${accountsExpanded ? " connect-card__accounts--expanded" : ""}`}
              role="radiogroup"
            >
              {accountRows.rows.map((account, index) => (
                <button
                  aria-checked={account.selected}
                  className="connect-card__row connect-card__account"
                  disabled={pending || disabled}
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
                    {(account.label.trim()[0] ?? "?").toLocaleUpperCase()}
                  </span>
                  <span className="connect-card__row-text">
                    <span className="connect-card__row-label">{account.label}</span>
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
          {showAdd ? (
            <button
              className="connect-card__row connect-card__add"
              disabled={pending || disabled}
              onClick={() => setPickerOpen(true)}
              type="button"
            >
              <span aria-hidden className="connect-card__avatar connect-card__avatar--add">
                <Icon name="plus" />
              </span>
              <span className="connect-card__row-text">Use another computer</span>
            </button>
          ) : null}
        </div>
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
        <ActionNote>{`${computerApp?.accessLabels.readWrite ?? "Changes"} must be enabled on ${sendUpgrade.displayName} before this access can be allowed. ${computerApp?.accessSummaries.readWrite ?? ""}`}</ActionNote>
      ) : null}
    </div>
  );
}

/** Rows shown before "Show more". */
const collapsedAccountLimit = 3;

/** What the Request says of itself, for the states with no card to name it. */
function RequestNameHead({ request }: { readonly request: Request }) {
  const reason = request.payload.kind === "integration.access" ? request.payload.reason : null;
  return (
    <div className="connect-card__titles">
      <span className="connect-card__title">
        <strong>{request.presentation.title}</strong>
      </span>
      {reason ? <p className="connect-card__reason">{reason}</p> : null}
    </div>
  );
}

function ConnectCardHead({ card }: { readonly card: ConnectCard }) {
  return (
    <div className="connect-card__heading">
      <IntegrationIcon id={card.iconId} name={card.name} />
      <div className="connect-card__titles">
        <span className="connect-card__title">
          <strong>{card.title}</strong>
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
  readonly scope: string;
}) {
  const canOpen = details.length > 0;
  return (
    <div className="connect-card__foot">
      <div className="connect-card__foot-row">
        <div className="connect-card__actions">{actions}</div>
        {access}
        {canOpen ? (
          <button
            aria-expanded={detailsOpen}
            className="connect-card__scope"
            onClick={onDetails}
            type="button"
          >
            <span>{scope}</span>
            <Icon name="chevron-down" />
          </button>
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
