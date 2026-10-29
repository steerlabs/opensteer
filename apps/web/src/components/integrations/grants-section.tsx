import { useMemo, useState } from "react";
import type {
  CreateIntegrationGrant,
  IntegrationAccess,
  IntegrationDashboard,
  IntegrationGrant,
  IntegrationPlatformDashboardView,
} from "@opensteer/integration-core";
import type { WorkspaceSummary } from "@opensteer/client/host";
import { accountsForRequirement } from "@opensteer/client/integrations";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { accountOptionLabel } from "./account-identity.js";
import { AgentProposedChip } from "./agent-proposed-chip.js";
import {
  agentProposed,
  definitionOf,
  installationNameText,
  type InstallationEntry,
} from "./helpers.js";
import { IntegrationIcon } from "./integration-icon.js";

export function GrantsSection({
  dashboard,
  grants,
  loading,
  onCreate,
  onRevoke,
  onWorkspace,
  pending,
  platform,
  workspaceId,
  workspaceKind,
  workspaces,
}: {
  readonly dashboard: IntegrationDashboard | null;
  /** The selected Workspace's grants; null until a read for it answers. */
  readonly grants: readonly IntegrationGrant[] | null;
  /** Unknown grants are loading unless their read failed, which the page says. */
  readonly loading: boolean;
  readonly onCreate: (input: CreateIntegrationGrant) => Promise<void>;
  readonly onRevoke: (grantId: string) => void;
  readonly onWorkspace: (workspaceId: string) => void;
  readonly pending: boolean;
  readonly platform: IntegrationPlatformDashboardView | null;
  readonly workspaceId: string | null;
  readonly workspaceKind: "main" | "specialized";
  readonly workspaces: readonly WorkspaceSummary[];
}) {
  const [editing, setEditing] = useState(false);
  const liveGrants = grants?.filter(({ status }) => status === "active") ?? [];
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Workspace access</h2>
        <span className="section__hint">Access is reviewed per Workspace and account.</span>
      </div>
      <label className="field">
        <span className="field__label">Workspace</span>
        <select
          className="select-input"
          onChange={(event) => {
            setEditing(false);
            onWorkspace(event.target.value);
          }}
          value={workspaceId ?? ""}
        >
          {workspaces.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.kind === "main" ? "Main" : candidate.name}
            </option>
          ))}
        </select>
      </label>

      {workspaceKind === "main" ? (
        <div className="notice notice--accent">
          <Icon name="check-circle" />
          <div>
            <strong>Main Workspace access</strong>
            <p>
              Opensteer and your tasks can use all of your connected accounts and installed
              integrations. Specialists need explicit access.
            </p>
          </div>
        </div>
      ) : (
        <>
          {grants === null ? (
            // Access not read yet is not "nothing allowed".
            loading ? (
              <div className="card">
                <LoadingRows label="Loading Workspace access" rows={2} />
              </div>
            ) : null
          ) : (
            <div className="card">
              {liveGrants.length > 0 ? (
                liveGrants.map((grant) => (
                  <GrantRow
                    grant={grant}
                    key={grant.id}
                    onRevoke={onRevoke}
                    pending={pending}
                    platform={platform}
                  />
                ))
              ) : !editing ? (
                <div className="card__empty">
                  Nothing is allowed here yet. Agents can request access from a Thread, or allow an
                  integration directly.
                </div>
              ) : null}
            </div>
          )}
          {editing && workspaceId ? (
            <GrantEditor
              dashboard={dashboard}
              onCancel={() => setEditing(false)}
              onCreate={async (input) => {
                await onCreate(input);
                setEditing(false);
              }}
              pending={pending}
              platform={platform}
              workspaceId={workspaceId}
            />
          ) : (
            <button className="btn" onClick={() => setEditing(true)} type="button">
              <Icon name="plus" /> Allow an integration
            </button>
          )}
        </>
      )}
    </section>
  );
}

function GrantRow({
  grant,
  onRevoke,
  pending,
  platform,
}: {
  readonly grant: IntegrationGrant;
  readonly onRevoke: (grantId: string) => void;
  readonly pending: boolean;
  readonly platform: IntegrationPlatformDashboardView | null;
}) {
  const entry =
    platform?.installations.find(({ installation }) => installation.id === grant.installationId) ??
    null;
  const definition = entry ? definitionOf(entry) : null;
  return (
    <div className="intg-grant">
      <div className="card__row">
        {definition ? (
          <IntegrationIcon icon={definition.icon} id={definition.id} name={definition.name} />
        ) : (
          <span className="card__row-glyph">
            <Icon name="key" />
          </span>
        )}
        <div className="card__row-body">
          <span className="card__row-title">
            {grant.alias}
            {grant.isDefault ? <span className="chip">Default</span> : null}
            <span className="chip">{entry?.installation.title ?? "Integration"}</span>
            {agentProposed(entry) ? <AgentProposedChip /> : null}
          </span>
          <span className="card__row-detail">
            {grant.access === "read" ? "Read only" : "Read and make changes"}
          </span>
        </div>
        <div className="card__row-actions">
          <button
            className="btn btn--danger btn--small"
            disabled={pending}
            onClick={() => onRevoke(grant.id)}
            type="button"
          >
            Revoke
          </button>
        </div>
      </div>
    </div>
  );
}

