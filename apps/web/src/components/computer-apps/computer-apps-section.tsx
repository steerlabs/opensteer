import type {
  IntegrationAccess,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummaryView,
  IntegrationPlatformDashboardView,
  ComputerAppSetupRequest,
} from "@opensteer/integration-core";
import type { ComputerAppRemedy, MachineSummary } from "@opensteer/protocol";
import {
  computerAppAccessLabel,
  computerAppPermissionNotice,
  computerAppRows,
  computerAppSetupElsewhere,
  computerAppStateDotClass,
  computerAppTurnOffConsequence,
  computerUseSetUpFromSteps,
  computerUseView,
  iphoneAppStatus,
  isIphone,
  type ComputerAppRow,
} from "@opensteer/client/integrations";
import {
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";
import { IntegrationIcon } from "../integrations/integration-icon.js";
import { ComputerAppWorkspaceAccess } from "./computer-app-workspace-access.js";
import {
  ComputerUseBlock,
  type ComputerUseApprovalKeySetup,
  type ComputerUseLocalActions,
} from "./computer-use-section.js";

export function useComputerAppData(hostClient: HostClient, revision: number) {
  const [result, setResult] = useState<{
    readonly client: HostClient;
    readonly data: {
      readonly connections: readonly IntegrationConnectionSummary[];
      readonly definitions: readonly IntegrationDefinitionSummaryView[];
      readonly platform: IntegrationPlatformDashboardView;
      readonly setupRequests: readonly ComputerAppSetupRequest[];
    } | null;
    readonly error: string | null;
  } | null>(null);
  const source = useMemo(() => ({ active: false, request: 0 }), [hostClient]);

  const load = useCallback(async () => {
    if (!source.active) return;
    const current = ++source.request;
    try {
      const [dashboard, platform, setup] = await Promise.all([
        hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
        hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
        hostClient.rpc["integration.computer.setup.list"]({}).then(unwrapRpcResult),
      ]);
      if (!source.active || current !== source.request) return;
      setResult({
        client: hostClient,
        data: {
          connections: dashboard.connections,
          definitions: platform.catalog.map(({ definition }) => definition),
          platform,
          setupRequests: setup.requests,
        },
        error: null,
      });
    } catch (reason) {
      if (source.active && current === source.request) {
        setResult((previous) => ({
          client: hostClient,
          data: previous?.client === hostClient ? previous.data : null,
          error: actionErrorMessage(reason),
        }));
      }
      throw reason;
    }
  }, [hostClient, source]);

  useEffect(() => {
    source.active = true;
    void load().catch(() => undefined);
    return () => {
      source.active = false;
      source.request += 1;
    };
  }, [load, revision, source]);

  return {
    data: result?.client === hostClient ? result.data : null,
    error: result?.client === hostClient ? result.error : null,
    reload: load,
  };
}

export interface ComputerAppAccessInput {
  readonly access: IntegrationAccess;
  readonly definitionId: string;
  readonly runnerId: string;
}

export interface ComputerAppRequestInput extends ComputerAppAccessInput {
  readonly appName: string;
}

export interface ComputerAppApprovalInput extends ComputerAppAccessInput {
  readonly request: ComputerAppSetupRequest | null;
}

/**
 * Capabilities available only after the Host has positively established that
 * this session may approve access on the target computer. Presence controls
 * presentation; the callbacks still require server-side authorization.
 */
export interface ComputerAppLocalApproval {
  /** False means the native confirmation was declined without changing access. */
  readonly approveAccess: (input: ComputerAppApprovalInput) => Promise<boolean>;
  /** Sets the app up on this Mac at the access it was allowed. */
  readonly reviewPermission: (input: {
    readonly access: IntegrationAccess;
    readonly definitionId: string;
    readonly remedy: ComputerAppRemedy | null;
  }) => Promise<void>;
}

interface PendingChange {
  readonly access: IntegrationAccess | null;
}

type AppPanel = "confirm-off" | "manage" | "overview" | "setup";

export function ComputerAppsSection({
  computerUseApprovalKeySetup = null,
  computerUseLocal = null,
  connections,
  definitions,
  focusDefinitionId = null,
  hostClient,
  hostConnected,
  localApproval = null,
  machine,
  onCancelSetupRequest = null,
  onChanged,
  onRequestSetup = null,
  owned,
  platform,
  setupRequests = [],
  workspaces,
}: {
  readonly computerUseApprovalKeySetup?: ComputerUseApprovalKeySetup | null;
  /** What the desktop on this very Mac can do for computer use; null elsewhere. */
  readonly computerUseLocal?: ComputerUseLocalActions | null;
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definitions: readonly IntegrationDefinitionSummaryView[];
  readonly focusDefinitionId?: string | null;
  readonly hostClient: HostClient;
  /** False while the Host cannot confirm a cached computer-use session. */
  readonly hostConnected: boolean;
  readonly localApproval?: ComputerAppLocalApproval | null;
  readonly machine: MachineSummary;
  readonly onCancelSetupRequest?: ((request: ComputerAppSetupRequest) => Promise<void>) | null;
  readonly onChanged: () => Promise<void>;
  readonly onRequestSetup?: ((input: ComputerAppRequestInput) => Promise<void>) | null;
  readonly owned: boolean;
  readonly platform: IntegrationPlatformDashboardView | null;
  readonly setupRequests?: readonly ComputerAppSetupRequest[];
  readonly workspaces: readonly WorkspaceSummary[];
}) {
  const [pending, setPending] = useState<ReadonlyMap<string, PendingChange>>(() => new Map());
  const pendingIds = useRef(new Set<string>());
  const [panels, setPanels] = useState<ReadonlyMap<string, AppPanel>>(() => new Map());
  const [setupTargets, setSetupTargets] = useState<ReadonlyMap<string, IntegrationAccess>>(
    () => new Map(),
  );
  const [approvedChoices, setApprovedChoices] = useState<
    ReadonlyMap<string, { readonly access: IntegrationAccess; readonly requestId: string | null }>
  >(() => new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const rows = owned ? computerAppRows({ connections, definitions, machine, setupRequests }) : [];
  const computerUse = owned
    ? computerUseView({ connections, definitions, hostConnected, machine, setupRequests })
    : null;

  function panelFor(definitionId: string): AppPanel {
    return panels.get(definitionId) ?? "overview";
  }

  function setPanel(definitionId: string, panel: AppPanel) {
    setPanels((current) => new Map(current).set(definitionId, panel));
    if (panel !== "setup") {
      setApprovedChoices((current) => {
        const next = new Map(current);
        next.delete(definitionId);
        return next;
      });
    }
  }

  function requestFor(definitionId: string): ComputerAppSetupRequest | null {
    return (
      setupRequests.find(
        (request) => request.runnerId === machine.id && request.definitionId === definitionId,
      ) ?? null
    );
  }

  function begin(definitionId: string, access: IntegrationAccess | null) {
    pendingIds.current.add(definitionId);
    setPending((current) => new Map(current).set(definitionId, { access }));
    setErrors((current) => {
      const next = new Map(current);
      next.delete(definitionId);
      return next;
    });
  }

  function finish(definitionId: string) {
    pendingIds.current.delete(definitionId);
    setPending((current) => {
      const next = new Map(current);
      next.delete(definitionId);
      return next;
    });
  }

  async function run(
    row: ComputerAppRow,
    optimisticAccess: IntegrationAccess | null,
    operation: () => Promise<void>,
  ) {
    const definitionId = row.definition.id;
    if (pendingIds.current.has(definitionId)) return;
    begin(definitionId, optimisticAccess);
    try {
      await operation();
      await onChanged();
    } catch (reason) {
      setErrors((current) => new Map(current).set(definitionId, actionErrorMessage(reason)));
    } finally {
      finish(definitionId);
    }
  }

  async function reduceOrTurnOff(row: ComputerAppRow, access: IntegrationAccess | null) {
    if (row.access === access) return;
    if (access === null && row.connectionId === null) {
      setErrors((current) =>
        new Map(current).set(row.definition.id, "This app connection is no longer available."),
      );
      return;
    }
    await run(row, access, async () => {
      const result =
        access === null
          ? await hostClient.dispatch({
              connectionId: row.connectionId,
              idempotencyKey: mutationIdempotencyKey(`computer-app:${row.definition.id}`),
              type: "integration.disconnect",
            })
          : await hostClient.dispatch({
              idempotencyKey: mutationIdempotencyKey(`computer-app:${row.definition.id}`),
              input: {
                access,
                app: null,
                definitionId: row.definition.id,
                kind: "app",
                runnerId: machine.id,
              },
              type: "integration.computer.setup.set",
            });
      if (
        result.type !== "integration.disconnect" &&
        result.type !== "integration.computer.setup.set"
      ) {
        throw new Error("The app change did not complete.");
      }
      setPanel(row.definition.id, "overview");
    });
  }

  async function approve(row: ComputerAppRow, access: IntegrationAccess) {
    if (!localApproval) return;
    await run(row, access, async () => {
      const approved = await localApproval.approveAccess({
        access,
        definitionId: row.definition.id,
        request: requestFor(row.definition.id),
        runnerId: machine.id,
      });
      if (approved) {
        setApprovedChoices((current) =>
          new Map(current).set(row.definition.id, {
            access,
            requestId: requestFor(row.definition.id)?.id ?? null,
          }),
        );
      }
    });
  }

  async function requestSetup(row: ComputerAppRow, access: IntegrationAccess) {
    if (!onRequestSetup) return;
    await run(row, row.access, async () => {
      await onRequestSetup({
        access,
        appName: row.definition.name,
        definitionId: row.definition.id,
        runnerId: machine.id,
      });
      setPanel(row.definition.id, "overview");
    });
  }

  async function cancelRequest(row: ComputerAppRow) {
    if (!onCancelSetupRequest) return;
    const request = requestFor(row.definition.id);
    if (!request) return;
    await run(row, row.access, async () => {
      await onCancelSetupRequest(request);
    });
  }

  function startSetup(row: ComputerAppRow, access?: IntegrationAccess) {
    const target = access ?? requestFor(row.definition.id)?.access ?? row.access ?? "read";
    setSetupTargets((current) => new Map(current).set(row.definition.id, target));
    setApprovedChoices((current) => {
      const next = new Map(current);
      next.delete(row.definition.id);
      return next;
    });
    setPanel(row.definition.id, "setup");
  }

  if (rows.length === 0 && computerUse === null) return null;

  return (
    <section aria-labelledby="computer-apps-title" className="computers-section">
      <div className="section-heading">
        <div>
          <h2 id="computer-apps-title">Apps agents can use</h2>
        </div>
      </div>
      <div className="card computer-apps">
        {computerUse ? (
          <ComputerUseBlock
            approvalKeySetup={computerUseApprovalKeySetup}
            hostClient={hostClient}
            local={computerUseLocal}
            machine={machine}
            onChanged={onChanged}
            owned={owned}
            view={computerUse}
          />
        ) : null}
        {rows.map((sourceRow) => {
          const pendingChange = pending.get(sourceRow.definition.id) ?? null;
          const row =
            pendingChange === null ? sourceRow : { ...sourceRow, access: pendingChange.access };
          const request = requestFor(row.definition.id);
          const setupTarget = setupTargets.get(row.definition.id) ?? row.access ?? "read";
          const approvedChoice = approvedChoices.get(row.definition.id);
          return (
            <AppRow
              approvedChoice={
                approvedChoice?.access === setupTarget &&
                sourceRow.access === setupTarget &&
                (request === null || approvedChoice.requestId === request.id)
              }
              error={errors.get(row.definition.id) ?? null}
              focused={focusDefinitionId === row.definition.id}
              hostClient={hostClient}
              installationId={installationIdFor(platform, row.definition.id)}
              key={row.definition.id}
              localApproval={localApproval}
              machine={machine}
              onApprove={(access) => void approve(sourceRow, access)}
              onCancelRequest={() => void cancelRequest(sourceRow)}
              onClose={() => setPanel(row.definition.id, "overview")}
              onConfirmOff={() => void reduceOrTurnOff(sourceRow, null)}
              onManage={() => setPanel(row.definition.id, "manage")}
              onReduce={() => void reduceOrTurnOff(sourceRow, "read")}
              onRequest={(access) => void requestSetup(sourceRow, access)}
              onSetup={(access) => startSetup(sourceRow, access)}
              onSetupTarget={(access) => {
                setSetupTargets((current) => new Map(current).set(row.definition.id, access));
                setApprovedChoices((current) => {
                  const next = new Map(current);
                  next.delete(row.definition.id);
                  return next;
                });
              }}
              onTurnOff={() => setPanel(row.definition.id, "confirm-off")}
              owned={owned}
              panel={panelFor(row.definition.id)}
              pending={pendingChange !== null}
              request={request}
              row={row}
              setupTarget={setupTarget}
              workspaces={workspaces}
            />
          );
        })}
      </div>
    </section>
  );
}

function installationIdFor(
  platform: IntegrationPlatformDashboardView | null,
  definitionId: string,
): string | null {
  return (
    platform?.catalog.find((entry) => entry.definition.id === definitionId)?.installationId ?? null
  );
}

export function computerAppAnchorId(definitionId: string): string {
  return `computer-app-${definitionId}`;
}

function AppRow({
  approvedChoice,
  error,
  focused,
  hostClient,
  installationId,
  localApproval,
  machine,
  onApprove,
  onCancelRequest,
  onClose,
  onConfirmOff,
  onManage,
  onReduce,
  onRequest,
  onSetup,
  onSetupTarget,
  onTurnOff,
  owned,
  panel,
  pending,
  request,
  row,
  setupTarget,
  workspaces,
}: {
  readonly approvedChoice: boolean;
  readonly error: string | null;
  readonly focused: boolean;
  readonly hostClient: HostClient;
  readonly installationId: string | null;
  readonly localApproval: ComputerAppLocalApproval | null;
  readonly machine: MachineSummary;
  readonly onApprove: (access: IntegrationAccess) => void;
  readonly onCancelRequest: () => void;
  readonly onClose: () => void;
  readonly onConfirmOff: () => void;
  readonly onManage: () => void;
  readonly onReduce: () => void;
  readonly onRequest: (access: IntegrationAccess) => void;
  readonly onSetup: (access?: IntegrationAccess) => void;
  readonly onSetupTarget: (access: IntegrationAccess) => void;
  readonly onTurnOff: () => void;
  readonly owned: boolean;
  readonly panel: AppPanel;
  readonly pending: boolean;
  readonly request: ComputerAppSetupRequest | null;
  readonly row: ComputerAppRow;
  readonly setupTarget: IntegrationAccess;
  readonly workspaces: readonly WorkspaceSummary[];
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const expanded = panel !== "overview";
  // An iPhone turns its apps on and answers requests for more access itself,
  // so from here its rows only lower access, turn it off, or decline.
  const iphone = isIphone(machine);

  useEffect(() => {
    if (focused) anchor.current?.scrollIntoView({ block: "center" });
  }, [focused]);

  return (
    <div
      className={`computer-apps__app${focused ? " computer-apps__app--focused" : ""}${
        expanded ? " computer-apps__app--expanded" : ""
      }`}
      id={computerAppAnchorId(row.definition.id)}
      ref={anchor}
    >
      <div className="computer-apps__head">
        <IntegrationIcon
          icon={row.definition.icon}
          id={row.definition.id}
          name={row.definition.name}
        />
        <span className="card__row-body">
          <span className="card__row-title">{row.definition.name}</span>
          <span className="computer-apps__status computer-apps__status--line">
            <span
              aria-hidden
              className={`status-dot ${
                iphone
                  ? iphoneStatusDotClass(
                      iphoneAppStatus({ machineName: machine.name, request, row }).tone,
                    )
                  : computerAppStateDotClass(row.state)
              }`}
            />
            <span>{overviewStatus(row, machine.name, request, iphone)}</span>
          </span>
        </span>
        {owned ? (
          <span className="computer-apps__control">
            {expanded ? (
              <button
                aria-label={`Close ${row.definition.name} settings`}
                className="btn btn--ghost btn--small"
                onClick={onClose}
                type="button"
              >
                <Icon name="close" />
              </button>
            ) : (
              <OverviewAction
                iphone={iphone}
                local={localApproval !== null}
                machineOnline={machine.status === "online"}
                onCancelRequest={onCancelRequest}
                onManage={onManage}
                onRequest={() => onRequest(row.access ?? "read")}
                onSetup={onSetup}
                pending={pending}
                request={request}
                row={row}
              />
            )}
          </span>
        ) : null}
      </div>

      {!expanded && localApproval === null ? (
        request ? (
          <div className="computer-apps__row-note">
            <span>
              Open Opensteer on {machine.name} to continue.
              {machine.status !== "online" ? " The request will wait until it is online." : ""}
            </span>
            <button className="btn btn--ghost btn--small" onClick={onManage} type="button">
              Manage access
            </button>
          </div>
        ) : row.access !== null && row.state.kind === "permission-required" ? (
          <div className="computer-apps__row-note">
            <span>
              {iphone
                ? (computerAppPermissionNotice({
                    appName: row.definition.name,
                    machineName: machine.name,
                    platform: "ios",
                    state: row.state,
                  })?.detail ?? row.state.detail)
                : `${row.state.detail} ${computerAppSetupElsewhere(machine.name)} ${computerUseSetUpFromSteps(machine.name)}`}
            </span>
          </div>
        ) : null
      ) : null}

      {expanded ? (
        <div className="computer-apps__body">
          {panel === "manage" ? (
            <ManagePanel
              hostClient={hostClient}
              installationId={installationId}
              iphone={iphone}
              localApproval={localApproval}
              machine={machine}
              onClose={onClose}
              onReduce={onReduce}
              onRequest={onRequest}
              onSetup={onSetup}
              onTurnOff={onTurnOff}
              pending={pending}
              request={request}
              row={row}
              workspaces={workspaces}
            />
          ) : panel === "setup" ? (
            <SetupPanel
              approvedChoice={approvedChoice}
              localApproval={localApproval}
              machine={machine}
              onApprove={onApprove}
              onClose={onClose}
              onSetupTarget={onSetupTarget}
              pending={pending}
              request={request}
              row={row}
              target={setupTarget}
            />
          ) : panel === "confirm-off" ? (
            <ConfirmOff
              machineOnline={machine.status === "online"}
              onCancel={onManage}
              onConfirm={onConfirmOff}
              pending={pending}
            />
          ) : null}
          {error ? (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : error ? (
        <div className="computer-apps__body">
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function OverviewAction({
  iphone,
  local,
  machineOnline,
  onCancelRequest,
  onManage,
  onRequest,
  onSetup,
  pending,
  request,
  row,
}: {
  readonly iphone: boolean;
  readonly local: boolean;
  readonly machineOnline: boolean;
  readonly onCancelRequest: () => void;
  readonly onManage: () => void;
  readonly onRequest: () => void;
  readonly onSetup: () => void;
  readonly pending: boolean;
  readonly request: ComputerAppSetupRequest | null;
  readonly row: ComputerAppRow;
}) {
  if (local) {
    const needsSetup = row.access === null || row.state.kind === "permission-required" || request;
    return (
      <button
        className={`btn btn--small${needsSetup ? " btn--primary" : ""}`}
        disabled={pending || (Boolean(needsSetup) && !machineOnline)}
        onClick={needsSetup ? () => onSetup() : onManage}
        type="button"
      >
        {request
          ? request.access !== row.access
            ? "Review request"
            : "Finish setup"
          : row.access === null
            ? "Set up"
            : row.state.kind === "permission-required"
              ? "Finish setup"
              : "Manage"}
      </button>
    );
  }

  if (request) {
    const cancel = (
      <button
        className="btn btn--ghost btn--small"
        disabled={pending}
        onClick={onCancelRequest}
        type="button"
      >
        {iphone ? (pending ? "Declining…" : "Decline") : pending ? "Canceling…" : "Cancel request"}
      </button>
    );
    // Less access needs only this Host, so a request for more never takes it away.
    if (!iphone || row.access === null) return cancel;
    return (
      <>
        {cancel}
        <button className="btn btn--small" onClick={onManage} type="button">
          Manage
        </button>
      </>
    );
  }
  if (iphone && row.access === null) return null;
  // A missing macOS grant is not access: approving the same access again
  // grants nothing, and only that Mac can switch the grant on.
  if (row.access === null) {
    return (
      <button
        className="btn btn--primary btn--small"
        disabled={pending}
        onClick={onRequest}
        type="button"
      >
        {pending ? "Sending…" : "Send setup request"}
      </button>
    );
  }
  return (
    <button className="btn btn--small" onClick={onManage} type="button">
      Manage
    </button>
  );
}

function ManagePanel({
  hostClient,
  installationId,
  iphone,
  localApproval,
  machine,
  onClose,
  onReduce,
  onRequest,
  onSetup,
  onTurnOff,
  pending,
  request,
  row,
  workspaces,
}: {
  readonly hostClient: HostClient;
  readonly installationId: string | null;
  readonly iphone: boolean;
  readonly localApproval: ComputerAppLocalApproval | null;
  readonly machine: MachineSummary;
  readonly onClose: () => void;
  readonly onReduce: () => void;
  readonly onRequest: (access: IntegrationAccess) => void;
  readonly onSetup: (access?: IntegrationAccess) => void;
  readonly onTurnOff: () => void;
  readonly pending: boolean;
  readonly request: ComputerAppSetupRequest | null;
  readonly row: ComputerAppRow;
  readonly workspaces: readonly WorkspaceSummary[];
}) {
  const onlineLocal = localApproval !== null && machine.status === "online";
  const canWrite = row.presentation.accessLevels.length === 2;

  return (
    <div className="computer-apps__panel">
      <div className="computer-apps__setting-row">
        <div>
          <strong>Access</strong>
          {!onlineLocal && localApproval !== null ? (
            <span>Reconnect this Mac to approve more access.</span>
          ) : localApproval === null ? (
            <span>More access needs approval on {machine.name}.</span>
          ) : null}
        </div>
        <span>
          {row.access === null ? "Off" : computerAppAccessLabel(row.presentation, row.access)}
        </span>
      </div>

      <div className="form-actions computer-apps__manage-actions">
        {row.access === "read-write" ? (
          <button className="btn btn--small" disabled={pending} onClick={onReduce} type="button">
            Use {row.presentation.accessLabels.read.toLocaleLowerCase()}
          </button>
        ) : iphone ? null : row.access === "read" && canWrite ? (
          <button
            className="btn btn--small"
            disabled={pending || request !== null || (localApproval !== null && !onlineLocal)}
            onClick={onlineLocal ? () => onSetup("read-write") : () => onRequest("read-write")}
            type="button"
          >
            {onlineLocal
              ? `Allow ${row.presentation.accessLabels.readWrite.toLocaleLowerCase()}`
              : "Request sending access"}
          </button>
        ) : row.access === null && request === null ? (
          <button
            className="btn btn--small"
            disabled={pending || (localApproval !== null && !onlineLocal)}
            onClick={onlineLocal ? () => onSetup("read") : () => onRequest("read")}
            type="button"
          >
            {onlineLocal ? "Set up" : "Send setup request"}
          </button>
        ) : null}
      </div>

      {row.access !== null && row.connectionId ? (
        <ComputerAppWorkspaceAccess
          access={row.access}
          appName={row.definition.name}
          connectionId={row.connectionId}
          disabled={pending}
          hostClient={hostClient}
          installationId={installationId}
          machineName={machine.name}
          presentation={row.presentation}
          workspaces={workspaces}
        />
      ) : (
        <p className="computer-apps__workspace-lead">No Workspaces have access.</p>
      )}

      {iphone ? null : (
        <details className="computer-apps__os-details">
          <summary>macOS permissions</summary>
          <p>{permissionSummary(row, machine.status === "online")}</p>
        </details>
      )}

      <div className="form-actions computer-apps__manage-footer">
        {row.access !== null ? (
          <button
            className="btn btn--ghost btn--small btn--danger"
            disabled={pending}
            onClick={onTurnOff}
            type="button"
          >
            Turn off {row.definition.name}
          </button>
        ) : null}
        <button className="btn btn--small" onClick={onClose} type="button">
          Done
        </button>
      </div>
    </div>
  );
}

function SetupPanel({
  approvedChoice,
  localApproval,
  machine,
  onApprove,
  onClose,
  onSetupTarget,
  pending,
  request,
  row,
  target,
}: {
  readonly approvedChoice: boolean;
  readonly localApproval: ComputerAppLocalApproval | null;
  readonly machine: MachineSummary;
  readonly onApprove: (access: IntegrationAccess) => void;
  readonly onClose: () => void;
  readonly onSetupTarget: (access: IntegrationAccess) => void;
  readonly pending: boolean;
  readonly request: ComputerAppSetupRequest | null;
  readonly row: ComputerAppRow;
  readonly target: IntegrationAccess;
}) {
  if (!localApproval || machine.status !== "online") {
    return (
      <p className="computer-apps__workspace-lead">
        Setup must be completed on {machine.name} while it is online.
      </p>
    );
  }

  // A pending request needs target-computer approval even when its access is
  // already the connection ceiling. OS readiness cannot consume that intent.
  const needsChoice = row.access === null || target !== row.access || request !== null;
  if (needsChoice && !approvedChoice) {
    return (
      <div className="computer-apps__setup-step">
        <span className="computer-apps__step-label">Access</span>
        <h3>What can agents do with {row.definition.name}?</h3>
        <label className="check-item">
          <input
            checked={target === "read"}
            name={`computer-app-level-${row.definition.id}`}
            onChange={() => onSetupTarget("read")}
            type="radio"
          />
          <span className="check-item__meta">
            <span className="check-item__label">{row.presentation.accessLabels.read}</span>
            <span className="check-item__detail">{row.presentation.accessSummaries.read}</span>
          </span>
        </label>
        {row.presentation.accessLevels.length === 2 ? (
          <label className="check-item">
            <input
              checked={target === "read-write"}
              name={`computer-app-level-${row.definition.id}`}
              onChange={() => onSetupTarget("read-write")}
              type="radio"
            />
            <span className="check-item__meta">
              <span className="check-item__label">{row.presentation.accessLabels.readWrite}</span>
              <span className="check-item__detail">
                {row.presentation.accessSummaries.readWrite}
              </span>
            </span>
          </label>
        ) : null}
        <p className="computer-apps__workspace-lead">
          Opensteer and your tasks use this access. Specialists keep their current settings.
        </p>
        <div className="form-actions">
          <button className="btn btn--ghost btn--small" onClick={onClose} type="button">
            Not now
          </button>
          <button
            className="btn btn--primary btn--small"
            disabled={pending}
            onClick={() => onApprove(target)}
            type="button"
          >
            {pending ? "Allowing…" : "Allow and continue"}
          </button>
        </div>
      </div>
    );
  }

  const setup = setupState(row, target);
  if (setup.kind === "permission-required") {
    // Every grant the helper holds is set up by this Mac's setup panel, which
    // shows each step; the page names the app and offers to begin.
    const helperGrant =
      setup.remedy === "full-disk-access" ||
      setup.remedy === "automation" ||
      setup.remedy === "contacts" ||
      setup.remedy === "calendars" ||
      setup.remedy === "reminders";
    return (
      <div className="computer-apps__setup-step">
        <span className="computer-apps__step-label">macOS permission</span>
        <h3>
          {helperGrant
            ? `Allow ${row.definition.name} on this Mac`
            : `Finish ${row.definition.name} setup`}
        </h3>
        {helperGrant ? null : <p className="computer-apps__workspace-lead">{setup.detail}</p>}
        <div className="form-actions">
          <button className="btn btn--ghost btn--small" onClick={onClose} type="button">
            Not now
          </button>
          <button
            className="btn btn--primary btn--small"
            onClick={() =>
              void localApproval.reviewPermission({
                access: target,
                definitionId: row.definition.id,
                remedy: setup.remedy,
              })
            }
            title={
              setup.remedy === "full-disk-access"
                ? `Turns on Full Disk Access for Opensteer Computer Use, which opens protected files on ${machine.name} and reads only ${row.definition.name} for the agents you approve.`
                : undefined
            }
            type="button"
          >
            {helperGrant ? "Set up" : "Review macOS permission"}
          </button>
        </div>
      </div>
    );
  }

  if (setup.kind !== "ready") {
    return (
      <div className="computer-apps__setup-step">
        <h3>{setup.kind === "checking" ? "Checking setup…" : "Setup is unavailable"}</h3>
        <p className="computer-apps__workspace-lead">
          {setup.kind === "checking"
            ? `Waiting for ${machine.name} to report the app’s current status.`
            : setup.kind === "unavailable"
              ? setup.detail
              : `Waiting for ${machine.name} to report the app’s current status.`}
        </p>
        <div className="form-actions">
          <button className="btn btn--small" onClick={onClose} type="button">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="computer-apps__setup-step">
      <h3>{row.definition.name} is ready</h3>
      <p className="computer-apps__workspace-lead">
        Agents can use {computerAppAccessLabel(row.presentation, target).toLocaleLowerCase()} access
        within each Workspace’s setting.
      </p>
      <div className="form-actions">
        <button className="btn btn--primary btn--small" onClick={onClose} type="button">
          Done
        </button>
      </div>
    </div>
  );
}

function ConfirmOff({
  machineOnline,
  onCancel,
  onConfirm,
  pending,
}: {
  readonly machineOnline: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly pending: boolean;
}) {
  return (
    <div className="computer-apps__setup-step">
      <h3>Turn off this app?</h3>
      <p className="computer-apps__consequence">{computerAppTurnOffConsequence}</p>
      <p className="computer-apps__workspace-lead">
        Turning it back on requires approval on this computer. Previous Workspace access is not
        restored.
      </p>
      {!machineOnline ? (
        <p className="computer-apps__workspace-lead">
          New use is blocked now. The computer applies the revocation when it reconnects.
        </p>
      ) : null}
      <div className="form-actions">
        <button className="btn btn--small" onClick={onCancel} type="button">
          Keep on
        </button>
        <button
          className="btn btn--danger btn--small"
          disabled={pending}
          onClick={onConfirm}
          type="button"
        >
          {pending ? "Turning off…" : "Turn off"}
        </button>
      </div>
    </div>
  );
}

function iphoneStatusDotClass(tone: "attention" | "idle" | "on"): string {
  return tone === "on"
    ? "status-dot--running"
    : tone === "attention"
      ? "status-dot--pending"
      : "status-dot--idle";
}

function overviewStatus(
  row: ComputerAppRow,
  machineName: string,
  request: ComputerAppSetupRequest | null,
  iphone: boolean,
): string {
  if (iphone) return iphoneAppStatus({ machineName, request, row }).text;
  if (request) {
    if (row.access === null) return "Off · Setup requested";
    if (row.state.kind === "offline") return "Mac offline · Setup request saved";
    if (request.access === "read-write" && row.access === "read") {
      return "Can read · Sending setup requested";
    }
    return "Setup requested · Waiting for Mac";
  }
  if (row.access === null || row.state.kind === "off") return "Off";
  if (
    row.access === "read-write" &&
    row.readState.kind === "ready" &&
    row.writeState.kind === "permission-required"
  ) {
    return "Can read · Sending needs setup";
  }
  switch (row.state.kind) {
    case "offline":
      return `Unavailable · ${machineName} offline`;
    case "permission-required":
      return row.access === "read-write"
        ? "Setup unfinished for current access"
        : "Setup unfinished";
    case "checking":
      return "Checking setup…";
    case "unavailable":
      return row.state.detail;
    case "ready":
      return computerAppAccessLabel(row.presentation, row.access);
  }
}

function permissionSummary(row: ComputerAppRow, online: boolean): string {
  if (!online) return "Not checked while the computer is offline.";
  return `Reading: ${permissionStateLabel(row.readState)} Sending: ${permissionStateLabel(
    row.writeState,
  )}`;
}

function permissionStateLabel(state: ComputerAppRow["readState"]): string {
  if (state.kind === "ready") return "Ready.";
  if (state.kind === "permission-required") return `${state.detail}.`;
  if (state.kind === "checking") return "Checking…";
  if (state.kind === "offline") return "Not checked.";
  return state.detail;
}

function setupState(row: ComputerAppRow, target: IntegrationAccess): ComputerAppRow["readState"] {
  if (row.readState.kind !== "ready" || target === "read") return row.readState;
  return row.writeState;
}
