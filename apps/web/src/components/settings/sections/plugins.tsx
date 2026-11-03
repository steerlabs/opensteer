import { useId, useState } from "react";
import {
  canRespondToRequests,
  mutationIdempotencyKey,
  pluginAvailableIn,
  pluginContents,
  pluginSummaries,
  pluginVersionLabel,
  unwrapRpcResult,
  type PluginSummary,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { WorkspaceIdSchema } from "@opensteer/core";
import {
  localMcpSecretServers,
  localMcpSecretsToSend,
  setLocalMcpServerSecrets,
  type LocalMcpSecretServer,
} from "@opensteer/client/integrations";
import { LocalMcpSecretFields } from "../../computer-apps/local-mcp-secret-fields.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { Dialog } from "../../dialog.js";
import { Icon } from "../../icon.js";
import { LoadingRows } from "../../loading-rows.js";
import { useToast } from "../../toast.js";
import { useHostRead } from "@opensteer/client/react";
import { WorkspaceOrb } from "../../workspace-orb.js";
import { SectionHeader, SettingsError, type SettingsView } from "../primitives.js";

/**
 * Settings → Plugins. A plugin is a folder of skills, tools and sometimes a
 * specialist. An administrator installs it once for this Opensteer; it does
 * nothing until it is turned on in Main or a project, which is a separate
 * choice from what that project may access.
 */
export function PluginsSection({ view }: { readonly view: SettingsView }) {
  const { hostClient, snapshot } = useShell();
  const connected = canRespondToRequests(snapshot);
  const plugins = useHostRead(
    view.administrator
      ? () =>
          hostClient.rpc["plugin.list"]({})
            .then(unwrapRpcResult)
            .then(({ plugins }) => pluginSummaries(plugins))
      : null,
    "plugins",
  );
  return (
    <>
      <SectionHeader
        lead={`Skills, tools and specialists for your agents, packaged as folders on ${view.name}. Install one here, then turn it on where it’s needed.`}
        title="Plugins"
      />
      {view.administrator ? (
        <>
          <InstallPlugin connected={connected} onInstalled={plugins.reload} />
          <section aria-labelledby="plugins-installed" className="settings-group">
            <h2 className="settings-group__title" id="plugins-installed">
              Installed
            </h2>
            <div className="card">
              {plugins.data === null ? (
                plugins.error ? (
                  <div className="card__empty" role="alert">
                    Couldn’t read plugins. {actionErrorMessage(plugins.error)}{" "}
                    <button className="link-btn" onClick={plugins.reload} type="button">
                      Try again
                    </button>
                  </div>
                ) : (
                  <LoadingRows label="Loading plugins" rows={2} />
                )
              ) : plugins.data.length === 0 ? (
                <div className="card__empty">
                  Nothing installed yet. Agents can also add plugins inside their own project.
                </div>
              ) : (
                plugins.data.map((plugin) => (
                  <PluginRow
                    connected={connected}
                    key={plugin.id}
                    onChanged={plugins.reload}
                    plugin={plugin}
                    workspaces={snapshot.workspaces}
                  />
                ))
              )}
            </div>
          </section>
        </>
      ) : (
        <div className="card">
          <div className="card__row">
            <span className="card__row-glyph">
              <Icon name="shield" />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">An administrator manages plugins</span>
              <span className="card__row-detail card__row-detail--wrap">
                Ask whoever runs {view.name} to install one. An owner can turn installed plugins on
                in their project from its settings.
              </span>
            </span>
          </div>
        </div>
      )}
      <YourSecrets connected={connected} />
    </>
  );
}

/**
 * Whoever owns the computer a plugin's server runs on entered its secrets
 * there, and changes them here, whether or not they manage plugins.
 */
function YourSecrets({ connected }: { readonly connected: boolean }) {
  const { hostClient } = useShell();
  const toast = useToast();
  const servers = useHostRead(() => localMcpSecretServers(hostClient), "plugin-secrets");
  const [changing, setChanging] = useState<LocalMcpSecretServer | null>(null);
  if (!servers.data?.length) return null;
  return (
    <section aria-labelledby="plugins-secrets" className="settings-group">
      <h2 className="settings-group__title" id="plugins-secrets">
        Secrets on your computers
      </h2>
      <div className="card">
        {servers.data.map((server) => (
          <div className="card__row" key={server.id}>
            <span className="card__row-glyph">
              <Icon name="shield" />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">{server.plugin}</span>
              <span className="card__row-detail">
                {[server.name, server.computer, server.secrets.map(({ title }) => title).join(", ")]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <span className="card__row-actions">
              <button
                className="btn btn--small btn--ghost"
                disabled={!connected}
                onClick={() => setChanging(server)}
                type="button"
              >
                Change
              </button>
            </span>
          </div>
        ))}
      </div>
      {changing ? (
        <ChangeSecrets
          onClose={() => setChanging(null)}
          onSaved={() => {
            setChanging(null);
            toast.success(`${changing.plugin}’s secrets changed`);
          }}
          server={changing}
        />
      ) : null}
    </section>
  );
}

function InstallPlugin({
  connected,
  onInstalled,
}: {
  readonly connected: boolean;
  readonly onInstalled: () => void;
}) {
  const { hostClient, snapshot } = useShell();
  const toast = useToast();
  const [directory, setDirectory] = useState("");
  const [runnerId, setRunnerId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const computers = snapshot.machines.filter(({ computerUse }) => computerUse !== null);
  const folderId = useId();
  const install = () => {
    setPending(true);
    setError(null);
    setSkipped([]);
    void hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey("plugin-install"),
        input: { directory: directory.trim(), ...(runnerId ? { runnerId } : {}) },
        type: "plugin.install",
      })
      .then((result) => {
        if (result.type !== "plugin.install") throw new Error("Plugin command mismatch.");
        setSkipped(
          result.issues.map(({ component, entry, message }) => `${entry ?? component}: ${message}`),
        );
        setDirectory("");
        toast.success("Plugin installed");
        onInstalled();
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  };
  return (
    <section aria-labelledby="plugins-install" className="settings-group">
      <h2 className="settings-group__title" id="plugins-install">
        Install from a folder
      </h2>
      <form
        className="card card__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (directory.trim() && !pending && connected) install();
        }}
      >
        <div className="plugin-install">
          <label className="field plugin-install__folder">
            <span className="field__label" id={folderId}>
              Folder
            </span>
            <input
              aria-describedby={`${folderId}-hint`}
              className="text-input"
              onChange={(event) => setDirectory(event.currentTarget.value)}
              placeholder="/Users/you/plugins/tinycrm"
              spellCheck={false}
              value={directory}
            />
          </label>
          {computers.length > 0 ? (
            <label className="field plugin-install__runs-on">
              <span className="field__label">Programs run on</span>
              <select
                className="select-input"
                onChange={(event) => setRunnerId(event.currentTarget.value)}
                value={runnerId}
              >
                <option value="">The Main computer</option>
                {computers.map((computer) => (
                  <option key={computer.id} value={computer.id}>
                    {computer.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <p className="field__hint" id={`${folderId}-hint`}>
          The full path to a plugin package on the computer Opensteer runs on. Programs it starts
          run only after that computer’s owner approves them.
        </p>
        <div className="form-actions">
          {error ? (
            <span className="form-actions__error" role="alert">
              {error}
            </span>
          ) : null}
          <button
            className="btn btn--primary"
            disabled={pending || !directory.trim() || !connected}
            type="submit"
          >
            {pending ? "Installing…" : "Install plugin"}
          </button>
        </div>
      </form>
      {skipped.length > 0 ? (
        <div className="notice notice--warn" role="status">
          <Icon name="alert-circle" />
          <div>
            <strong>
              Installed without {skipped.length === 1 ? "one part" : `${skipped.length} parts`}
            </strong>
            <ul className="plugin-install__skipped">
              {skipped.slice(0, 5).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PluginRow({
  connected,
  onChanged,
  plugin,
  workspaces,
}: {
  readonly connected: boolean;
  readonly onChanged: () => void;
  readonly plugin: PluginSummary;
  readonly workspaces: readonly WorkspaceSummary[];
}) {
  const { hostClient } = useShell();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const places = workspaces.filter(
    (workspace) => workspace.status !== "deleted" && pluginAvailableIn(plugin, workspace.id),
  );
  const onIn = places.filter((workspace) => plugin.activeIn.includes(workspace.id));
  const owner = plugin.workspaceId
    ? workspaces.find((workspace) => workspace.id === plugin.workspaceId)
    : null;
  const listId = useId();
  const run = (key: string, action: () => Promise<unknown>, done?: string) => {
    setPending(key);
    setError(null);
    void action()
      .then(() => {
        if (done) toast.success(done);
        onChanged();
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(null));
  };
  const contents = pluginContents(plugin);
  return (
    <div className="plugin-row">
      <div className="card__row">
        <span className="card__row-glyph">
          <Icon name="puzzle" />
        </span>
        <span className="card__row-body">
          <span className="card__row-title">
            {plugin.name}
            {plugin.specialist ? <span className="chip">Specialist</span> : null}
          </span>
          <span className="card__row-detail">
            {[
              pluginVersionLabel(plugin),
              contents,
              owner ? `Added by an agent in ${owner.name}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {plugin.description ? (
            <span className="card__row-detail card__row-detail--wrap">{plugin.description}</span>
          ) : null}
        </span>
        <span className="card__row-actions">
          <button
            className="btn btn--small btn--ghost"
            disabled={!connected || !plugin.directory || pending !== null}
            onClick={() =>
              run(
                "update",
                () =>
                  hostClient.dispatch({
                    idempotencyKey: mutationIdempotencyKey(`plugin-update:${plugin.id}`),
                    input: { directory: plugin.directory! },
                    pluginId: plugin.id,
                    type: "plugin.update",
                  }),
                `${plugin.name} updated`,
              )
            }
            title={
              plugin.directory
                ? `Read ${plugin.directory} again`
                : "Its folder is unknown; install it again from its folder"
            }
            type="button"
          >
            {pending === "update" ? "Updating…" : "Update"}
          </button>
          <button
            className="btn btn--small btn--ghost"
            disabled={!connected || pending !== null}
            onClick={() => setRemoving(true)}
            type="button"
          >
            Remove
          </button>
        </span>
      </div>
      <button
        aria-controls={listId}
        aria-expanded={open}
        className="plugin-row__where"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} />
        {onIn.length === 0
          ? "Off everywhere"
          : `On in ${onIn
              .slice(0, 3)
              .map(workspaceName)
              .join(", ")}${onIn.length > 3 ? ` and ${onIn.length - 3} more` : ""}`}
        {/* Cut from its start, so the folder's own name stays in view. */}
        {plugin.directory ? (
          <span className="plugin-row__source">
            <bdi>{plugin.directory}</bdi>
          </span>
        ) : null}
      </button>
      {open ? (
        <ul aria-label={`Where ${plugin.name} is on`} className="plugin-row__places" id={listId}>
          {places.map((workspace) => {
            const on = plugin.activeIn.includes(workspace.id);
            const key = `activation:${workspace.id}`;
            return (
              <li key={workspace.id}>
                <label className="plugin-row__place">
                  <WorkspaceOrb
                    color={workspace.color}
                    icon={workspace.icon}
                    name={workspaceName(workspace)}
                    size="tiny"
                  />
                  <span className="plugin-row__place-name">{workspaceName(workspace)}</span>
                  <input
                    aria-disabled={pending === key || undefined}
                    aria-label={`${plugin.name} on in ${workspaceName(workspace)}`}
                    checked={on}
                    className="switch"
                    disabled={!connected || workspace.status !== "ready"}
                    onChange={(event) => {
                      if (pending !== null) return;
                      const active = event.currentTarget.checked;
                      run(key, () =>
                        hostClient.dispatch({
                          active,
                          idempotencyKey: mutationIdempotencyKey(
                            `plugin-activation:${plugin.id}:${workspace.id}`,
                          ),
                          pluginId: plugin.id,
                          type: "plugin.activation.set",
                          workspaceId: WorkspaceIdSchema.parse(workspace.id),
                        }),
                      );
                    }}
                    role="switch"
                    type="checkbox"
                  />
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? (
        <div className="plugin-row__error">
          <SettingsError message={error} />
        </div>
      ) : null}
      {removing ? (
        <Dialog
          labelledBy="remove-plugin-title"
          onClose={() => {
            if (pending === null) setRemoving(false);
          }}
          title={`Remove ${plugin.name}?`}
        >
          <p className="section__hint">
            {onIn.length > 0 ? `It turns off in ${onIn.map(workspaceName).join(", ")}. ` : ""}
            Its skills and tools leave every agent, and any specialist made from it is removed. The
            folder on disk stays where it is.
          </p>
          <div className="form-actions">
            <button
              className="btn"
              disabled={pending !== null}
              onClick={() => setRemoving(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn--danger"
              disabled={pending !== null}
              onClick={() =>
                run(
                  "remove",
                  () =>
                    hostClient
                      .dispatch({
                        idempotencyKey: mutationIdempotencyKey(`plugin-remove:${plugin.id}`),
                        pluginId: plugin.id,
                        type: "plugin.remove",
                      })
                      .then(() => setRemoving(false)),
                  `${plugin.name} removed`,
                )
              }
              type="button"
            >
              {pending === "remove" ? "Removing…" : "Remove plugin"}
            </button>
          </div>
          {error ? <SettingsError message={error} /> : null}
        </Dialog>
      ) : null}
    </div>
  );
}

function workspaceName(workspace: Pick<WorkspaceSummary, "kind" | "name">): string {
  return workspace.kind === "main" ? "Main" : workspace.name;
}

/** New values for the secrets a server's computer's owner entered when approving it. */
function ChangeSecrets(props: {
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly server: LocalMcpSecretServer;
}) {
  const { hostClient } = useShell();
  const fields = props.server.secrets.map((secret) => ({ ...secret, saved: true }));
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const entered = localMcpSecretsToSend(fields, values);
    if (!entered.ok || Object.keys(entered.secrets).length === 0) {
      setError(entered.ok ? "Enter a new value to change." : entered.message);
      return;
    }
    setPending(true);
    setError(null);
    void setLocalMcpServerSecrets(hostClient, props.server.id, entered.secrets)
      .then(props.onSaved)
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  };
  return (
    <Dialog
      labelledBy="plugin-secrets-title"
      onClose={() => {
        if (!pending) props.onClose();
      }}
      title={`${props.server.plugin}’s secrets`}
    >
      <p className="section__hint">
        Enter only what changed. {props.server.name} restarts with the new values.
      </p>
      <LocalMcpSecretFields
        disabled={pending}
        fields={fields}
        onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
        values={values}
      />
      <div className="form-actions">
        <button className="btn" disabled={pending} onClick={props.onClose} type="button">
          Cancel
        </button>
        <button className="btn btn--primary" disabled={pending} onClick={save} type="button">
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? <SettingsError message={error} /> : null}
    </Dialog>
  );
}
