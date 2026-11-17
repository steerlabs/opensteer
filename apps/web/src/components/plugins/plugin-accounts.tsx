import { useId, useState } from "react";
import { Link } from "react-router";
import {
  pluginAccountRemoval,
  pluginEngineRefusal,
  readPluginAccounts,
  removePluginAccount,
  type PluginAccountRow,
} from "@opensteer/client/plugins";
import { actionErrorMessage } from "../../ui-utils.js";
import { useShell } from "../app-shell.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { IntegrationIcon } from "../integration-icon.js";
import { LoadingRows } from "../loading-rows.js";
import { SectionHeader, SettingsError } from "../settings/primitives.js";
import { useSettingsRead } from "../settings/use-settings-read.js";
import { EngineNotice, pluginPath, pluginsPath, usePluginEngine } from "./plugins-area.js";

/**
 * Every saved account, whichever plugins use it, so one can be removed even
 * after the last plugin that used it is gone.
 */
export function PluginAccounts() {
  const { hostClient } = useShell();
  const accounts = useSettingsRead(() => readPluginAccounts(hostClient), "plugin-accounts");
  const refused = accounts.data ? null : pluginEngineRefusal(accounts.error);
  const engine = usePluginEngine(refused);
  const [removing, setRemoving] = useState<PluginAccountRow | null>(null);
  return (
    <div className="plugins-area">
      <Link className="plugins-back" to={pluginsPath}>
        <Icon name="arrow-left" />
        Plugins
      </Link>
      <SectionHeader
        title="Connected accounts"
        lead="Sign-ins and keys saved on this computer for your plugins. Unlinking one from a plugin keeps it here; removing it here takes it away from every plugin."
      />
      <EngineNotice engine={accounts.data ? null : engine} />
      <SettingsError
        message={accounts.error && !refused ? actionErrorMessage(accounts.error) : null}
      />
      {accounts.data ? (
        accounts.data.length === 0 ? (
          <p className="settings-footnote">
            No saved accounts. Connecting an account to a plugin saves it here.
          </p>
        ) : (
          <div className="card" role="list">
            {accounts.data.map((row) => (
              <div className="card__row plugin-account" key={row.account.id} role="listitem">
                <IntegrationIcon id={row.account.provider} name={row.providerName} />
                <span className="card__row-body">
                  <span className="card__row-title">{row.account.label || row.account.id}</span>
                  <span className="card__row-detail">
                    {row.providerName} ·{" "}
                    {row.links.length ? (
                      <>
                        Used by{" "}
                        {row.links.map(({ pluginId, pluginName }, index) => (
                          <span key={pluginId}>
                            {index ? ", " : null}
                            <Link to={pluginPath(pluginId)}>{pluginName}</Link>
                          </span>
                        ))}
                      </>
                    ) : (
                      "Not used by any plugin"
                    )}
                  </span>
                </span>
                <button
                  aria-label={`Remove ${row.account.label || row.account.id}`}
                  className="btn btn--small btn--ghost"
                  onClick={() => setRemoving(row)}
                  type="button"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )
      ) : accounts.error ? (
        <button className="btn" onClick={accounts.reload} type="button">
          Try again
        </button>
      ) : (
        <LoadingRows label="Loading accounts" rows={3} />
      )}
      {removing ? (
        <RemoveAccount
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            accounts.reload();
          }}
          row={removing}
        />
      ) : null}
    </div>
  );
}

function RemoveAccount({
  onClose,
  onRemoved,
  row,
}: {
  readonly onClose: () => void;
  readonly onRemoved: () => void;
  readonly row: PluginAccountRow;
}) {
  const { hostClient } = useShell();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const text = pluginAccountRemoval(row);
  return (
    <Dialog
      labelledBy={titleId}
      narrow
      onClose={onClose}
      title={<span id={titleId}>{text.title}</span>}
      footer={
        <>
          <button className="btn btn--ghost" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--danger"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(null);
              void removePluginAccount(hostClient, row.account.id)
                .then(onRemoved)
                .catch((reason: unknown) => setError(actionErrorMessage(reason)))
                .finally(() => setPending(false));
            }}
            type="button"
          >
            {pending ? "Removing…" : text.confirm}
          </button>
        </>
      }
    >
      <p>{text.message}</p>
      <SettingsError message={error} />
    </Dialog>
  );
}
