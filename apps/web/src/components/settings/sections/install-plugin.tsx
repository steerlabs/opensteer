import { useId, useState } from "react";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { useToast } from "../../toast.js";
import { Icon } from "../../icon.js";
export function InstallPlugin({
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
