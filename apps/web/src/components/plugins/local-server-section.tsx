import { useId, useState } from "react";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";
import {
  localMcpSecretServers,
  localMcpSecretsToSend,
  setLocalMcpServerSecrets,
  type LocalMcpSecretServer,
} from "@opensteer/client/integrations";
import { localServerRecord } from "@opensteer/client/plugins";
import { fixDeviceDraftText } from "@opensteer/client/settings";
import { actionErrorMessage } from "../../ui-utils.js";
import { useShell } from "../app-shell.js";
import { LocalMcpSecretFields } from "../computer-apps/local-mcp-secret-fields.js";
import { Dialog } from "../dialog.js";
import { SettingsError, SettingsRow } from "../settings/primitives.js";
import { useSettingsRead } from "../settings/use-settings-read.js";
import { useStartTask } from "../start-task.js";

/**
 * A local server's own controls: whether its computer approved it, the secrets
 * that computer's owner entered, a task to fix it, and removing it. Its launch
 * review itself happens on that computer.
 */
export function LocalServerSection({
  by,
  name,
  onRemoved,
}: {
  readonly by: { readonly serverId: string } | { readonly pluginId: string };
  readonly name: string;
  readonly onRemoved: () => void;
}) {
  const { hostClient, snapshot } = useShell();
  const startTask = useStartTask();
  const platform = useSettingsRead(
    () => hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    `local-server:${JSON.stringify(by)}`,
  );
  const secrets = useSettingsRead(() => localMcpSecretServers(hostClient), "local-server-secrets");
  const [changing, setChanging] = useState<LocalMcpSecretServer | null>(null);
  const [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removeTitleId = useId();
  const record = platform.data ? localServerRecord(platform.data, by) : null;
  const secretServer = record
    ? (secrets.data?.find((server) => server.id === record.serverId) ?? null)
    : null;
  const remove = () => {
    if (!record?.pluginId || pending) return;
    setPending(true);
    setError(null);
    void hostClient
      .dispatch({
        type: "plugin.remove",
        pluginId: record.pluginId,
        idempotencyKey: mutationIdempotencyKey("local-server-remove"),
      })
      .then(onRemoved)
      .catch((reason: unknown) => {
        setRemoving(false);
        setError(actionErrorMessage(reason));
      })
      .finally(() => setPending(false));
  };
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Local server</h2>
      <SettingsError
        message={
          platform.error
            ? actionErrorMessage(platform.error)
            : secrets.error
              ? actionErrorMessage(secrets.error)
              : error
        }
      />
      {record ? (
        <div className="card">
          <SettingsRow
            title="On its computer"
            detail={record.state.label}
            action={
              <span
                className={`chip${record.state.tone === "attention" ? " chip--warn" : record.state.tone === "ok" ? " chip--ok" : ""}`}
              >
                {record.state.tone === "ok" ? "Approved" : "Not running"}
              </span>
            }
          />
          {secretServer ? (
            <SettingsRow
              title="Secrets"
              detail={secretServer.secrets.map((secret) => secret.title).join(" · ")}
              action={
                <button
                  className="btn btn--small"
                  disabled={snapshot.connection !== "connected"}
                  onClick={() => {
                    setSaved(false);
                    setChanging(secretServer);
                  }}
                  type="button"
                >
                  Change
                </button>
              }
            />
          ) : null}
          {record.pluginId ? (
            <SettingsRow
              title="Not working?"
              detail="An agent can look into it."
              action={
                <button
                  className="btn btn--small"
                  onClick={() =>
                    startTask(fixDeviceDraftText({ name, pluginId: record.pluginId! }))
                  }
                  type="button"
                >
                  Fix
                </button>
              }
            />
          ) : null}
          {record.pluginId ? (
            <SettingsRow
              title={`Remove ${name}`}
              detail="Agents can no longer use it. What it saved on its computer is deleted."
              action={
                <button
                  className="btn btn--small btn--danger"
                  disabled={pending}
                  onClick={() => setRemoving(true)}
                  type="button"
                >
                  Remove
                </button>
              }
            />
          ) : null}
        </div>
      ) : platform.data ? (
        <p className="settings-footnote">This server isn’t registered here any more.</p>
      ) : null}
      {saved ? <p role="status">Secrets changed</p> : null}
      {changing ? (
        <ChangeSecrets
          server={changing}
          onClose={() => setChanging(null)}
          onSaved={() => {
            setChanging(null);
            setSaved(true);
          }}
        />
      ) : null}
      {removing ? (
        <Dialog
          labelledBy={removeTitleId}
          narrow
          onClose={() => {
            if (!pending) setRemoving(false);
          }}
          title={<span id={removeTitleId}>{`Remove ${name}?`}</span>}
          footer={
            <>
              <button
                className="btn btn--ghost"
                disabled={pending}
                onClick={() => setRemoving(false)}
                type="button"
              >
                Cancel
              </button>
              <button className="btn btn--danger" disabled={pending} onClick={remove} type="button">
                {pending ? "Removing…" : "Remove"}
              </button>
            </>
          }
        >
          <p>
            Agents can no longer use it. What it saved on its computer, such as a pairing, is
            deleted.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
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
  const titleId = useId();
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
      labelledBy={titleId}
      onClose={() => {
        if (!pending) props.onClose();
      }}
      title={<span id={titleId}>{`${props.server.plugin}’s secrets`}</span>}
      footer={
        <>
          <button
            className="btn btn--ghost"
            disabled={pending}
            onClick={props.onClose}
            type="button"
          >
            Cancel
          </button>
          <button className="btn btn--primary" disabled={pending} onClick={save} type="button">
            {pending ? "Saving…" : "Save"}
          </button>
        </>
      }
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
      <SettingsError message={error} />
    </Dialog>
  );
}
