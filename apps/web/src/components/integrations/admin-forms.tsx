import { useState } from "react";
import { Link } from "react-router";
import type { InstallRemoteMcp } from "@opensteer/integration-core";
import { Icon } from "../icon.js";

/**
 * Deployment-level installer for a remote MCP server. Plugins install from
 * Settings → Plugins, which owns everything else about them.
 */
export function IntegrationInstaller({
  error,
  onBack,
  onRemoteMcp,
  pending,
}: {
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onRemoteMcp: (input: InstallRemoteMcp) => void;
  readonly pending: boolean;
}) {
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
          <h2 className="section__title">Add an MCP server</h2>
          <span className="section__hint">
            Register a remote HTTPS MCP server for this deployment. Plugins install from{" "}
            <Link to="/settings/plugins">Settings › Plugins</Link>.
          </span>
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
