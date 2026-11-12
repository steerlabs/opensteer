import type {
  ComputerAppPresentationView,
  IntegrationAccess,
  IntegrationGrant,
} from "@opensteer/integration-core";
import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { useCallback, useEffect, useRef, useState } from "react";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";

type AgentAccessLevel = "off" | IntegrationAccess;

interface GrantView {
  readonly client: HostClient;
  readonly connectionId: string;
  readonly error: string | null;
  readonly grants: readonly IntegrationGrant[] | null;
  readonly installationId: string | null;
  readonly loading: boolean;
}

type Scope = Pick<GrantView, "client" | "connectionId" | "installationId">;

export interface ComputerAppAgentAccessProps {
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
}

/**
 * Edits what the person's agent may do with one app on one computer: the
 * explicit grant for that computer connection.
 *
 * A grant keeps its own stored access when the computer connection's ceiling
 * changes. The selected value is the authority agents have now: the lesser of
 * that stored grant and the connection ceiling. Raising the ceiling therefore
 * never upgrades an existing read grant without another explicit selection.
 */
export function ComputerAppAgentAccess({
  access,
  appName,
  connectionId,
  disabled = false,
  hostClient,
  installationId,
  machineName,
  presentation,
}: ComputerAppAgentAccessProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<GrantView | null>(null);
  const [busyScope, setBusyScope] = useState<Scope | null>(null);
  const loadGeneration = useRef(0);
  const mutationGeneration = useRef(0);

  const load = useCallback(
    async (
      options: { readonly clearOnFailure?: boolean; readonly retainedError?: string } = {},
    ) => {
      const generation = ++loadGeneration.current;
      const scope = { client: hostClient, connectionId, installationId } as const;
      setView((previous) => ({
        ...scope,
        error: options.retainedError ?? null,
        grants: sameScope(previous, scope) ? previous.grants : null,
        loading: true,
      }));
      try {
        const { grants } = unwrapRpcResult(await hostClient.rpc["integration.grants.list"]({}));
        if (generation !== loadGeneration.current) return;
        setView({ ...scope, error: options.retainedError ?? null, grants, loading: false });
      } catch (reason) {
        if (generation === loadGeneration.current) {
          setView((previous) => ({
            ...scope,
            error: options.retainedError ?? actionErrorMessage(reason),
            grants: !options.clearOnFailure && sameScope(previous, scope) ? previous.grants : null,
            loading: false,
          }));
        }
        throw reason;
      }
    },
    [connectionId, hostClient, installationId],
  );

  // Only a different authority scope invalidates work already in flight. A
  // disclosure opening or closing is presentation state and must not orphan a
  // save that still belongs to this connection.
  useEffect(() => {
    loadGeneration.current += 1;
    mutationGeneration.current += 1;
    setBusyScope(null);
    return () => {
      loadGeneration.current += 1;
      mutationGeneration.current += 1;
    };
  }, [connectionId, hostClient, installationId]);

  useEffect(() => {
    if (open) void load().catch(() => undefined);
  }, [load, open]);

  const scope = { client: hostClient, connectionId, installationId } as const;
  const currentView = sameScope(view, scope) ? view : null;
  const grants = currentView?.grants ?? null;
  const busy = sameScope(busyScope, scope);
  const connectionLabel = accessLabel(presentation, access);
  const writeAllowed = access === "read-write" && presentation.accessLevels.length === 2;
  const grant = grants === null ? null : activeGrantFor(grants, connectionId);
  const effective: AgentAccessLevel = grant ? effectiveGrantAccess(grant.access, access) : "off";

  async function setAgentAccess(next: AgentAccessLevel): Promise<void> {
    if (disabled || busy || installationId === null || grants === null) return;
    if (next === effective) return;
    if (next === "read-write" && !writeAllowed) return;

    const generation = ++mutationGeneration.current;
    setBusyScope(scope);
    let failure: string | undefined;
    try {
      if (next === "off") {
        if (grant === null) return;
        const result = await hostClient.dispatch({
          grantId: grant.id,
          idempotencyKey: mutationIdempotencyKey(`computer-app-grant:${grant.id}`),
          type: "integration.grant.revoke",
        });
        if (result.type !== "integration.grant.revoke") {
          throw new Error("Agent access did not change.");
        }
      } else {
        const result = await hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey(`computer-app-grant:${connectionId}`),
          input: {
            access: next,
            alias: grant?.alias ?? `${appName} on ${machineName}`.slice(0, 80),
            connectionId,
            installationId,
            isDefault:
              grant?.isDefault ??
              !grants.some(
                (candidate) =>
                  candidate.status === "active" && candidate.installationId === installationId,
              ),
          },
          type: "integration.grant.create",
        });
        if (result.type !== "integration.grant.create") {
          throw new Error("Agent access did not change.");
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
      if (generation === mutationGeneration.current) setBusyScope(null);
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
        <span>Agent access</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} />
      </button>
      {open ? (
        <div className="computer-apps__workspace-list">
          {currentView?.loading && grants === null ? (
            <p className="computer-apps__workspace-lead">Loading agent access…</p>
          ) : grants === null ? (
            <p className="computer-apps__workspace-lead">Agent access could not be loaded.</p>
          ) : (
            <label className="check-item">
              <span className="check-item__meta">
                <span className="check-item__label">Your agent</span>
                <span className="check-item__detail">
                  {grant === null
                    ? `This app allows up to ${connectionLabel.toLocaleLowerCase()} on ${machineName}. Your agent can’t use it yet.`
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
                aria-label={`Agent access to ${appName}`}
                className="select-input"
                disabled={
                  disabled || busy || installationId === null || (currentView?.loading ?? false)
                }
                onChange={(event) => {
                  void setAgentAccess(event.currentTarget.value as AgentAccessLevel);
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
): readonly { readonly label: string; readonly value: AgentAccessLevel }[] {
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
    return `${accessLabel(input.presentation, input.grant.access)} is allowed for your agent, but the app currently limits access to ${effectiveLabel.toLocaleLowerCase()}.`;
  }
  return `${effectiveLabel} through ${input.machineName}.`;
}

function activeGrantFor(
  grants: readonly IntegrationGrant[],
  connectionId: string,
): IntegrationGrant | null {
  return (
    grants.find((grant) => grant.status === "active" && grant.connectionId === connectionId) ?? null
  );
}

function sameScope<Value extends Scope>(value: Value | null, scope: Scope): value is Value {
  return (
    value !== null &&
    value.client === scope.client &&
    value.connectionId === scope.connectionId &&
    value.installationId === scope.installationId
  );
}