function GrantEditor({
  dashboard,
  onCancel,
  onCreate,
  pending,
  platform,
  workspaceId,
}: {
  readonly dashboard: IntegrationDashboard | null;
  readonly onCancel: () => void;
  readonly onCreate: (input: CreateIntegrationGrant) => Promise<void>;
  readonly pending: boolean;
  readonly platform: IntegrationPlatformDashboardView | null;
  readonly workspaceId: string;
}) {
  const installations = useMemo(
    () =>
      (platform?.installations ?? []).filter(
        ({ installation }) => installation.status === "active",
      ),
    [platform],
  );
  const [installationId, setInstallationId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [access, setAccess] = useState<IntegrationAccess>("read");
  const [alias, setAlias] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const entry: InstallationEntry | null =
    installations.find(({ installation }) => installation.id === installationId) ?? null;
  const definition = entry ? definitionOf(entry) : null;
  const requirement = entry?.servers.find(
    ({ connectionRequirement }) => connectionRequirement.kind !== "none",
  )?.connectionRequirement ?? { kind: "none" as const };
  // The same reading the Request card uses: a Workspace can never be offered
  // an account the card would not offer for the same requirement.
  const accounts = accountsForRequirement({
    dashboard,
    installationId,
    platform,
    requirement,
  });
  const account = accounts.find(({ id }) => id === connectionId) ?? accounts[0] ?? null;
  // A read-only computer has no tool that makes changes, so "Read and make
  // changes" is not an answer this Workspace could be given.
  const readOnlyCeiling = account?.computer?.access === "read";
  const skillOnly = entry !== null && entry.tools.length === 0 && entry.skills.length > 0;
  const needsAccount = requirement.kind !== "none" && !account;
  const canSubmit = entry !== null && !needsAccount && !pending;

  return (
    <div className="card">
      <div className="card__form">
        <label className="field">
          <span className="field__label">Integration</span>
          <select
            className="select-input"
            onChange={(event) => {
              setInstallationId(event.target.value);
              setConnectionId("");
              setAccess("read");
              setAlias("");
            }}
            value={installationId}
          >
            <option disabled value="">
              Choose an integration
            </option>
            {installations.map((candidate) => (
              <option key={candidate.installation.id} value={candidate.installation.id}>
                {installationNameText(candidate)}
              </option>
            ))}
          </select>
        </label>
        {entry && requirement.kind !== "none" ? (
          accounts.length > 0 ? (
            <label className="field">
              <span className="field__label">Account</span>
              <select
                className="select-input"
                onChange={(event) => setConnectionId(event.target.value)}
                value={account?.id ?? ""}
              >
                {accounts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {accountOptionLabel(candidate, accounts)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="field__hint">
              {requirement.kind === "computer"
                ? `Turn ${definition?.name ?? "this app"} on for a computer first — access is scoped to one computer.`
                : `Connect ${definition?.name ?? "an account"} first — access is scoped to one account.`}
            </p>
          )
        ) : null}
        {entry && !skillOnly ? (
          <label className="field">
            <span className="field__label">Access</span>
            <select
              className="select-input"
              onChange={(event) => setAccess(event.target.value as IntegrationAccess)}
              value={readOnlyCeiling ? "read" : access}
            >
              <option value="read">Read only</option>
              {readOnlyCeiling ? null : <option value="read-write">Read and make changes</option>}
            </select>
            {readOnlyCeiling && account ? (
              <span className="field__hint">
                {`${account.displayName} allows reading only. Change it under Computers.`}
              </span>
            ) : null}
          </label>
        ) : skillOnly ? (
          <p className="field__hint">
            This allows the integration&apos;s skills in this Workspace.
          </p>
        ) : null}
        {entry && !needsAccount ? (
          <>
            <label className="field">
              <span className="field__label">Alias</span>
              <input
                className="text-input"
                maxLength={80}
                onChange={(event) => setAlias(event.target.value)}
                placeholder={account?.displayName ?? entry.installation.title}
                value={alias}
              />
            </label>
            <label className="check-item">
              <input
                checked={isDefault}
                onChange={() => setIsDefault((value) => !value)}
                type="checkbox"
              />
              <span className="check-item__meta">
                <span className="check-item__label">Default account</span>
                <span className="check-item__detail">
                  Used when an agent does not name an account.
                </span>
              </span>
            </label>
          </>
        ) : null}
        <div className="form-actions">
          <button className="btn" disabled={pending} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!canSubmit}
            onClick={() => {
              if (!entry) return;
              void onCreate({
                access: skillOnly || readOnlyCeiling ? "read" : access,
                alias: alias.trim() || account?.displayName || entry.installation.title,
                connectionId: (account?.id ?? null) as CreateIntegrationGrant["connectionId"],
                installationId: entry.installation.id,
                isDefault,
                workspaceId,
              });
            }}
            type="button"
          >
            {pending ? "Allowing…" : skillOnly ? "Allow skills" : "Allow access"}
          </button>
        </div>
      </div>
    </div>
  );
}
