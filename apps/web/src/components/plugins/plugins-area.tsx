import { useDeferredValue, useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  installPlugin,
  pluginCatalogInstalled,
  pluginCatalogReader,
  pluginEngineNotice,
  pluginEngineRefusal,
  pluginInstalledGroups,
  pluginStatusView,
  readInstalledPlugins,
  type PluginCatalogEntryView,
  type PluginEngineStateView,
  type PluginSummaryView,
} from "@opensteer/client/plugins";
import { usePagedList, usePluginEngine as usePluginEngineState } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { IntegrationIcon } from "../integrations/integration-icon.js";
import { LoadingRows } from "../loading-rows.js";
import { SectionHeader, SettingsError, SettingsSegmented } from "../settings/primitives.js";
import { useSettingsRead } from "../settings/use-settings-read.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { PluginPage } from "./plugin-page.js";

export const pluginsPath = "/settings/plugins";
export const pluginPath = (pluginId: string) =>
  `${pluginsPath}/installed/${encodeURIComponent(pluginId)}`;

/** The plugin engine's state for this Host. */
export function usePluginEngine(initial: PluginEngineStateView | null) {
  return usePluginEngineState(useShell().hostClient, initial);
}

export function EngineNotice({ engine }: { readonly engine: PluginEngineStateView | null }) {
  const notice = pluginEngineNotice(engine);
  if (!notice) return null;
  return (
    <p
      className={`notice ${notice.tone === "error" ? "notice--error" : "notice--accent plugin-engine-notice"}`}
      role="status"
    >
      {notice.tone === "progress" ? <span aria-hidden className="plugin-engine-notice__dot" /> : null}
      {notice.text}
    </p>
  );
}

/**
 * Settings → Plugins. Opening it is one read of the installed list; the
 * catalog loads only when opened, and a plugin's page only when chosen.
 */
export function PluginsArea({ legacy }: { readonly legacy: React.ReactNode }) {
  const { pathname } = useLocation();
  const suffix = pathname.slice(pluginsPath.length).split("/").filter(Boolean);
  if (suffix[0] === "catalog" || suffix[0] === "add") return <PluginCatalog />;
  if (suffix[0] === "installed" && suffix[1])
    return <PluginPage key={suffix[1]} pluginId={decodeURIComponent(suffix[1])} />;
  if (suffix.length) return legacy;
  return <InstalledPlugins />;
}

function InstalledPlugins() {
  const { hostClient } = useShell();
  const installed = useSettingsRead(() => readInstalledPlugins(hostClient), "plugins-installed", true);
  const refused = installed.data ? null : pluginEngineRefusal(installed.error);
  const engine = usePluginEngine(installed.data?.engine ?? refused);
  const [installing, setInstalling] = useState(false);
  const plugins = installed.data?.plugins ?? null;
  return (
    <div className="plugins-area">
      <SectionHeader
        title="Plugins"
        lead="Tools your agents can use with your accounts, running on this computer."
        action={
          <Link className="btn btn--primary btn--small" to={`${pluginsPath}/catalog`}>
            <Icon name="plus" />
            Add
          </Link>
        }
      />
      <EngineNotice engine={engine} />
      <SettingsError
        message={installed.error && !installed.data && !refused ? actionErrorMessage(installed.error) : null}
      />
      {installed.error && !installed.data ? (
        <button className="btn plugins-retry" onClick={installed.reload} type="button">
          Try again
        </button>
      ) : !plugins ? (
        <LoadingRows label="Loading plugins" rows={3} />
      ) : plugins.length === 0 ? (
        <div className="plugins-empty">
          <span aria-hidden className="plugins-empty__glyph">
            <Icon name="puzzle" />
          </span>
          <p className="plugins-empty__title">No plugins yet</p>
          <p className="plugins-empty__detail">
            Add one from the catalog, or ask your agent to build one for you.
          </p>
          <Link className="btn btn--primary" to={`${pluginsPath}/catalog`}>
            Browse the catalog
          </Link>
        </div>
      ) : (
        pluginInstalledGroups(plugins).map((group) => (
          <section className="settings-group" key={group.id}>
            <h2 className="settings-group__title">{group.title}</h2>
            <div
              className={`card${group.id === "attention" ? " settings-plugin-attention" : ""}`}
              role="list"
            >
              {group.plugins.map((plugin) => (
                <InstalledRow key={plugin.id} plugin={plugin} />
              ))}
            </div>
          </section>
        ))
      )}
      <section className="settings-group">
        <h2 className="settings-group__title">Add more</h2>
        <div className="card">
          <Link className="card__row plugins-link-row" to={`${pluginsPath}/catalog`}>
            <span aria-hidden className="plugins-link-row__glyph">
              <Icon name="search" />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">Browse the catalog</span>
              <span className="card__row-detail">Hundreds of services, ready to connect</span>
            </span>
            <Icon name="chevron-right" />
          </Link>
          <button
            className="card__row plugins-link-row"
            onClick={() => setInstalling(true)}
            type="button"
          >
            <span aria-hidden className="plugins-link-row__glyph">
              <Icon name="link" />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">Install from an address</span>
              <span className="card__row-detail">An MCP server, OpenAPI document or GraphQL API</span>
            </span>
            <Icon name="chevron-right" />
          </button>
          <Link className="card__row plugins-link-row" to={`${pluginsPath}/local`}>
            <span aria-hidden className="plugins-link-row__glyph">
              <Icon name="laptop" />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">Device apps, local servers and skills</span>
              <span className="card__row-detail">What runs on your computers and phones</span>
            </span>
            <Icon name="chevron-right" />
          </Link>
        </div>
      </section>
      {installing ? <InstallFromAddress onClose={() => setInstalling(false)} /> : null}
    </div>
  );
}

