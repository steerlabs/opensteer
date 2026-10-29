import type {
  ComputerAppPresentationView,
  IntegrationAccess,
  IntegrationGrant,
} from "@opensteer/integration-core";
import {
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { useCallback, useEffect, useRef, useState } from "react";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";

type WorkspaceAccessLevel = "off" | IntegrationAccess;

interface GrantView {
  readonly client: HostClient;
  readonly connectionId: string;
  readonly error: string | null;
  readonly grants: ReadonlyMap<string, readonly IntegrationGrant[]> | null;
  readonly installationId: string | null;
  readonly loading: boolean;
  readonly workspaceKey: string;
}

interface BusyMutation {
  readonly client: HostClient;
  readonly connectionId: string;
  readonly installationId: string | null;
  readonly workspaceId: string;
  readonly workspaceKey: string;
}

export interface ComputerAppWorkspaceAccessProps {
  /** The computer connection's maximum access. */
  readonly access: IntegrationAccess;
  readonly appName: string;
  readonly connectionId: string;
  /** Prevents grant changes while the app connection itself is changing. */
  readonly disabled?: boolean;
  readonly hostClient: HostClient;
  readonly installationId: string | null;
  readonly machineName: string;
  readonly presentation: ComputerAppPresentationView;
  readonly workspaces: readonly WorkspaceSummary[];
}

/**
 * Edits the explicit Workspace grants for one app on one computer.
 *
 * A grant keeps its own stored access when the computer connection's ceiling
 * changes. The selected value is the authority agents have now: the lesser of
 * that stored grant and the connection ceiling. Raising the ceiling therefore
 * never upgrades an existing read grant without another explicit selection.
 */
export function ComputerAppWorkspaceAccess({
  access,
  appName,
  connectionId,
  disabled = false,
  hostClient,
  installationId,
  machineName,
  presentation,
  workspaces,
}: ComputerAppWorkspaceAccessProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<GrantView | null>(null);
  const [busyMutation, setBusyMutation] = useState<BusyMutation | null>(null);
  const loadGeneration = useRef(0);
  const mutationGeneration = useRef(0);
  const main = workspaces.find((workspace) => workspace.kind === "main") ?? null;
  const specialized = workspaces.filter((workspace) => workspace.kind !== "main");
  const workspaceKey = specialized.map(({ id }) => id).join(",");

  const load = useCallback(
    async (
      options: { readonly clearOnFailure?: boolean; readonly retainedError?: string } = {},
    ) => {
      const generation = ++loadGeneration.current;
      const workspaceIds = workspaceKey === "" ? [] : workspaceKey.split(",");
      const scope = { client: hostClient, connectionId, installationId, workspaceKey } as const;
      setView((previous) => ({
        ...scope,
        error: options.retainedError ?? null,
        grants: grantViewMatches(previous, scope) ? previous.grants : null,
        loading: true,
      }));
      try {
        const loaded = await Promise.all(
          workspaceIds.map(async (workspaceId) =>
            hostClient.rpc["integration.grants.list"]({ workspaceId })
              .then(unwrapRpcResult)
              .then(({ grants }) => [workspaceId, grants] as const),
          ),
        );
        if (generation !== loadGeneration.current) return;
        setView({
          ...scope,
          error: options.retainedError ?? null,
          grants: new Map(loaded),
          loading: false,
        });
      } catch (reason) {
        if (generation === loadGeneration.current) {
          setView((previous) => ({
            ...scope,
            error: options.retainedError ?? actionErrorMessage(reason),
            grants:
              !options.clearOnFailure && grantViewMatches(previous, scope) ? previous.grants : null,
            loading: false,
          }));
        }
        throw reason;
      }
    },
    [connectionId, hostClient, installationId, workspaceKey],
  );

  // Only a different authority scope invalidates work already in flight. A
  // disclosure opening or closing is presentation state and must not orphan a
  // save that still belongs to this connection.
  useEffect(() => {
    loadGeneration.current += 1;
    mutationGeneration.current += 1;
    setBusyMutation(null);
    return () => {
      loadGeneration.current += 1;
      mutationGeneration.current += 1;
    };
  }, [connectionId, hostClient, installationId, workspaceKey]);

  useEffect(() => {
    if (open) void load().catch(() => undefined);
  }, [load, open]);

  const scope = { client: hostClient, connectionId, installationId, workspaceKey } as const;
  const currentView = grantViewMatches(view, scope) ? view : null;
  const grants = currentView?.grants ?? null;
  const busy = busyMutationMatches(busyMutation, scope) ? busyMutation.workspaceId : null;
  const connectionLabel = accessLabel(presentation, access);
  const writeAllowed = access === "read-write" && presentation.accessLevels.length === 2;

  async function setWorkspaceAccess(
    workspace: WorkspaceSummary,
    next: WorkspaceAccessLevel,
  ): Promise<void> {
    if (disabled || busy !== null || installationId === null || grants === null) return;
    const existing = activeGrantFor(grants, workspace.id, connectionId);
    const current = existing === null ? "off" : effectiveGrantAccess(existing.access, access);
    if (next === current) return;
    if (next === "read-write" && !writeAllowed) return;

    const generation = ++mutationGeneration.current;
    setBusyMutation({
      client: hostClient,
      connectionId,
      installationId,
      workspaceId: workspace.id,
      workspaceKey,
    });
    let failure: string | undefined;
    try {
      if (next === "off") {
        if (existing === null) return;
        const result = await hostClient.dispatch({
          grantId: existing.id,
          idempotencyKey: mutationIdempotencyKey(`computer-app-grant:${existing.id}`),
          type: "integration.grant.revoke",
          workspaceId: workspace.id,
        });
        if (result.type !== "integration.grant.revoke") {
          throw new Error("Workspace access did not change.");
        }
      } else {
        const result = await hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey(`computer-app-grant:${workspace.id}`),
          input: {
            access: next,
            alias: existing?.alias ?? `${appName} on ${machineName}`.slice(0, 80),
            connectionId,
            installationId,
            isDefault:
              existing?.isDefault ??
              !(grants.get(workspace.id) ?? []).some(
                (grant) => grant.status === "active" && grant.installationId === installationId,
              ),
            workspaceId: workspace.id,
          },
          type: "integration.grant.create",
        });
        if (result.type !== "integration.grant.create") {
          throw new Error("Workspace access did not change.");
        }
      }
    } catch (reason) {
      failure = actionErrorMessage(reason);
    }

    if (generation !== mutationGeneration.current) return;
    try {
      // Creation is an upsert and revocation targets the exact grant id. A
      // fresh list is authoritative even when the mutation response was lost.
      await load(
        failure === undefined
          ? { clearOnFailure: true }
          : { clearOnFailure: true, retainedError: failure },
      );
    } catch {
      // `load` recorded the error and withheld a state it could not verify.
    } finally {
      if (generation === mutationGeneration.current) setBusyMutation(null);
    }
  }

  return (
    <div className="computer-apps__workspaces">
      <button
        aria-expanded={open}
        className="btn btn--ghost btn--small computer-apps__disclosure"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span>Workspace access</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} />
      </button>
      {open ? (
        <div className="computer-apps__workspace-list">
          <p className="computer-apps__workspace-lead">
            This app allows up to {connectionLabel.toLocaleLowerCase()} on {machineName}. Each
            Workspace can use less.
          </p>
          {main ? (
            <label className="check-item">
              <span className="check-item__meta">
                <span className="check-item__label">{main.name}</span>
                <span className="check-item__detail">
                  Automatically uses {connectionLabel.toLocaleLowerCase()} from the app setting
                  above.
                </span>
              </span>
              <select
                aria-label={`${main.name} workspace access`}
                className="select-input"
                disabled
                value={access}
              >
                {accessOptions(presentation, writeAllowed).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {specialized.length === 0 ? (
            <p className="computer-apps__workspace-lead">There are no specialists to configure.</p>
          ) : currentView?.loading && grants === null ? (
            <p className="computer-apps__workspace-lead">Loading Workspace access…</p>
          ) : grants === null ? (
            <p className="computer-apps__workspace-lead">Workspace access could not be loaded.</p>
          ) : (
            specialized.map((workspace) => {
              const grant = activeGrantFor(grants, workspace.id, connectionId);
              const effective: WorkspaceAccessLevel = grant
                ? effectiveGrantAccess(grant.access, access)
                : "off";
              return (
                <label className="check-item" key={workspace.id}>
                  <span className="check-item__meta">
                    <span className="check-item__label">{workspace.name}</span>
                    <span className="check-item__detail">
                      {grant === null
                        ? "This specialist cannot use this app."
                        : grantDetail({
                            access,
                            effective: effectiveGrantAccess(grant.access, access),
                            grant,
                            machineName,
                            presentation,
                          })}
                    </span>
                  </span>
                  <select
                    aria-label={`${workspace.name} workspace access`}
                    className="select-input"
                    disabled={
                      disabled ||
                      busy !== null ||
                      installationId === null ||
                      (currentView?.loading ?? false)
                    }
                    onChange={(event) => {
                      void setWorkspaceAccess(
                        workspace,
                        event.currentTarget.value as WorkspaceAccessLevel,
                      );
                    }}
                    value={effective}
                  >
                    {accessOptions(presentation, writeAllowed).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })
          )}
          {currentView?.error ? (
            <div className="notice notice--error" role="alert">
              <span>{currentView.error}</span>{" "}
              <button
                className="btn btn--ghost btn--small"
                disabled={currentView.loading || disabled}
                onClick={() => void load().catch(() => undefined)}
                type="button"
              >
                Retry
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function accessOptions(
  presentation: ComputerAppPresentationView,
  writeAllowed: boolean,
): readonly { readonly label: string; readonly value: WorkspaceAccessLevel }[] {
  return [
    { label: "Off", value: "off" },
    { label: presentation.accessLabels.read, value: "read" },
    ...(writeAllowed
      ? [{ label: presentation.accessLabels.readWrite, value: "read-write" as const }]
      : []),
  ];
}

function accessLabel(presentation: ComputerAppPresentationView, access: IntegrationAccess): string {
  return access === "read-write"
    ? presentation.accessLabels.readWrite
    : presentation.accessLabels.read;
}

function effectiveGrantAccess(
  stored: IntegrationAccess,
  connection: IntegrationAccess,
): IntegrationAccess {
  return stored === "read-write" && connection === "read-write" ? "read-write" : "read";
}

function grantDetail(input: {
  readonly access: IntegrationAccess;
  readonly effective: IntegrationAccess;
  readonly grant: IntegrationGrant;
  readonly machineName: string;
  readonly presentation: ComputerAppPresentationView;
}): string {
  const effectiveLabel = accessLabel(input.presentation, input.effective);
  if (input.grant.access !== input.effective && input.access === "read") {
    return `${accessLabel(input.presentation, input.grant.access)} is allowed for this Workspace, but the app currently limits access to ${effectiveLabel.toLocaleLowerCase()}.`;
  }
  return `${effectiveLabel} through ${input.machineName}.`;
}

function activeGrantFor(
  grants: ReadonlyMap<string, readonly IntegrationGrant[]>,
  workspaceId: string,
  connectionId: string,
): IntegrationGrant | null {
  return (
    (grants.get(workspaceId) ?? []).find(
      (grant) => grant.status === "active" && grant.connectionId === connectionId,
    ) ?? null
  );
}

function grantViewMatches(
  view: GrantView | null,
  scope: Pick<GrantView, "client" | "connectionId" | "installationId" | "workspaceKey">,
): view is GrantView {
  return (
    view !== null &&
    view.client === scope.client &&
    view.connectionId === scope.connectionId &&
    view.installationId === scope.installationId &&
    view.workspaceKey === scope.workspaceKey
  );
}

function busyMutationMatches(
  busy: BusyMutation | null,
  scope: Pick<GrantView, "client" | "connectionId" | "installationId" | "workspaceKey">,
): busy is BusyMutation {
  return (
    busy !== null &&
    busy.client === scope.client &&
    busy.connectionId === scope.connectionId &&
    busy.installationId === scope.installationId &&
    busy.workspaceKey === scope.workspaceKey
  );
}
