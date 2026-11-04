import { useId, useState } from "react";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import { remoteMcpSlug } from "@opensteer/client/settings";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { Dialog } from "../../dialog.js";
import { Icon } from "../../icon.js";
import { useToast } from "../../toast.js";
import { SettingsError, SettingsSegmented, type SettingsView } from "../primitives.js";

/**
 * Something the catalog doesn't carry: a plugin folder on the computer this
 * Opensteer runs on, or a remote MCP server by its address. Administrators only.
 */
export function AddYourOwn({
  onAdded,
  onClose,
  view,
}: {
  readonly onAdded: () => void;
  readonly onClose: () => void;
  readonly view: SettingsView;
}) {
  const { desktopBridge, hostClient, snapshot } = useShell();
  const toast = useToast();
  const [kind, setKind] = useState<"folder" | "mcp">("folder");
  const [directory, setDirectory] = useState("");
  const [runnerId, setRunnerId] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<readonly string[] | null>(null);
  const fieldId = useId();
  const connected = snapshot.connection === "connected";
  const computers = snapshot.machines.filter(({ computerUse }) => computerUse !== null);
  // The desktop's folder dialog names a folder on the computer running the app,
  // which is the one plugin.install reads only when this Opensteer runs there.
  const picker = view.deployment?.onThisComputer ? desktopBridge : null;
  const ready = kind === "folder" ? directory.trim() !== "" : title.trim() !== "" && url.trim();
  const close = () => {
    if (!pending) onClose();
  };
  const submit = () => {
    if (!ready || pending || !connected) return;
    setPending(true);
    setError(null);
    void (
      kind === "folder"
        ? hostClient
            .dispatch({
              idempotencyKey: mutationIdempotencyKey("plugin-install"),
              input: { directory: directory.trim(), ...(runnerId ? { runnerId } : {}) },
              type: "plugin.install",
            })
            .then((result) => {
              if (result.type !== "plugin.install") throw new Error("Plugin command mismatch.");
              return result.issues.map(
                ({ component, entry, message }) => `${entry ?? component}: ${message}`,
              );
            })
        : hostClient
            .dispatch({
              idempotencyKey: mutationIdempotencyKey("integration-remote-mcp"),
              input: { description: "", name: remoteMcpSlug(title), title: title.trim(), url },
              type: "integration.remoteMcp.install",
            })
            .then(() => [])
    )
      .then((issues) => {
        onAdded();
        toast.success(kind === "folder" ? "Plugin added" : `${title.trim()} added`);
        if (issues.length) setSkipped(issues);
        else onClose();
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  };
  return (
    <Dialog labelledBy="add-your-own-title" onClose={close} title="Add your own">
      {skipped ? (
        <div className="settings-add-sheet">
          <div className="notice notice--warn" role="status">
            <Icon name="alert-circle" />
            <div>
              <strong>
                Added without {skipped.length === 1 ? "one part" : `${skipped.length} parts`}
              </strong>
              <ul className="plugin-install__skipped">
                {skipped.slice(0, 5).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
          <button className="btn btn--primary" onClick={onClose} type="button">
            Done
          </button>
        </div>
      ) : (
        <form
          className="settings-add-sheet"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <SettingsSegmented
            label="What to add"
            onChange={(next) => {
              setKind(next);
              setError(null);
            }}
            options={[
              { value: "folder", label: "Plugin folder" },
              { value: "mcp", label: "MCP server" },
            ]}
            value={kind}
          />
          {kind === "folder" ? (
            <>
              <label className="field" htmlFor={`${fieldId}-folder`}>
                <span className="field__label">Folder on {view.name}</span>
              </label>
              <div className="settings-add-own__folder">
                <input
                  aria-describedby={`${fieldId}-folder-hint`}
                  autoFocus
                  className="text-input settings-add-own__path"
                  id={`${fieldId}-folder`}
                  onChange={(event) => setDirectory(event.currentTarget.value)}
                  placeholder="/Users/you/plugins/name"
                  spellCheck={false}
                  value={directory}
                />
                {picker ? (
                  <button
                    className="btn"
                    disabled={pending}
                    onClick={() =>
                      void picker
                        .pickFolder()
                        .then((picked) => {
                          if (picked) setDirectory(picked.path);
                        })
                        .catch((reason: unknown) => setError(actionErrorMessage(reason)))
                    }
                    type="button"
                  >
                    Choose…
                  </button>
                ) : null}
              </div>
              <p className="field__hint" id={`${fieldId}-folder-hint`}>
                A folder with a <code>plugin.json</code> (Agent Plugins 1.0). Programs it starts run
                only after that computer’s owner approves them.
              </p>
              {computers.length ? (
                <details className="settings-add-sheet__advanced">
                  <summary>
                    <Icon name="chevron-right" />
                    Advanced
                  </summary>
                  <label className="field">
                    <span className="field__label">Its programs run on</span>
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
                </details>
              ) : null}
            </>
          ) : (
            <>
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  autoFocus
                  className="text-input"
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  placeholder="TinyCRM"
                  value={title}
                />
              </label>
              <label className="field">
                <span className="field__label">Address</span>
                <input
                  aria-describedby={`${fieldId}-url-hint`}
                  className="text-input"
                  onChange={(event) => setUrl(event.currentTarget.value)}
                  placeholder="https://mcp.example.com/mcp"
                  spellCheck={false}
                  type="url"
                  value={url}
                />
              </label>
              <p className="field__hint" id={`${fieldId}-url-hint`}>
                A remote MCP server over HTTPS. You sign in to it after adding it; keys never go in
                its address.
              </p>
            </>
          )}
          <SettingsError message={error} />
          <button
            className="btn btn--primary"
            disabled={pending || !ready || !connected}
            type="submit"
          >
            {pending ? "Adding…" : kind === "folder" ? "Add plugin" : "Add MCP server"}
          </button>
        </form>
      )}
    </Dialog>
  );
}