function InstalledRow({ plugin }: { readonly plugin: PluginSummaryView }) {
  const status = pluginStatusView(plugin);
  return (
    <Link className="card__row plugins-row" role="listitem" to={pluginPath(plugin.id)}>
      <IntegrationIcon icon={plugin.icon ?? undefined} id={plugin.slug} name={plugin.name} />
      <span className="card__row-body">
        <span className="card__row-title">{plugin.name}</span>
        <span className="card__row-detail">
          <span className={`plugins-status plugins-status--${status.tone}`}>{status.label}</span>
          {plugin.author === "agent" ? <span className="plugins-author"> · Written by an agent</span> : null}
        </span>
      </span>
      {plugin.status !== "ready" ? (
        <span className="btn btn--small">{plugin.status === "not-built" ? "Fix" : "Connect"}</span>
      ) : (
        <Icon name="chevron-right" />
      )}
    </Link>
  );
}

function PluginCatalog() {
  const { hostClient } = useShell();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim());
  const installed = useSettingsRead(() => readInstalledPlugins(hostClient), "plugins-installed", true);
  const engine = usePluginEngine(installed.data?.engine ?? null);
  const list = usePagedList(pluginCatalogReader(hostClient, search), `catalog:${search}`);
  const [adding, setAdding] = useState<PluginCatalogEntryView | null>(null);
  return (
    <div className="plugins-area">
      <Link className="plugins-back" to={pluginsPath}>
        <Icon name="arrow-left" />
        Plugins
      </Link>
      <SectionHeader title="Plugin catalog" lead="Plugins reviewed for the catalog. Each runs sandboxed until you connect an account." />
      <label className="settings-plugin-search">
        <Icon name="search" />
        <input
          aria-label="Search the catalog"
          autoFocus
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search the catalog"
          type="search"
          value={query}
        />
      </label>
      <EngineNotice engine={list.loading ? engine : null} />
      <SettingsError message={list.error ? actionErrorMessage(list.error) : null} />
      {list.loading ? (
        <LoadingRows label="Loading the catalog" rows={4} />
      ) : list.items.length === 0 && !list.error ? (
        <p className="settings-catalog__empty">
          {search ? `Nothing in the catalog matches “${search}”.` : "The catalog is empty."}
        </p>
      ) : (
        <div className="card plugins-catalog" role="list">
          {list.items.map((entry) => {
            const already = pluginCatalogInstalled(entry, installed.data?.plugins ?? []);
            return (
              <div className="card__row plugins-catalog__row" key={entry.id} role="listitem">
                <IntegrationIcon icon={entry.icon ?? undefined} id={entry.id} name={entry.name} />
                <span className="card__row-body">
                  <span className="card__row-title">{entry.name}</span>
                  <span className="card__row-detail plugins-catalog__description">
                    {entry.description}
                  </span>
                </span>
                {already ? (
                  <span className="chip chip--ok">Installed</span>
                ) : (
                  <button
                    aria-label={`Install ${entry.name}`}
                    className="btn btn--small"
                    onClick={() => setAdding(entry)}
                    type="button"
                  >
                    Install
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {list.nextCursor ? (
        <button className="btn plugins-more" disabled={list.loadingMore} onClick={list.more} type="button">
          {list.loadingMore ? "Loading…" : "Show more"}
        </button>
      ) : null}
      {list.error && list.items.length ? (
        <button className="btn" onClick={list.reload} type="button">
          Start the list again
        </button>
      ) : null}
      {adding ? (
        <InstallCatalogEntry
          entry={adding}
          onClose={() => setAdding(null)}
          onInstalled={(pluginId) => navigate(pluginPath(pluginId))}
        />
      ) : null}
    </div>
  );
}

function InstallCatalogEntry({
  entry,
  onClose,
  onInstalled,
}: {
  readonly entry: PluginCatalogEntryView;
  readonly onClose: () => void;
  readonly onInstalled: (pluginId: string) => void;
}) {
  const { hostClient } = useShell();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  return (
    <Dialog
      labelledBy={titleId}
      narrow
      onClose={onClose}
      title={<span id={titleId}>Install {entry.name}?</span>}
      footer={
        <>
          <button className="btn btn--ghost" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(null);
              void installPlugin(hostClient, { kind: "catalog", catalogId: entry.id })
                .then((result) => {
                  if (result.status === "installed") onInstalled(result.pluginId);
                  else setError(result.message);
                })
                .catch((reason: unknown) => setError(actionErrorMessage(reason)))
                .finally(() => setPending(false));
            }}
            type="button"
          >
            {pending ? "Installing…" : "Install"}
          </button>
        </>
      }
    >
      <div className="plugins-install">
        <div className="settings-add-hero">
          <IntegrationIcon icon={entry.icon ?? undefined} id={entry.id} name={entry.name} size="lg" />
          <p>{entry.description}</p>
        </div>
        <p className="settings-footnote">
          It runs sandboxed with no access to your accounts until you connect one.
          {entry.auth.length
            ? ` It connects with ${entry.auth.map(({ label }) => label.toLocaleLowerCase()).join(" or ")}.`
            : ""}
        </p>
        <SettingsError message={error} />
      </div>
    </Dialog>
  );
}

const addressKinds = [
  { value: "mcp", label: "MCP server" },
  { value: "openapi", label: "OpenAPI" },
  { value: "graphql", label: "GraphQL" },
] as const;

function InstallFromAddress({ onClose }: { readonly onClose: () => void }) {
  const { hostClient } = useShell();
  const navigate = useNavigate();
  const [kind, setKind] = useState<(typeof addressKinds)[number]["value"]>("mcp");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const valid = /^https?:\/\/\S+$/u.test(url.trim()) && name.trim().length > 0;
  return (
    <Dialog
      labelledBy={titleId}
      onClose={onClose}
      title={<span id={titleId}>Install from an address</span>}
      footer={
        <>
          <button className="btn btn--ghost" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!valid || pending}
            onClick={() => {
              setPending(true);
              setError(null);
              void installPlugin(hostClient, { kind, url: url.trim(), name: name.trim() })
                .then((result) => {
                  if (result.status === "installed") navigate(pluginPath(result.pluginId));
                  else setError(`It didn't build: ${result.message}`);
                })
                .catch((reason: unknown) => setError(actionErrorMessage(reason)))
                .finally(() => setPending(false));
            }}
            type="button"
          >
            {pending ? "Installing…" : "Install"}
          </button>
        </>
      }
    >
      <div className="plugins-form">
        <SettingsSegmented label="What it is" onChange={setKind} options={addressKinds} value={kind} />
        <label className="plugins-field">
          <span>Address</span>
          <input
            autoComplete="off"
            className="text-input"
            inputMode="url"
            onChange={(event) => setUrl(event.currentTarget.value)}
            placeholder={kind === "mcp" ? "https://mcp.example.com/mcp" : "https://api.example.com/openapi.json"}
            value={url}
          />
        </label>
        <label className="plugins-field">
          <span>Name</span>
          <input
            className="text-input"
            maxLength={120}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="What your agents will call it"
            value={name}
          />
        </label>
        <p className="settings-footnote">
          Opensteer generates the plugin's code from the address. Nobody reviews that code, so it's
          listed as written by an agent.
        </p>
        <SettingsError message={error} />
      </div>
    </Dialog>
  );
}
