import { useState } from "react";
import type { InstallRemoteMcp } from "@opensteer/integration-core";
import { Icon } from "../icon.js";

/** Deployment-level installer for Agent Plugins and remote MCP servers. */
export function IntegrationInstaller({
  computers,
  error,
  onAgentPlugin,
  onBack,
  onRemoteMcp,
  pending,
}: {
  /** The Macs whose owners can approve a plugin's servers there. */
  readonly computers: readonly { readonly id: string; readonly name: string }[];
  readonly error: string | null;
  readonly onAgentPlugin: (directory: string, runnerId: string | null) => void;
  readonly onBack: () => void;
  readonly onRemoteMcp: (input: InstallRemoteMcp) => void;
  readonly pending: boolean;
}) {
  const [directory, setDirectory] = useState("");
  const [runnerId, setRunnerId] = useState("");
  const [remote, setRemote] = useState<InstallRemoteMcp>({
    description: "",
    name: "",
    title: "",
    url: "",
  });
  return (
    <>
      <button className="page__back" disabled={pending} onClick={onBack} type="button">
        <Icon name="arrow-left" /> All integrations
      </button>
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Add an integration</h2>
          <span className="section__hint">
            Add a local Agent Plugin package or a remote HTTPS MCP server for this deployment.
          </span>
        </div>
        <div className="card">
          <div className="card__form">
            <div>
              <span className="card__row-title">Agent Plugin directory</span>
              <p className="field__hint">
                Opensteer loads the Agent Plugins v1 package at this absolute Host path. The
                programs it starts, and servers it reaches on loopback, run on the computer you
                choose once that computer&apos;s owner approves them there.
              </p>
            </div>
            <label className="field">
              <span className="field__label">Absolute directory</span>
              <input
                className="text-input"
                onChange={(event) => setDirectory(event.target.value)}
                placeholder="/opt/opensteer/plugins/tinycrm"
                spellCheck={false}
                value={directory}
              />
            </label>
            <label className="field">
              <span className="field__label">Runs on</span>
              <select onChange={(event) => setRunnerId(event.target.value)} value={runnerId}>
                <option value="">The Main computer</option>
                {computers.map((computer) => (
                  <option key={computer.id} value={computer.id}>
                    {computer.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions">
              <button
                className="btn btn--primary"
                disabled={pending || !directory.trim()}
                onClick={() => onAgentPlugin(directory.trim(), runnerId || null)}
                type="button"
              >
                Install Agent Plugin
              </button>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card__form">
            <div>
              <span className="card__row-title">Remote MCP server</span>
              <p className="field__hint">
                Register one deployment-approved Streamable HTTP endpoint. Authentication is
                connected separately and credentials never belong in this form.
              </p>
            </div>
            <label className="field">
              <span className="field__label">Name</span>
              <input
                className="text-input"
                onChange={(event) => setRemote((value) => ({ ...value, name: event.target.value }))}
                placeholder="tinycrm"
                value={remote.name}
              />
            </label>
            <label className="field">
              <span className="field__label">Display name</span>
              <input
                className="text-input"
                onChange={(event) =>
                  setRemote((value) => ({ ...value, title: event.target.value }))
                }
                placeholder="TinyCRM"
                value={remote.title}
              />
            </label>
            <label className="field">
              <span className="field__label">HTTPS MCP URL</span>
              <input
                className="text-input"
                onChange={(event) => setRemote((value) => ({ ...value, url: event.target.value }))}
                placeholder="https://mcp.tinycrm.example/mcp"
                spellCheck={false}
                type="url"
                value={remote.url}
              />
            </label>
            <label className="field">
              <span className="field__label">Description</span>
              <textarea
                className="text-input"
                onChange={(event) =>
                  setRemote((value) => ({ ...value, description: event.target.value }))
                }
                value={remote.description}
              />
            </label>
            <div className="form-actions">
              {error ? (
                <span className="form-actions__error" role="alert">
                  {error}
                </span>
              ) : null}
              <button
                className="btn btn--primary"
                disabled={
                  pending || !remote.name.trim() || !remote.title.trim() || !remote.url.trim()
                }
                onClick={() => onRemoteMcp(remote)}
                type="button"
              >
                Add remote MCP
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
