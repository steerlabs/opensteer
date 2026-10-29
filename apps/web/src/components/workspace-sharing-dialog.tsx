import { useCallback, useEffect, useState } from "react";
import {
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type WorkspaceInvitationSummary,
  type WorkspaceMemberSummary,
  type WorkspaceSharingSnapshot,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { Dialog } from "./dialog.js";
import { Icon } from "./icon.js";

const emptySharing: WorkspaceSharingSnapshot = { invitations: [], members: [] };

export function WorkspaceSharingDialog({
  client,
  currentUserId,
  onClose,
  workspace,
}: {
  client: HostClient;
  currentUserId: string;
  onClose: () => void;
  workspace: WorkspaceSummary;
}) {
  const [sharing, setSharing] = useState<WorkspaceSharingSnapshot>(emptySharing);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"collaborator" | "owner">("collaborator");
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const next = await loadWorkspaceSharing(client, workspace.id);
    setSharing(next);
  }, [client, workspace.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadWorkspaceSharing(client, workspace.id)
      .then((next) => {
        if (!cancelled) setSharing(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspace.id]);

  const currentMembership = sharing.members.find((member) => member.userId === currentUserId);
  const canManage = currentMembership?.role === "owner";

  async function run(key: string, action: () => Promise<void>) {
    setError(null);
    setPending(key);
    try {
      await action();
      await reload();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(null);
    }
  }

  async function createInvite() {
    await run("invite", async () => {
      const result = await client.dispatch({
        idempotencyKey: mutationIdempotencyKey(`workspace-invitation:${workspace.id}`),
        role,
        type: "workspace.invitation.create",
        workspaceId: workspace.id,
      });
      if (result.type !== "workspace.invitation.create") {
        throw new Error("Workspace invitation command mismatch.");
      }
      setInvitationUrl(result.invitationUrl);
      await navigator.clipboard?.writeText(result.invitationUrl).catch(() => undefined);
    });
  }

  return (
    <Dialog
      labelledBy="share-workspace-heading"
      onClose={onClose}
      title={`Share ${workspace.name}`}
    >
      <p className="section__hint">
        Sharing gives someone this entire specialist: its files, Threads, history, and future agent
        work. Personal browser profiles, credentials, and local computers stay private unless their
        owner grants them separately.
      </p>

      {canManage ? (
        <section aria-labelledby="create-invite-heading" className="section">
          <h3 className="section__title" id="create-invite-heading">
            Invite someone
          </h3>
          <div className="copy-row">
            <select
              aria-label="Invitation role"
              className="select-input"
              disabled={pending !== null}
              onChange={(event) => setRole(event.currentTarget.value as "collaborator" | "owner")}
              value={role}
            >
              <option value="collaborator">Can work</option>
              <option value="owner">Owner</option>
            </select>
            <button
              className="btn btn--primary"
              disabled={pending !== null}
              onClick={() => void createInvite()}
              type="button"
            >
              {pending === "invite" ? "Creating…" : "Copy invite link"}
            </button>
          </div>
          {invitationUrl ? (
            <label className="field">
              <span className="field__label">Invite link copied</span>
              <input
                className="text-input"
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                value={invitationUrl}
              />
            </label>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="workspace-people-heading" className="section">
        <h3 className="section__title" id="workspace-people-heading">
          People
        </h3>
        {loading ? <p className="section__hint">Loading people…</p> : null}
        <div className="card">
          {sharing.members.map((member) => (
            <MemberRow
              canManage={Boolean(canManage)}
              currentUserId={currentUserId}
              key={member.id}
              member={member}
              pending={pending}
              onChangeRole={(nextRole) =>
                run(`member:${member.userId}`, () =>
                  client
                    .dispatch({
                      idempotencyKey: mutationIdempotencyKey(`workspace-member:${member.userId}`),
                      role: nextRole,
                      type: "workspace.member.update",
                      userId: member.userId,
                      workspaceId: workspace.id,
                    })
                    .then(() => undefined),
                )
              }
              onRemove={() =>
                run(`member:${member.userId}`, () =>
                  client
                    .dispatch({
                      idempotencyKey: mutationIdempotencyKey(`workspace-member:${member.userId}`),
                      state: "revoked",
                      type: "workspace.member.update",
                      userId: member.userId,
                      workspaceId: workspace.id,
                    })
                    .then(() => undefined),
                )
              }
            />
          ))}
        </div>
      </section>

      {canManage && sharing.invitations.length > 0 ? (
        <section aria-labelledby="pending-invites-heading" className="section">
          <h3 className="section__title" id="pending-invites-heading">
            Pending links
          </h3>
          <div className="card">
            {sharing.invitations.map((invitation) => (
              <InvitationRow
                invitation={invitation}
                key={invitation.id}
                onRevoke={() =>
                  run(`invite:${invitation.id}`, () =>
                    client
                      .dispatch({
                        idempotencyKey: mutationIdempotencyKey(
                          `workspace-invitation:${invitation.id}`,
                        ),
                        invitationId: invitation.id,
                        type: "workspace.invitation.revoke",
                        workspaceId: workspace.id,
                      })
                      .then(() => undefined),
                  )
                }
                pending={pending === `invite:${invitation.id}`}
              />
            ))}
          </div>
        </section>
      ) : null}
      {error ? (
        <p aria-live="assertive" className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
    </Dialog>
  );
}

async function loadWorkspaceSharing(
  client: HostClient,
  workspaceId: string,
): Promise<WorkspaceSharingSnapshot> {
  const [members, invitations] = await Promise.all([
    client.rpc["workspace.members.list"]({ workspaceId }).then(unwrapRpcResult),
    client.rpc["workspace.invitations.list"]({ workspaceId }).then(unwrapRpcResult),
  ]);
  return { invitations: invitations.invitations, members: members.members };
}

function MemberRow({
  canManage,
  currentUserId,
  member,
  onChangeRole,
  onRemove,
  pending,
}: {
  canManage: boolean;
  currentUserId: string;
  member: WorkspaceMemberSummary;
  onChangeRole: (role: "collaborator" | "owner") => Promise<void>;
  onRemove: () => Promise<void>;
  pending: string | null;
}) {
  const isCurrent = member.userId === currentUserId;
  const disabled = pending !== null;
  return (
    <div className="card__row">
      <span aria-hidden="true" className="sidebar__avatar">
        {initials(member.displayName)}
      </span>
      <span className="card__row-body">
        <strong>
          {member.displayName}
          {isCurrent ? " (you)" : ""}
        </strong>
        <small>{member.email}</small>
      </span>
      {canManage && !isCurrent ? (
        <>
          <select
            className="select-input"
            aria-label={`Role for ${member.displayName}`}
            disabled={disabled}
            onChange={(event) =>
              void onChangeRole(event.currentTarget.value as "collaborator" | "owner")
            }
            value={member.role}
          >
            <option value="collaborator">Can work</option>
            <option value="owner">Owner</option>
          </select>
          <button
            className="btn btn--ghost btn--small btn--danger"
            disabled={disabled}
            onClick={() => void onRemove()}
            type="button"
          >
            Remove
          </button>
        </>
      ) : (
        <span className="chip">{member.role}</span>
      )}
    </div>
  );
}

function InvitationRow({
  invitation,
  onRevoke,
  pending,
}: {
  invitation: WorkspaceInvitationSummary;
  onRevoke: () => Promise<void>;
  pending: boolean;
}) {
  return (
    <div className="card__row">
      <span className="card__row-body">
        <strong>{invitation.role === "owner" ? "Owner link" : "Can-work link"}</strong>
        <small>
          Expires{" "}
          {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
            new Date(invitation.expiresAt),
          )}
        </small>
      </span>
      <button
        className="btn btn--ghost btn--small btn--danger"
        disabled={pending}
        onClick={() => void onRevoke()}
        type="button"
      >
        {pending ? "Revoking…" : "Revoke"}
      </button>
    </div>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "OS"
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Sharing could not be updated.";
}
