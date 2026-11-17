import { useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  pluginAccessChoices,
  pluginLocalToolAddress,
  pluginLocalToolSource,
  pluginLocalToolStatus,
  pluginLocalToolSummary,
  pluginLocalToolWhere,
  readPluginLocalTool,
  setPluginAccess,
  type PluginLocalToolSummaryView,
  type PluginLocalToolView,
} from "@opensteer/client/plugins";
import { HostClientRequestError } from "@opensteer/client/host";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import {
  SectionHeader,
  SettingsError,
  SettingsRow,
  SettingsSegmented,
} from "../settings/primitives.js";
import { useSettingsRead } from "../settings/use-settings-read.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { deviceRoute } from "../devices/device-routes.js";
import { LocalServerSection } from "./local-server-section.js";
import { localToolPath, pluginsPath } from "./plugins-area.js";

/** Device data apps and local servers, which agents reach beside plugins. */
export function LocalTools({ tools }: { readonly tools: readonly PluginLocalToolSummaryView[] }) {
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">On your devices</h2>
      <div className="card" role="list">
        {tools.map((tool) => {
          const status = pluginLocalToolStatus(tool);
          const where = pluginLocalToolWhere(tool);
          return (
            <Link
              className="card__row plugins-row"
              key={tool.id}
              role="listitem"
              to={localToolPath(tool.id)}
            >
              <span aria-hidden className="plugins-link-row__glyph">
                <Icon name={tool.kind === "device-app" ? "laptop" : "code"} />
              </span>
              <span className="card__row-body">
                <span className="card__row-title">{tool.title}</span>
                <span className="card__row-detail">
                  <span className={`plugins-status plugins-status--${status.tone}`}>
                    {status.label}
                  </span>
                  {where ? <span className="plugins-author"> · {where}</span> : null}
                </span>
              </span>
              <Icon name="chevron-right" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** One local tool: how agents reach it, what it offers, and their access. */
export function LocalToolPage({ id }: { readonly id: string }) {
  const { hostClient } = useShell();
  // Its own read: the installed list counts a local tool's tools, this page lists them.
  const installed = useSettingsRead(() => readPluginLocalTool(hostClient, id), `local-tool:${id}`);
  const gone =
    installed.error instanceof HostClientRequestError && installed.error.code === "not_found";
  const tool = gone ? null : installed.data;
  return (
    <div className="plugins-area plugin-page">
      <Link className="plugins-back" to={pluginsPath}>
        <Icon name="arrow-left" />
        Plugins
      </Link>
      <SettingsError
        message={installed.error && !gone ? actionErrorMessage(installed.error) : null}
      />
      {tool ? (
        <LocalToolContent tool={tool} />
      ) : gone ? (
        <p className="notice" role="status">
          This isn't available to agents anymore. It may have been removed on its device.
        </p>
      ) : installed.error ? (
        <button className="btn" onClick={installed.reload} type="button">
          Try again
        </button>
      ) : (
        <LoadingRows label="Loading" rows={3} />
      )}
    </div>
  );
}

function LocalToolContent({ tool }: { readonly tool: PluginLocalToolView }) {
  const { hostClient } = useShell();
  const navigate = useNavigate();
  const [pending, setPending] = useState<PluginLocalToolView["access"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const access = pending ?? tool.access;
  const source = pluginLocalToolSource(tool);
  return (
    <>
      <SectionHeader
        title={tool.title}
        lead={[
          tool.kind === "device-app" ? "Device data app" : "Local server",
          tool.computer ? `on ${tool.computer.name}` : null,
        ]
          .filter(Boolean)
          .join(" ")}
      />
      {tool.unavailable ? (
        <p className="notice notice--warn" role="status">
          {tool.unavailable}
        </p>
      ) : null}
      <section className="settings-group">
        <h2 className="settings-group__title">Agent access</h2>
        <div className="card plugin-page__access">
          <SettingsSegmented
            disabled={pending !== null}
            label="Agent access"
            onChange={(next) => {
              setPending(next);
              setError(null);
              void setPluginAccess(hostClient, tool.id, next)
                .catch((reason: unknown) => setError(actionErrorMessage(reason)))
                .finally(() => setPending(null));
            }}
            options={pluginAccessChoices}
            value={access}
          />
          <p className="settings-footnote">
            {pluginAccessChoices.find(({ value }) => value === access)!.detail}
          </p>
          <SettingsError message={error} />
        </div>
      </section>
      <section className="settings-group">
        <h2 className="settings-group__title">
          Tools
          {tool.tools.length ? (
            <span className="plugin-page__count">{tool.tools.length}</span>
          ) : null}
        </h2>
        <p className="settings-footnote">
          In a program, agents reach these as <code>{pluginLocalToolAddress(tool)}</code>.
        </p>
        {tool.tools.length ? (
          <div className="card">
            {tool.tools.map((entry) => (
              <SettingsRow
                key={entry.name}
                title={<code className="plugin-page__tool">{entry.name}</code>}
                action={
                  entry.readOnly ? (
                    <span className="chip">Reads</span>
                  ) : (
                    <span className="chip chip--warn">Writes</span>
                  )
                }
              />
            ))}
          </div>
        ) : (
          <p className="settings-footnote">{pluginLocalToolSummary(tool)}</p>
        )}
      </section>
      {tool.computer ? (
        <section className="settings-group">
          <div className="card">
            <Link className="card__row plugins-link-row" to={deviceRoute(tool.computer.id)}>
              <span className="card__row-body">
                <span className="card__row-title">{tool.computer.name}</span>
                <span className="card__row-detail">
                  {tool.kind === "device-app"
                    ? "What this device lets agents read and change"
                    : "Where it runs, and its launch approvals"}
                </span>
              </span>
              <Icon name="chevron-right" />
            </Link>
          </div>
        </section>
      ) : null}
      {source?.kind === "local-server" ? (
        <LocalServerSection
          by={{ serverId: source.serverId }}
          name={tool.title}
          onRemoved={() => void navigate(pluginsPath)}
        />
      ) : null}
    </>
  );
}
