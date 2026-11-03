import { useEffect, useId, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import {
  canRespondToRequests,
  mutationIdempotencyKey,
  pluginAvailableIn,
  pluginSummaries,
  pluginVersionLabel,
  specialistAccessLevel,
  specialistAccessName,
  specialistModels,
  specialistPendingSummary,
  unwrapRpcResult,
  type HostClient,
  type PluginSummary,
  type SpecialistAccessItem,
  type WorkspaceMemberSummary,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { WorkspaceIdSchema, type SpecialistRegistration } from "@opensteer/core";
import type { IntegrationGrant } from "@opensteer/integration-core";
import { actionErrorMessage } from "../ui-utils.js";
import { useShell } from "./app-shell.js";
import { Dialog } from "./dialog.js";
import { workspaceHealth, WorkspaceIcon } from "./home-view.js";
import { Icon, type IconName } from "./icon.js";
import { LoadingRows } from "./loading-rows.js";
import { PageTopbar } from "./page-header.js";
import { useHostRead } from "./use-host-read.js";
import { WorkspaceNotificationMute } from "./workspace-notification-mute.js";
import { WorkspaceSharingDialog } from "./workspace-sharing-dialog.js";
import { AreaLink, useAreaNavigate } from "./workspace/area-link.js";

/**
 * A Project's settings: who is in it, what it may use beyond its own folder,
 * which plugins run here, and the specialists agents have added. Everything a
 * person changes about a Project, once it exists, is on this one page; its
 * work stays on the Project's own page.
 */
export function ProjectSettingsRoute() {
  const { workspaceId } = useParams();
  const { hostClient, snapshot } = useShell();
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const activeWorkspaceId = workspace?.id ?? null;
  useEffect(() => {
    if (activeWorkspaceId) hostClient.activateWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId, hostClient]);
  if (!workspace || workspace.kind !== "project") return <Navigate replace to="/projects" />;
  return <ProjectSettings key={workspace.id} workspace={workspace} />;
}

function ProjectSettings({ workspace }: { readonly workspace: WorkspaceSummary }) {
  const { hostClient, openMobileNavigation, snapshot } = useShell();
  const userId = snapshot.user?.id ?? null;
  const administrator = snapshot.user?.instanceRole === "administrator";
  const connected = canRespondToRequests(snapshot);
  const members = useHostRead(
    () =>
      hostClient.rpc["workspace.members.list"]({ workspaceId: workspace.id }).then(unwrapRpcResult),
    `members:${workspace.id}`,
  );
  const owner =
    members.data?.members.some(
      (member) => member.userId === userId && member.role === "owner" && member.state === "active",
    ) ?? false;
  const health = workspaceHealth(workspace, snapshot);
  const storageNotice =
    workspace.status !== "ready" || workspace.storageIssue !== null ? health : null;
  const projectPath = `/workspaces/${encodeURIComponent(workspace.id)}`;
  return (
    <div className="page project-settings">
      <PageTopbar onOpenNavigation={openMobileNavigation} title={`${workspace.name} settings`} />
      <div className="page__inner">
        <header className="project-settings__head">
          <AreaLink className="page__back" to={projectPath}>
            <Icon name="arrow-left" />
            {workspace.name}
          </AreaLink>
          <div className="project-settings__identity">
            <WorkspaceIcon workspace={workspace} />
            <div className="project-settings__identity-copy">
              <h1 className="page__title">{workspace.name}</h1>
              <p className="page__description">
                {workspace.machineName
                  ? `Its folder is in Main on ${workspace.machineName}.`
                  : "Its folder is in Main."}{" "}
                {owner
                  ? "You own this project."
                  : members.data
                    ? "An owner of this project decides who joins it and what it can use."
                    : null}
              </p>
            </div>
          </div>
        </header>

        {connected ? null : (
          <p className="notice notice--warn" role="status">
            <Icon name="alert-circle" />
            <span>
              Opensteer can’t be reached right now. This page shows what it last read, and changes
              wait until it’s back.
            </span>
          </p>
        )}
        {storageNotice ? (
          <div className="notice notice--warn project-settings__storage" role="status">
            <Icon name="alert-circle" />
            <div>
              <strong>{storageNotice.heading}</strong>
              <p>{storageNotice.body}</p>
              {storageNotice.detail}
              {storageNotice.action ? (
                <div className="project-settings__storage-action">{storageNotice.action}</div>
              ) : null}
            </div>
          </div>
        ) : null}

        <PeopleSection
          connected={connected}
          members={members.data?.members ?? null}
          membersError={members.error}
          onChanged={members.reload}
          workspace={workspace}
        />
        <AccessSection workspace={workspace} />
        <PluginsSection
          administrator={administrator}
          canChange={connected && (owner || administrator)}
          hostClient={hostClient}
          workspace={workspace}
        />
        <SpecialistsSection connected={connected} hostClient={hostClient} workspace={workspace} />

        {workspace.status === "ready" ? (
          <section aria-labelledby="project-notifications" className="section">
            <div className="section__head">
              <h2 className="section__title" id="project-notifications">
                Notifications
              </h2>
            </div>
            <div className="card">
              <WorkspaceNotificationMute disabled={!connected} workspace={workspace} />
            </div>
          </section>
        ) : null}
        {/* The Host lets only an active owner delete a Project. */}
        {workspace.status === "ready" && owner ? (
          <DeleteProjectSection connected={connected} workspace={workspace} />
        ) : null}
      </div>
    </div>
  );
}

/* ---- People ---- */

function PeopleSection({
  connected,
  members,
  membersError,
  onChanged,
  workspace,
}: {
  readonly connected: boolean;
  readonly members: readonly WorkspaceMemberSummary[] | null;
  readonly membersError: unknown;
  readonly onChanged: () => void;
  readonly workspace: WorkspaceSummary;
}) {
  const { hostClient, snapshot } = useShell();
  const [sharing, setSharing] = useState(false);
  const active = members?.filter((member) => member.state === "active") ?? null;
  const userId = snapshot.user?.id ?? null;
  return (
    <section aria-labelledby="project-people" className="section">
      <div className="section__head">
        <h2 className="section__title" id="project-people">
          People
        </h2>
        {snapshot.workspaceSharingAvailable && snapshot.user ? (
          <button
            className="btn btn--small"
            disabled={!connected}
            onClick={() => setSharing(true)}
            type="button"
          >
            <Icon name="share" /> Share
          </button>
        ) : null}
      </div>
      <p className="section__hint">
        Everyone here can see its files, chat and tasks, and start work in it. Your own accounts and
        computers stay yours unless you allow them below.
      </p>
      <div className="card">
        {active === null ? (
          membersError ? (
            <div className="card__empty" role="alert">
              Couldn’t read who is in this project. {actionErrorMessage(membersError)}
            </div>
          ) : (
            <LoadingRows label="Loading people" rows={2} />
          )
        ) : (
          active.map((member) => (
            <div className="card__row" key={member.id}>
              <span aria-hidden className="card__row-glyph project-settings__avatar">
                {initials(member.displayName)}
              </span>
              <span className="card__row-body">
                <span className="card__row-title">
                  {member.displayName}
                  {member.userId === userId ? <span className="chip">You</span> : null}
                </span>
                <span className="card__row-detail">{member.email}</span>
              </span>
              <span className="card__row-actions project-settings__role">
                {member.role === "owner" ? "Owner" : "Can work"}
              </span>
            </div>
          ))
        )}
      </div>
      {sharing && snapshot.user ? (
        <WorkspaceSharingDialog
          client={hostClient}
          currentUserId={snapshot.user.id}
          onClose={() => {
            setSharing(false);
            onChanged();
          }}
          workspace={workspace}
        />
      ) : null}
    </section>
  );
}

/* ---- Access ---- */

/** Where a person allows one kind of resource for a Project. */
export function accessSettingsPath(
  type: SpecialistAccessItem["type"],
  workspaceId: string,
  service?: string,
): string {
  const workspace = `workspace=${encodeURIComponent(workspaceId)}`;
  switch (type) {
    case "integration":
      return `/settings/apps/tools?${service ? `provider=${encodeURIComponent(service)}&` : ""}${workspace}`;
    case "computer-app":
      return `/settings/apps/tools?${workspace}`;
    case "browser-profile":
      return "/settings/browser-profiles";
    case "phone":
      return "/settings/computers";
  }
}

function AccessSection({ workspace }: { readonly workspace: WorkspaceSummary }) {
  const { hostClient, snapshot } = useShell();
  const grants = useHostRead<readonly IntegrationGrant[]>(
    () =>
      hostClient.rpc["integration.grants.list"]({ workspaceId: workspace.id })
        .then(unwrapRpcResult)
        .then(({ grants }) => grants.filter(({ status }) => status === "active")),
    `grants:${workspace.id}`,
  );
  const profiles = snapshot.browserProfileGrants
    .filter((grant) => grant.workspaceId === workspace.id)
    .map((grant) => ({
      grant,
      name:
        snapshot.browserProfiles.find((profile) => profile.id === grant.profileId)?.name ??
        "Browser profile",
    }));
  const empty = grants.data !== null && grants.data.length === 0 && profiles.length === 0;
  return (
    <section aria-labelledby="project-access" className="section">
      <div className="section__head">
        <h2 className="section__title" id="project-access">
          Access
        </h2>
        <AreaLink className="btn btn--small" to={accessSettingsPath("integration", workspace.id)}>
          Manage access
        </AreaLink>
      </div>
      <p className="section__hint">
        A project works in its own folder and uses only the accounts, apps and browsers allowed
        here. Agents ask from a task when they need more.
      </p>
      <div className="card">
        {grants.data === null ? (
          grants.error ? (
            <div className="card__empty" role="alert">
              Couldn’t read this project’s access.{" "}
              <button className="link-btn" onClick={grants.reload} type="button">
                Try again
              </button>
            </div>
          ) : (
            <LoadingRows label="Loading access" rows={2} />
          )
        ) : empty ? (
          <div className="card__empty">Nothing is allowed yet.</div>
        ) : (
          <>
            {grants.data.map((grant) => (
              <div className="card__row" key={grant.id}>
                <span className="card__row-glyph">
                  <Icon name="key" />
                </span>
                <span className="card__row-body">
                  <span className="card__row-title">
                    {grant.alias}
                    {grant.isDefault ? <span className="chip">Default</span> : null}
                  </span>
                  <span className="card__row-detail">
                    {grant.access === "read" ? "Read only" : "Read and make changes"}
                  </span>
                </span>
              </div>
            ))}
            {profiles.map(({ grant, name }) => (
              <div className="card__row" key={grant.id}>
                <span className="card__row-glyph">
                  <Icon name="browser" />
                </span>
                <span className="card__row-body">
                  <span className="card__row-title">{name}</span>
                  <span className="card__row-detail">
                    Browser profile ·{" "}
                    {grant.access === "read" ? "Read only" : "Can sign in and act"}
                  </span>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/* ---- Plugins ---- */

type PluginsRead = { readonly kind: "listed"; readonly plugins: readonly PluginSummary[] };

function PluginsSection({
  administrator,
  canChange,
  hostClient,
  workspace,
}: {
  readonly administrator: boolean;
  readonly canChange: boolean;
  readonly hostClient: HostClient;
  readonly workspace: WorkspaceSummary;
}) {
  const plugins = useHostRead<PluginsRead>(
    () =>
      hostClient.rpc["plugin.list"]({ workspaceId: WorkspaceIdSchema.parse(workspace.id) }).then(
        (result) => {
          return {
            kind: "listed",
            plugins: pluginSummaries(unwrapRpcResult(result).plugins).filter((plugin) =>
              pluginAvailableIn(plugin, workspace.id),
            ),
          } as const;
        },
      ),
    `plugins:${workspace.id}`,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = (plugin: PluginSummary, active: boolean) => {
    setPending(plugin.id);
    setError(null);
    void hostClient
      .dispatch({
        active,
        idempotencyKey: mutationIdempotencyKey(`plugin-activation:${plugin.id}:${workspace.id}`),
        pluginId: plugin.id,
        type: "plugin.activation.set",
        workspaceId: WorkspaceIdSchema.parse(workspace.id),
      })
      .then(plugins.reload)
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(null));
  };
  const read = plugins.data;
  return (
    <section aria-labelledby="project-plugins" className="section">
      <div className="section__head">
        <h2 className="section__title" id="project-plugins">
          Plugins
        </h2>
        {administrator ? (
          <Link className="btn btn--small btn--ghost" to="/settings/plugins">
            All plugins
          </Link>
        ) : null}
      </div>
      <p className="section__hint">
        Skills and tools agents get in this project. Turning one on here leaves Main and other
        projects as they are.
      </p>
      <div className="card">
        {read === null ? (
          plugins.error ? (
            <div className="card__empty" role="alert">
              Couldn’t read plugins.{" "}
              <button className="link-btn" onClick={plugins.reload} type="button">
                Try again
              </button>
            </div>
          ) : (
            <LoadingRows label="Loading plugins" rows={2} />
          )
        ) : read.plugins.length === 0 ? (
          <div className="card__empty">
            No plugins are installed.
            {administrator ? (
              <>
                {" "}
                <Link to="/settings/plugins">Install one</Link>
              </>
            ) : null}
          </div>
        ) : (
          read.plugins.map((plugin) => {
            const on = plugin.activeIn.includes(workspace.id);
            const busy = pending === plugin.id;
            return (
              <label className="card__row project-plugin" key={plugin.id}>
                <span className="card__row-glyph">
                  <Icon name="puzzle" />
                </span>
                <span className="card__row-body">
                  <span className="card__row-title">
                    {plugin.name}
                    {plugin.specialist ? <span className="chip">Specialist</span> : null}
                    {plugin.scope === "workspace" ? (
                      <span className="chip chip--muted">Added here</span>
                    ) : null}
                  </span>
                  <span className="card__row-detail">
                    {plugin.description ?? pluginVersionLabel(plugin)}
                  </span>
                </span>
                <input
                  aria-disabled={busy || undefined}
                  aria-label={`${plugin.name} on in ${workspace.name}`}
                  checked={on}
                  className="switch"
                  disabled={!canChange}
                  onChange={(event) => {
                    if (!busy) toggle(plugin, event.currentTarget.checked);
                  }}
                  role="switch"
                  type="checkbox"
                />
              </label>
            );
          })
        )}
      </div>
      {error ? (
        <p aria-live="assertive" className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : read?.kind === "listed" && read.plugins.length > 0 && !canChange ? (
        <p className="settings-footnote">
          Only an owner of this project can turn plugins on or off.
        </p>
      ) : null}
    </section>
  );
}

/* ---- Specialists ---- */

function SpecialistsSection({
  connected,
  hostClient,
  workspace,
}: {
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly workspace: WorkspaceSummary;
}) {
  const specialists = useHostRead(
    () =>
      hostClient.rpc["specialist.list"]({ workspaceId: WorkspaceIdSchema.parse(workspace.id) })
        .then(unwrapRpcResult)
        .then(({ specialists }) => specialists),
    `specialists:${workspace.id}`,
  );
  const [updated, setUpdated] = useState<ReadonlyMap<string, SpecialistRegistration>>(new Map());
  useEffect(() => setUpdated(new Map()), [specialists.data]);
  const list = useMemo(
    () => specialists.data?.map((registration) => updated.get(registration.id) ?? registration),
    [specialists.data, updated],
  );
  // Agents add specialists as work calls for them; with none, there is nothing to set here.
  if (list?.length === 0) return null;
  return (
    <section aria-labelledby="project-specialists" className="section">
      <div className="section__head">
        <h2 className="section__title" id="project-specialists">
          Specialists
        </h2>
      </div>
      <p className="section__hint">
        Agents added these to hand parts of their work to. Each runs on its own models and uses only
        the access listed for it.
      </p>
      {list === undefined ? (
        specialists.error ? (
          <div className="card">
            <div className="card__empty" role="alert">
              Couldn’t read this project’s specialists.{" "}
              <button className="link-btn" onClick={specialists.reload} type="button">
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div className="card">
            <LoadingRows label="Loading specialists" rows={2} />
          </div>
        )
      ) : (
        list.map((registration) => (
          <SpecialistCard
            connected={connected}
            hostClient={hostClient}
            key={registration.id}
            onChanged={(next) => setUpdated((current) => new Map(current).set(next.id, next))}
            onRemoved={specialists.reload}
            registration={registration}
            workspace={workspace}
          />
        ))
      )}
    </section>
  );
}

function SpecialistCard({
  connected,
  hostClient,
  onChanged,
  onRemoved,
  registration,
  workspace,
}: {
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly onChanged: (registration: SpecialistRegistration) => void;
  readonly onRemoved: () => void;
  readonly registration: SpecialistRegistration;
  readonly workspace: WorkspaceSummary;
}) {
  const { snapshot } = useShell();
  const mine = registration.ownerUserId === snapshot.user?.id;
  const editable = mine && connected;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);
  const titleId = useId();
  const pendingSummary = specialistPendingSummary(registration);
  const models = specialistModels(registration);
  const bind = (requirement: number, resourceId: string) => {
    setPending(requirement);
    setError(null);
    void hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey(`specialist-bind:${registration.id}:${requirement}`),
        requirement,
        resourceId,
        specialistId: registration.id,
        type: "specialist.bind",
        workspaceId: WorkspaceIdSchema.parse(workspace.id),
      })
      .then((result) => {
        if (result.type === "specialist.bind") onChanged(result.specialist);
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(null));
  };
  return (
    <article aria-labelledby={titleId} className="card specialist">
      <div className="card__row specialist__head">
        <span className="card__row-glyph">
          <Icon name="sparkles" />
        </span>
        <span className="card__row-body">
          <span className="card__row-title" id={titleId}>
            {registration.plugin}
            {registration.status === "ready" ? (
              <span className="chip chip--ok">Ready</span>
            ) : (
              <span className="chip chip--warn">Needs setup</span>
            )}
          </span>
          <span className="card__row-detail">
            {pendingSummary ? `${pendingSummary}. ` : ""}
            Runs on {models.join(", then ")}
            {registration.fallback === "caller" ? ", or the model of the task that asks" : ""}.
          </span>
        </span>
        {mine ? (
          <span className="card__row-actions">
            <button
              className="btn btn--small btn--ghost"
              disabled={!connected}
              onClick={() => setRemoving(true)}
              type="button"
            >
              Remove
            </button>
          </span>
        ) : null}
      </div>
      {registration.access.length > 0 ? (
        <ul aria-label={`What ${registration.plugin} can use`} className="specialist__access">
          {registration.access.map((item, index) => (
            <AccessItemRow
              busy={pending === index}
              editable={editable}
              index={index}
              item={item}
              key={index}
              onBind={bind}
              workspaceId={workspace.id}
            />
          ))}
        </ul>
      ) : (
        <p className="specialist__none">It needs no access beyond this project’s folder.</p>
      )}
      {error ? (
        <p aria-live="assertive" className="notice notice--error specialist__error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      {mine ? null : (
        <p className="specialist__footnote">Another member added this. Only they can change it.</p>
      )}
      {removing ? (
        <RemoveSpecialistDialog
          hostClient={hostClient}
          onClose={() => setRemoving(false)}
          onRemoved={() => {
            setRemoving(false);
            onRemoved();
          }}
          registration={registration}
          workspace={workspace}
        />
      ) : null}
    </article>
  );
}

const accessGlyphs: Readonly<Record<SpecialistAccessItem["type"], IconName>> = {
  "browser-profile": "browser",
  "computer-app": "desktop",
  integration: "key",
  phone: "phone",
};

function AccessItemRow({
  busy,
  editable,
  index,
  item,
  onBind,
  workspaceId,
}: {
  readonly busy: boolean;
  readonly editable: boolean;
  readonly index: number;
  readonly item: SpecialistAccessItem;
  readonly onBind: (requirement: number, resourceId: string) => void;
  readonly workspaceId: string;
}) {
  const [choice, setChoice] = useState(item.candidates[0]?.resourceId ?? "");
  const bound = item.binding
    ? (item.candidates.find(({ resourceId }) => resourceId === item.binding?.resourceId)?.name ??
      null)
    : null;
  const name = specialistAccessName(item);
  return (
    <li className={`specialist-access specialist-access--${item.state}`}>
      <span aria-hidden className="specialist-access__glyph">
        <Icon name={accessGlyphs[item.type]} />
      </span>
      <span className="specialist-access__body">
        <span className="specialist-access__name">
          {name}
          <span className="specialist-access__level">{specialistAccessLevel(item)}</span>
        </span>
        <span className="specialist-access__reason">{item.reason}</span>
      </span>
      <span className="specialist-access__state">
        {item.state === "bound" ? (
          <span className="specialist-access__bound">
            <Icon name="check" />
            {bound ? `Uses ${bound}` : "Allowed"}
          </span>
        ) : item.state === "choose" ? (
          editable ? (
            <span className="specialist-access__choose">
              <select
                aria-label={`Which to use for ${name}`}
                className="select-input"
                disabled={busy}
                onChange={(event) => setChoice(event.currentTarget.value)}
                value={choice}
              >
                {item.candidates.map((candidate) => (
                  <option key={candidate.resourceId} value={candidate.resourceId}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              <button
                className="btn btn--small btn--primary"
                disabled={busy || !choice}
                onClick={() => onBind(index, choice)}
                type="button"
              >
                {busy ? "Saving…" : "Use"}
              </button>
            </span>
          ) : (
            <span className="specialist-access__waiting">Waiting for a choice</span>
          )
        ) : editable ? (
          <AreaLink
            className="btn btn--small"
            to={accessSettingsPath(
              item.type,
              workspaceId,
              item.type === "integration" ? item.service : undefined,
            )}
          >
            Allow access
          </AreaLink>
        ) : (
          <span className="specialist-access__waiting">Not allowed yet</span>
        )}
      </span>
    </li>
  );
}

function RemoveSpecialistDialog({
  hostClient,
  onClose,
  onRemoved,
  registration,
  workspace,
}: {
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
  readonly registration: SpecialistRegistration;
  readonly workspace: WorkspaceSummary;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      labelledBy="remove-specialist-title"
      onClose={() => {
        if (!pending) onClose();
      }}
      title={`Remove ${registration.plugin}?`}
    >
      <p className="section__hint">
        Agents in {workspace.name} stop handing work to it. Its plugin stays installed and on here,
        and work it already did stays in its tasks.
      </p>
      {error ? (
        <p aria-live="assertive" className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="form-actions">
        <button className="btn" disabled={pending} onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="btn btn--danger"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError(null);
            void hostClient
              .dispatch({
                idempotencyKey: mutationIdempotencyKey(`specialist-remove:${registration.id}`),
                specialistId: registration.id,
                type: "specialist.remove",
                workspaceId: WorkspaceIdSchema.parse(workspace.id),
              })
              .then(onRemoved)
              .catch((reason: unknown) => {
                setError(actionErrorMessage(reason));
                setPending(false);
              });
          }}
          type="button"
        >
          {pending ? "Removing…" : "Remove specialist"}
        </button>
      </div>
    </Dialog>
  );
}

/* ---- Delete ---- */

function DeleteProjectSection({
  connected,
  workspace,
}: {
  readonly connected: boolean;
  readonly workspace: WorkspaceSummary;
}) {
  const { hostClient } = useShell();
  const navigate = useAreaNavigate();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="project-delete" className="section">
      <div className="section__head">
        <h2 className="section__title" id="project-delete">
          Delete project
        </h2>
      </div>
      <div className="card">
        <div className="card__row">
          <span className="card__row-body">
            <span className="card__row-detail">
              Its folder, chat and tasks are kept for a while, then removed for good. You can bring
              it back until then.
            </span>
          </span>
          <span className="card__row-actions">
            <button
              className="btn btn--small btn--danger"
              disabled={!connected}
              onClick={() => setConfirming(true)}
              type="button"
            >
              Delete…
            </button>
          </span>
        </div>
      </div>
      {confirming ? (
        <Dialog
          labelledBy="delete-project-title"
          onClose={() => {
            if (!pending) setConfirming(false);
          }}
          title={`Delete ${workspace.name}?`}
        >
          <p className="section__hint">
            Everyone in it loses access now. Its files are kept for the retention window, and an
            owner can keep the project until then.
          </p>
          {error ? (
            <p aria-live="assertive" className="notice notice--error" role="alert">
              <Icon name="alert-circle" />
              <span>{error}</span>
            </p>
          ) : null}
          <div className="form-actions">
            <button
              className="btn"
              disabled={pending}
              onClick={() => setConfirming(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn--danger"
              disabled={pending}
              onClick={() => {
                setPending(true);
                setError(null);
                void hostClient
                  .dispatch({
                    idempotencyKey: mutationIdempotencyKey(`workspace.delete:${workspace.id}`),
                    type: "workspace.delete",
                    workspaceId: workspace.id,
                  })
                  .then(() => navigate("/projects"))
                  .catch((reason: unknown) => {
                    setError(actionErrorMessage(reason));
                    setPending(false);
                  });
              }}
              type="button"
            >
              {pending ? "Deleting…" : "Delete project"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}
