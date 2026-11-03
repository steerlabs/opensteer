import { useDeferredValue, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { PluginRow, PluginDetailView } from "@opensteer/protocol";
import {
  pluginGroups,
  pluginState,
  pluginPath,
  pluginTargetFromPath,
  pluginPlacementLabel,
  pluginAccountRows,
} from "@opensteer/client/settings";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";
import { Dialog } from "../../dialog.js";
import { ThreadIntegrationAction } from "../../thread-integration-action.js";
import { useShell } from "../../app-shell.js";
import { Icon } from "../../icon.js";
import { IntegrationsPage } from "../../integrations/integrations-page.js";
import { SettingsError, SectionHeader, type SettingsView } from "../primitives.js";
import { useSettingsRead } from "../use-settings-read.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import { InstallPlugin } from "./install-plugin.js";

function decodeTargetSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
export function PluginsSection({ view }: { readonly view: SettingsView }) {
  const { pathname, search } = useLocation();
  const suffix = pathname.slice("/settings/plugins".length).split("/").filter(Boolean);
  if (suffix[0] === "add") return <PluginDirectory />;
  if (suffix.length === 2) {
    const target = pluginTargetFromPath(
      suffix[0]!,
      (suffix[1] && decodeTargetSegment(suffix[1])) || "",
    );
    if (target) return <PluginDetail key={pathname} target={target} view={view} />;
  }
  if (
    new URLSearchParams(search).has("integrationAttempt") ||
    new URLSearchParams(search).has("provider") ||
    new URLSearchParams(search).has("workspace")
  )
    return <IntegrationsPage embedded />;
  return <PluginOverview view={view} />;
}
function PluginOverview({ view }: { readonly view: SettingsView }) {
  const { hostClient } = useShell();
  const overview = useSettingsRead(
    () => hostClient.rpc["plugins.overview.get"]({}).then(unwrapRpcResult),
    "plugins-overview",
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginRow["tags"][number] | "all">("all");
  const groups = pluginGroups(overview.data?.rows ?? [], useDeferredValue(query), filter);
  return (
    <>
      <SectionHeader title="Plugins" lead={null} />
      <Link className="btn btn--primary" to="/settings/plugins/add">
        Add plugins
      </Link>
      <input
        className="text-input"
        type="search"
        aria-label="Search plugins"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <div className="settings-plugin-filters" aria-label="Filter plugins">
        {(["all", "accounts", "devices", "skills", "specialists"] as const).map((value) => (
          <button
            type="button"
            className="btn"
            aria-pressed={filter === value}
            key={value}
            onClick={() => setFilter(value)}
          >
            {
              {
                all: "All",
                accounts: "Accounts",
                devices: "On your devices",
                skills: "Skills",
                specialists: "Specialists",
              }[value]
            }
          </button>
        ))}
      </div>
      <SettingsError message={overview.error ? actionErrorMessage(overview.error) : null} />
      {!overview.data ? (
        <p role="status">Loading plugins…</p>
      ) : overview.data.rows.length === 0 ? (
        <div className="card card__empty">
          Add something your agents can use.{" "}
          <Link to="/settings/plugins/add">Browse all plugins</Link>
        </div>
      ) : (
        Object.entries(groups).map(([name, rows]) =>
          rows.length ? (
            name === "Turned off" ? (
              <details key={name}>
                <summary>Turned off · {rows.length}</summary>
                <div className="card">
                  {rows.map((row) => (
                    <OverviewRow
                      key={pluginPath(row.target)}
                      row={row}
                      view={view}
                      reload={overview.reload}
                    />
                  ))}
                </div>
              </details>
            ) : (
              <section key={name} className="settings-group">
                <h2 className="settings-group__title">{name}</h2>
                <div className={`card${name === "Needs you" ? " settings-plugin-attention" : ""}`}>
                  {rows.map((row) => (
                    <OverviewRow
                      key={pluginPath(row.target)}
                      row={row}
                      view={view}
                      reload={overview.reload}
                    />
                  ))}
                </div>
              </section>
            )
          ) : null,
        )
      )}
    </>
  );
}
function EnableSwitch({ row, reload }: { row: PluginRow; reload: () => void }) {
  const { hostClient } = useShell();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ key: string; enabled: boolean; revision: number } | null>(null);
  return (
    <>
      <input
        className="switch"
        type="checkbox"
        role="switch"
        aria-label={`Enable ${row.title}`}
        aria-busy={pending}
        checked={row.placement.enabled}
        disabled={pending || !row.permissions.canEnable}
        onChange={() => {
          if (pending) return;
          const operation = attempt.current ?? {
            key: mutationIdempotencyKey("settings-enable"),
            enabled: !row.placement.enabled,
            revision: row.placement.revision,
          };
          attempt.current = operation;
          setPending(true);
          setError(null);
          void hostClient
            .dispatch({
              type: "settings.plugin.enabled.set",
              idempotencyKey: operation.key,
              target: row.target,
              expectedRevision: operation.revision,
              enabled: operation.enabled,
            })
            .then(() => {
              attempt.current = null;
              reload();
            })
            .catch(async (reason: unknown) => {
              // A lost response may have committed. Reconcile before offering the same operation again.
              try {
                unwrapRpcResult(await hostClient.rpc["plugins.detail.get"]({ target: row.target }));
                reload();
              } catch {
                /* Keep the original operation for an idempotent retry. */
              }
              setError(actionErrorMessage(reason));
            })
            .finally(() => setPending(false));
        }}
      />
      {pending ? <span role="status">Saving…</span> : null}
      <SettingsError message={error} />
    </>
  );
}
function OverviewRow({
  row,
  view,
  reload,
}: {
  row: PluginRow;
  view: SettingsView;
  reload: () => void;
}) {
  const state = pluginState(row);
  return (
    <div className="card__row">
      <span className="card__row-glyph">
        <Icon name={state.group === "Needs you" ? "alert-circle" : "puzzle"} />
      </span>
      <Link className="card__row-body" to={pluginPath(row.target)}>
        <span className="card__row-title">{row.title}</span>
        <span className="card__row-detail">
          {state.label !== "On"
            ? state.label
            : [
                row.accountCount ? `${row.accountCount} accounts` : null,
                pluginPlacementLabel(row, view.kind === "personal"),
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
      </Link>
      {state.group === "Needs you" ? (
        <>
          <Link className="btn btn--small" to={pluginPath(row.target)}>
            Fix
          </Link>
          <details>
            <summary aria-label={`More actions for ${row.title}`}>•••</summary>
            <EnableSwitch row={row} reload={reload} />
          </details>
        </>
      ) : (
        <EnableSwitch row={row} reload={reload} />
      )}
    </div>
  );
}
function PluginDetail({ target, view }: { target: PluginRow["target"]; view: SettingsView }) {
  const { hostClient } = useShell();
  const detail = useSettingsRead(
    () => hostClient.rpc["plugins.detail.get"]({ target }).then(unwrapRpcResult),
    pluginPath(target),
  );
  const data = detail.data;
  return (
    <>
      <Link to="/settings/plugins">All plugins</Link>
      <SettingsError message={detail.error ? actionErrorMessage(detail.error) : null} />
      {data ? (
        <>
          <SectionHeader
            title={data.row.title}
            lead={[data.row.source.kind, data.row.source.version].filter(Boolean).join(" · ")}
          />
          <EnableSwitch row={data.row} reload={detail.reload} />
          <h2>Accounts</h2>
          <ul>
            {pluginAccountRows(data).map((account) => (
              <li key={account.key}>
                {account.label} · {account.status}
              </li>
            ))}
          </ul>
          <h2>What agents may do</h2>
          <ul>
            {data.permissions.map((fact) => (
              <li key={`${fact.layer}:${fact.label}`}>
                {fact.label} · {fact.state === "ask" ? "Ask first" : fact.state} · {fact.layer}
              </li>
            ))}
          </ul>
          <h2>Comes with</h2>
          <ul>
            {data.contents.map((item) => (
              <li key={`${item.kind}:${item.name}`}>
                {item.name} · {item.kind}
              </li>
            ))}
          </ul>
          <Placement detail={data} reload={detail.reload} personal={view.kind === "personal"} />
          <PackageActions detail={data} reload={detail.reload} />
          {target.kind === "service" || target.kind === "device-app" ? (
            <IntegrationsPage embedded initialDefinitionId={target.definitionId} />
          ) : null}
          {data.sourceFolder === null && data.row.target.kind === "plugin" ? (
            <p>Source folder unknown</p>
          ) : null}
        </>
      ) : (
        <p role="status">Loading plugin…</p>
      )}
    </>
  );
}
function Placement({
  detail,
  reload,
  personal,
}: {
  detail: PluginDetailView;
  reload: () => void;
  personal: boolean;
}) {
  const { hostClient } = useShell();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<Parameters<typeof hostClient.dispatch>[0] | null>(null);
  function change(mainIncluded: boolean, selected: string[], everywhere: boolean) {
    if (pending) return;
    const command = attempt.current ?? {
      type: "settings.plugin.placement.set" as const,
      idempotencyKey: mutationIdempotencyKey("settings-placement"),
      target: detail.row.target,
      expectedRevision: detail.row.placement.revision,
      mainIncluded,
      projects: detail.places
        .filter((place) => place.kind !== "main" && selected.includes(place.workspaceId))
        .map((place) => ({ workspaceId: place.workspaceId, accounts: place.accounts })),
      personalEverywhere: everywhere
        ? {
            accounts: detail.accounts.flatMap((account) =>
              account.access
                ? [{ connectionId: account.connectionId, access: account.access }]
                : [],
            ),
          }
        : null,
    };
    attempt.current = command;
    setPending(true);
    setError(null);
    void hostClient
      .dispatch(command)
      .then(() => {
        attempt.current = null;
        reload();
      })
      .catch(async (reason: unknown) => {
        try {
          unwrapRpcResult(
            await hostClient.rpc["plugins.detail.get"]({ target: detail.row.target }),
          );
          reload();
        } catch {
          /* Preserve the uncertain operation. */
        }
        setError(actionErrorMessage(reason));
      })
      .finally(() => setPending(false));
  }
  const selected = detail.places
    .filter((place) => place.selected)
    .map((place) => place.workspaceId);
  return (
    <section>
      <h2>Where it’s on</h2>
      {personal && detail.row.target.kind !== "skill" && detail.row.source.kind !== "workspace" ? (
        <label className="card__row">
          Everywhere
          <input
            type="checkbox"
            role="switch"
            checked={detail.row.placement.personalEverywhere}
            disabled={pending || !detail.row.permissions.canPlace}
            onChange={(event) =>
              change(
                true,
                event.currentTarget.checked
                  ? detail.places.map((place) => place.workspaceId)
                  : selected,
                event.currentTarget.checked,
              )
            }
          />
        </label>
      ) : null}
      {detail.places.map((place) => (
        <label className="card__row" key={place.workspaceId}>
          {place.name}
          <input
            type="checkbox"
            checked={place.kind === "main" ? detail.row.placement.mainIncluded : place.selected}
            disabled={pending || !place.canSelect || !detail.row.permissions.canPlace}
            onChange={(event) =>
              change(
                place.kind === "main"
                  ? event.currentTarget.checked
                  : detail.row.placement.mainIncluded,
                event.currentTarget.checked
                  ? [...selected, place.workspaceId]
                  : selected.filter((id) => id !== place.workspaceId),
                false,
              )
            }
          />
        </label>
      ))}
      {pending ? <p role="status">Saving…</p> : null}
      <SettingsError message={error} />
    </section>
  );
}
function PluginDirectory() {
  const { hostClient, snapshot } = useShell();
  const [adding, setAdding] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const directory = useSettingsRead(
    () => hostClient.rpc["plugins.directory.get"]({}).then(unwrapRpcResult),
    "plugins-directory",
  );
  return (
    <>
      <Link to="/settings/plugins">Your plugins</Link>
      <SectionHeader title="Add plugins" lead={null} />
      <SettingsError message={directory.error ? actionErrorMessage(directory.error) : null} />
      <input
        type="search"
        className="text-input"
        aria-label="Search directory"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <div className="card">
        {directory.data?.catalog
          .filter((item) =>
            `${item.title} ${item.description}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
          )
          .map((item) => (
            <div className="card__row" key={item.definitionId}>
              <span className="card__row-body">
                <strong>{item.title}</strong>
                <span className="card__row-detail">{item.description}</span>
              </span>
              <button
                className="btn"
                type="button"
                disabled={item.added}
                onClick={() => setAdding(item.definitionId)}
              >
                {item.added ? "Added" : "Add"}
              </button>
            </div>
          ))}
      </div>
      {directory.data?.requests.length ? <DirectoryRequests /> : null}
      {adding ? (
        <Dialog
          labelledBy="add-plugin-title"
          title="Add plugin"
          onClose={() => {
            setAdding(null);
            directory.reload();
          }}
        >
          <IntegrationsPage embedded initialDefinitionId={adding} />
        </Dialog>
      ) : null}
      <InstallPlugin
        connected={snapshot.connection === "connected"}
        onInstalled={directory.reload}
      />
      <IntegrationsPage embedded installerOnly />
    </>
  );
}

function DirectoryRequests() {
  const { hostClient } = useShell();
  const requests = useSettingsRead(
    () => hostClient.rpc["requests.list"]({}).then(unwrapRpcResult),
    "directory-requests",
  );
  return (
    <section>
      <h2>Suggested by your agents</h2>
      <SettingsError message={requests.error ? actionErrorMessage(requests.error) : null} />
      {requests.data?.requests
        .filter((entry) => entry.request.payload.kind === "integration.access")
        .map((entry) => (
          <ThreadIntegrationAction
            key={entry.request.id}
            request={entry.request}
            threadId={entry.request.originatingThreadId}
          />
        ))}
    </section>
  );
}

function PackageActions({ detail, reload }: { detail: PluginDetailView; reload: () => void }) {
  const { hostClient } = useShell();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const target = detail.row.target;
  if (target.kind !== "plugin") return null;
  const pluginId = target.pluginId;
  function run(remove: boolean) {
    if (pending) return;
    setPending(true);
    setError(null);
    void hostClient
      .dispatch(
        remove
          ? {
              type: "plugin.remove",
              pluginId: pluginId,
              idempotencyKey: mutationIdempotencyKey("plugin-remove"),
            }
          : {
              type: "plugin.update",
              pluginId: pluginId,
              input: { directory: detail.sourceFolder! },
              idempotencyKey: mutationIdempotencyKey("plugin-update"),
            },
      )
      .then(() => {
        if (remove) void navigate("/settings/plugins");
        else reload();
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  }
  return (
    <section>
      <h2>Installation</h2>
      <button
        className="btn"
        disabled={pending || !detail.row.permissions.canUpdate || detail.sourceFolder === null}
        onClick={() => run(false)}
        type="button"
      >
        Update
      </button>
      <button
        className="btn btn--danger"
        disabled={pending || !detail.row.permissions.canRemove}
        onClick={() => setRemoving(true)}
        type="button"
      >
        Remove
      </button>
      {removing ? (
        <Dialog
          labelledBy="remove-plugin-title"
          title={`Remove ${detail.row.title}?`}
          onClose={() => {
            if (!pending) setRemoving(false);
          }}
        >
          <p>Its skills, tools and specialist leave your agents. The folder stays on disk.</p>
          <button
            className="btn"
            type="button"
            disabled={pending}
            onClick={() => setRemoving(false)}
          >
            Cancel
          </button>
          <button
            className="btn btn--danger"
            type="button"
            disabled={pending}
            onClick={() => run(true)}
          >
            Remove plugin
          </button>
        </Dialog>
      ) : null}
      <SettingsError message={error} />
    </section>
  );
}
