import {
  localMcpSecretServers,
  localMcpSecretsToSend,
  setLocalMcpServerSecrets,
  type LocalMcpSecretServer,
} from "@opensteer/client/integrations";
import { LocalMcpSecretFields } from "../../computer-apps/local-mcp-secret-fields.js";
import {
  completePluginConsent,
  pluginConsentKey,
  readPluginConsent,
  storePluginConsent,
  type PluginAddConsent,
} from "./plugin-add-consent.js";
import { useDeferredValue, useRef, useState, useLayoutEffect, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { PluginRow, PluginDetailView } from "@opensteer/protocol";
import {
  settingsMutationRejected,
  addPluginService,
  pluginPlacementAccounts,
  pluginGroups,
  pluginState,
  pluginPath,
  pluginTargetFromPath,
  pluginPlacementLabel,
  pluginAccountRows,
} from "@opensteer/client/settings";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";
import { IntegrationIcon } from "../../integrations/integration-icon.js";
import { Dialog } from "../../dialog.js";
import { ThreadIntegrationAction } from "../../thread-integration-action.js";
import { useShell } from "../../app-shell.js";
import { Icon } from "../../icon.js";
import { IntegrationsPage } from "../../integrations/integrations-page.js";
import { SettingsError, SettingsRow, SectionHeader, type SettingsView } from "../primitives.js";
import { useSettingsRead } from "../use-settings-read.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import { platformIntegrations } from "../../integrations/helpers.js";
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
  const { hostClient, snapshot } = useShell();
  const returnedAttempt = new URLSearchParams(search).get("integrationAttempt");
  async function resumeConsent(connectionId: string) {
    if (!returnedAttempt || !snapshot.homeWorkspaceId || !snapshot.user) return;
    const key = pluginConsentKey(snapshot.homeWorkspaceId, snapshot.user.id, returnedAttempt);
    const consent = readPluginConsent(key);
    if (!consent) return;
    await completePluginConsent(hostClient, consent, connectionId, (next) =>
      storePluginConsent(key, next),
    );
    sessionStorage.removeItem(key);
  }
  const [handlingReturn] = useState(() =>
    ["integrationAttempt", "provider", "workspace"].some((key) =>
      new URLSearchParams(search).has(key),
    ),
  );
  const suffix = pathname.slice("/settings/plugins".length).split("/").filter(Boolean);
  if (suffix[0] === "add") return <PluginDirectory view={view} />;
  if (suffix.length === 2) {
    const target = pluginTargetFromPath(
      suffix[0]!,
      (suffix[1] && decodeTargetSegment(suffix[1])) || "",
    );
    if (target)
      return (
        <PluginDetail
          key={pathname}
          target={target}
          view={view}
          onReturnConnected={resumeConsent}
        />
      );
  }
  if (handlingReturn)
    return (
      <IntegrationsPage embedded onConnected={resumeConsent}>
        <PluginOverview view={view} />
      </IntegrationsPage>
    );
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
  const focused = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focused.current && (!document.activeElement || document.activeElement === document.body)) {
      const element = document.querySelector<HTMLElement>(
        `[aria-label=${JSON.stringify(focused.current)}]`,
      );
      const collapsed = element?.closest("details");
      if (collapsed) collapsed.open = true;
      element?.focus();
    }
  });
  const groups = pluginGroups(overview.data?.rows ?? [], useDeferredValue(query), filter);
  return (
    <>
      <div
        className="settings-plugin-overview"
        onFocusCapture={(event) => {
          focused.current = event.target.getAttribute("aria-label");
        }}
      >
        <SectionHeader
          title="Plugins"
          action={
            <Link className="btn btn--primary" to="/settings/plugins/add">
              Add plugins
            </Link>
          }
        />
        <input
          className="text-input"
          type="search"
          placeholder="Search your plugins"
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
            <Icon name="puzzle" />
            <h2>Give your agents a starting point</h2>
            <CatalogSuggestions />
            <Link to="/settings/plugins/add">Browse all plugins</Link>
          </div>
        ) : (
          Object.entries(groups).map(([name, rows]) =>
            rows.length ? (
              name === "Turned off" ? (
                <details key={name}>
                  <summary>
                    <span>Turned off · {rows.length}</span>
                    <span className="settings-off-preview">
                      {rows.map((row) => row.title).join(", ")}
                    </span>
                  </summary>
                  <div className="card" role="list">
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
                  <div
                    className={`card${name === "Needs you" ? " settings-plugin-attention" : ""}`}
                  >
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
      </div>
      <PluginSecrets />
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
      <label className="settings-switch-target">
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
                if (settingsMutationRejected(reason)) attempt.current = null;
                // A lost response may have committed. Reconcile before offering the same operation again.
                try {
                  unwrapRpcResult(
                    await hostClient.rpc["plugins.detail.get"]({ target: row.target }),
                  );
                  reload();
                } catch {
                  /* Keep the original operation for an idempotent retry. */
                }
                setError(actionErrorMessage(reason));
              })
              .finally(() => setPending(false));
          }}
        />
      </label>
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
  const { snapshot } = useShell();
  const waitingDevice =
    row.target.kind === "device-app"
      ? snapshot.machines.find((machine) =>
          machine.apps?.some(
            (app) =>
              app.definitionId ===
              (row.target.kind === "device-app" ? row.target.definitionId : ""),
          ),
        )?.name
      : null;
  return (
    <div className="card__row" role="listitem">
      <PluginIcon row={row} />
      <Link className="card__row-body" to={pluginPath(row.target)}>
        <span className="card__row-title">{row.title}</span>
        <span className="card__row-detail">
          {state.label === "Waiting" ? <Icon name="clock" /> : null}
          {state.label !== "On"
            ? state.label === "Waiting"
              ? waitingDevice
                ? `${waitingDevice} · waiting`
                : "Waiting"
              : state.label
            : [
                row.accountCount > 1 ? `${row.accountCount} accounts` : null,
                pluginPlacementLabel(row, view.kind === "personal"),
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
      </Link>
      {state.group === "Needs you" ? (
        <>
          <Link className="btn btn--small" to={pluginPath(row.target)}>
            {state.label === "Connect" ? "Connect" : "Fix"}
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
function PluginDetail({
  target,
  view,
  onReturnConnected,
}: {
  target: PluginRow["target"];
  view: SettingsView;
  onReturnConnected: (connectionId: string) => Promise<void>;
}) {
  const { hostClient } = useShell();
  const detail = useSettingsRead(
    () => hostClient.rpc["plugins.detail.get"]({ target }).then(unwrapRpcResult),
    pluginPath(target),
  );
  const data = detail.data;
  return (
    <>
      {target.kind !== "service" && target.kind !== "device-app" ? (
        <Link to="/settings/plugins">All plugins</Link>
      ) : null}
      <SettingsError message={detail.error ? actionErrorMessage(detail.error) : null} />
      {data ? (
        <>
          {target.kind !== "service" && target.kind !== "device-app" ? (
            <>
              <div className="settings-add-hero">
                <PluginIcon row={data.row} />
                <SectionHeader
                  action={<EnableSwitch row={data.row} reload={detail.reload} />}
                  title={data.row.title}
                  lead={[data.row.source.kind, data.row.source.version].filter(Boolean).join(" · ")}
                />
              </div>
            </>
          ) : null}
          {target.kind === "service" || target.kind === "device-app" ? (
            <IntegrationsPage
              embedded
              initialDefinitionId={target.definitionId}
              onConnected={onReturnConnected}
              placementAnchor="plugin-placement"
              headerAction={<EnableSwitch row={data.row} reload={detail.reload} />}
            />
          ) : null}
          {target.kind !== "service" && target.kind !== "device-app" && data.accounts.length > 0 ? (
            <>
              <h2>Accounts</h2>
              <ul>
                {pluginAccountRows(data).map((account) => (
                  <li key={account.key}>
                    {account.label} · {account.status}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <Placement detail={data} reload={detail.reload} personal={view.kind === "personal"} />
          {data.permissions.length ? (
            <section className="settings-group">
              <h2 className="settings-group__title">What agents may do</h2>
              <div className="card">
                {data.permissions.map((fact) => (
                  <SettingsRow
                    key={`${fact.layer}:${fact.layer === "account-scope" && fact.label === "Account access" ? (data.accounts.some((account) => account.access === "read-write") ? "Read and update connected accounts" : "Read connected accounts") : fact.label}`}
                    icon="shield"
                    title={
                      fact.layer === "account-scope" && fact.label === "Account access"
                        ? data.accounts.some((account) => account.access === "read-write")
                          ? "Read and update connected accounts"
                          : "Read connected accounts"
                        : fact.label
                    }
                    action={
                      <span className="chip">
                        {fact.state === "ask"
                          ? "Ask first"
                          : fact.state === "allowed"
                            ? "Allowed"
                            : fact.state.replaceAll("-", " ")}
                      </span>
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}
          {data.contents.length ? (
            <section className="settings-group">
              <h2 className="settings-group__title">Comes with</h2>
              <div className="card">
                {data.contents.map((item) => (
                  <SettingsRow key={`${item.kind}:${item.name}`} icon="puzzle" title={item.name} />
                ))}
              </div>
            </section>
          ) : null}
          <PluginServers detail={data} />
          <PackageActions detail={data} reload={detail.reload} />
          {data.sourceFolder === null && data.row.target.kind === "plugin" ? (
            <p>Source folder unknown</p>
          ) : null}
        </>
      ) : (
        <p role="status">Loading plugin…</p>
      )}
      {data ? <PluginSecrets detail={data} /> : null}
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
  const [accounts, setAccounts] = useState<PluginDetailView["places"][number]["accounts"]>([]);
  const requiresAccount =
    detail.row.target.kind === "service" || detail.row.target.kind === "device-app";
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
        .map((place) => ({
          workspaceId: place.workspaceId,
          accounts: pluginPlacementAccounts(
            everywhere ? [] : place.accounts,
            accounts,
            requiresAccount,
          ),
        })),
      personalEverywhere: everywhere
        ? {
            accounts: pluginPlacementAccounts([], accounts, requiresAccount),
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
        if (settingsMutationRejected(reason)) attempt.current = null;
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
    <section className="settings-group" id="plugin-placement">
      <h2 className="settings-group__title">Where it’s on</h2>
      <div className="card">
        {requiresAccount
          ? detail.accounts.map((account) => (
              <label className="card__row" key={account.connectionId}>
                <span>{account.displayName}</span>
                <select
                  aria-label={`Access for ${account.displayName}`}
                  value={
                    accounts.find((a) => a.connectionId === account.connectionId)?.access ?? ""
                  }
                  disabled={pending}
                  onChange={(event) => {
                    const access = event.currentTarget.value;
                    setAccounts((previous) => [
                      ...previous.filter((a) => a.connectionId !== account.connectionId),
                      ...(access === "read" || access === "read-write"
                        ? [
                            {
                              connectionId: account.connectionId,
                              access:
                                access === "read" ? ("read" as const) : ("read-write" as const),
                            },
                          ]
                        : []),
                    ]);
                  }}
                >
                  <option value="">Choose access</option>
                  <option value="read">Read</option>
                  <option value="read-write">Read and update</option>
                </select>
              </label>
            ))
          : null}
        {personal &&
        detail.row.target.kind !== "skill" &&
        detail.row.source.kind !== "workspace" ? (
          <label className="card__row">
            <span className="card__row-body">Everywhere</span>
            <input
              className="switch"
              type="checkbox"
              role="switch"
              checked={detail.row.placement.personalEverywhere}
              disabled={
                pending ||
                !detail.row.permissions.canPlace ||
                (requiresAccount && !accounts.length && !detail.row.placement.personalEverywhere)
              }
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
        {!personal || !detail.row.placement.personalEverywhere
          ? detail.places.map((place) => (
              <label className="card__row" key={place.workspaceId}>
                <span className="card__row-body">{place.name}</span>
                <input
                  className="switch"
                  role="switch"
                  type="checkbox"
                  checked={
                    place.kind === "main" ? detail.row.placement.mainIncluded : place.selected
                  }
                  disabled={
                    pending ||
                    !place.canSelect ||
                    (requiresAccount &&
                      place.kind === "project" &&
                      !place.selected &&
                      !accounts.length) ||
                    !detail.row.permissions.canPlace
                  }
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
            ))
          : null}
      </div>
      {pending ? <p role="status">Saving…</p> : null}
      <SettingsError message={error} />
    </section>
  );
}
function CatalogSuggestions() {
  const { hostClient } = useShell();
  const directory = useSettingsRead(
    () => hostClient.rpc["plugins.directory.get"]({}).then(unwrapRpcResult),
    "plugin-suggestions",
  );
  return (
    <div className="settings-suggestions">
      {directory.data?.catalog
        .filter((item) => !item.added)
        .slice(0, 3)
        .map((item) => (
          <Link className="card card--padded" key={item.definitionId} to="/settings/plugins/add">
            <IntegrationIcon id={item.definitionId} name={item.title} />
            <strong>{item.title}</strong>
            <span>{item.description}</span>
          </Link>
        ))}
    </div>
  );
}
export function PluginAddSheet({
  definitionId,
  personal,
}: {
  definitionId: string;
  personal: boolean;
}) {
  const { hostClient, snapshot } = useShell();
  const [ready, setReady] = useState(false);
  const [everywhere, setEverywhere] = useState(personal);
  const [places, setPlaces] = useState<string[]>([]);
  const [access, setAccess] = useState<"read" | "read-write">("read");
  const [saved, setSaved] = useState(false);
  const [setupRunner, setSetupRunner] = useState<string | null>(null);
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const connectedAccount = useRef<string | null>(null);
  const placementAttempt = useRef<PluginAddConsent | null>(null);
  const consentStorageKey = useRef<string | null>(null);
  const facts = useSettingsRead(
    () => hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    `add:${definitionId}`,
  );
  const integration = facts.data
    ? platformIntegrations(facts.data).integrations.find(
        (item) => item.definition.id === definitionId,
      )
    : null;
  const directory = useSettingsRead(
    () => hostClient.rpc["plugins.directory.get"]({}).then(unwrapRpcResult),
    `add-contents:${definitionId}`,
  );
  const catalogItem = directory.data?.catalog.find((item) => item.definitionId === definitionId);
  const definition = integration?.definition;
  function reviewedConsent(): PluginAddConsent {
    return (
      placementAttempt.current ?? {
        target: { kind: definition?.computerApp ? "device-app" : "service", definitionId },
        everywhere,
        places,
        access,
        idempotencyKey: mutationIdempotencyKey("plugin-add-placement"),
        command: null,
      }
    );
  }
  async function applyPlacement(connectionId: string) {
    connectedAccount.current = connectionId;
    setPlacing(true);
    setPlacementError(null);
    try {
      const consent = reviewedConsent();
      placementAttempt.current = consent;
      await completePluginConsent(hostClient, consent, connectionId, (next) => {
        placementAttempt.current = next;
        if (consentStorageKey.current) storePluginConsent(consentStorageKey.current, next);
      });
      if (consentStorageKey.current) sessionStorage.removeItem(consentStorageKey.current);
      setSaved(true);
    } catch (reason) {
      setPlacementError(actionErrorMessage(reason));
      throw reason;
    } finally {
      setPlacing(false);
    }
  }
  return (
    <div className="settings-add-sheet">
      {ready ? (
        <>
          <IntegrationsPage
            embedded
            initialDefinitionId={definitionId}
            onAuthorizationStarted={(attemptId) => {
              if (!snapshot.homeWorkspaceId || !snapshot.user)
                throw new Error("This Opensteer is still loading.");
              const key = pluginConsentKey(snapshot.homeWorkspaceId, snapshot.user.id, attemptId);
              consentStorageKey.current = key;
              const consent = reviewedConsent();
              placementAttempt.current = consent;
              storePluginConsent(key, consent);
            }}
            onComputerSetupRequested={setSetupRunner}
            onConnected={applyPlacement}
          />
          {setupRunner && !saved ? (
            <AwaitDevicePlacement
              definitionId={definitionId}
              runnerId={setupRunner}
              onConnected={applyPlacement}
            />
          ) : null}
          {saved ? <p role="status">Connected and turned on in your chosen places.</p> : null}
          {placing ? <p role="status">Saving placement…</p> : null}
          <SettingsError message={placementError} />
          {placementError && connectedAccount.current ? (
            <button
              className="btn"
              disabled={placing}
              type="button"
              onClick={() => void applyPlacement(connectedAccount.current!).catch(() => undefined)}
            >
              Retry placement
            </button>
          ) : null}
        </>
      ) : (
        <>
          <div className="settings-add-hero">
            <IntegrationIcon id={definitionId} name={definition?.name ?? "Plugin"} />
            <h2>{definition?.name ?? "Add plugin"}</h2>
          </div>
          <p>{definition?.description}</p>
          <h3>Comes with</h3>
          <ul>
            {catalogItem?.contents?.map((item) => (
              <li key={`${item.kind}:${item.name}`}>
                {item.name} · {item.kind}
              </li>
            ))}
          </ul>
          <h3>What it’ll access</h3>
          {definition?.computerApp ? (
            <p>
              {access === "read"
                ? definition.computerApp.accessSummaries.read
                : definition.computerApp.accessSummaries.readWrite}
            </p>
          ) : null}
          <ul>
            {definition?.authMethods
              .flatMap((method) => (method.kind === "oauth" ? method.oauth.scopes : []))
              .map((scope) => (
                <li key={scope}>
                  {scope.endsWith("/gmail.readonly")
                    ? "Read and search mail"
                    : scope.endsWith("/gmail.send")
                      ? "Send mail"
                      : scope
                          .replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
                          .replaceAll("_", " ")}
                </li>
              ))}
          </ul>
          {definition?.computerApp ? (
            <div className="settings-plugin-filters" role="group" aria-label="Agent access">
              {(["read", "read-write"] as const).map((value) => (
                <button
                  className="btn"
                  type="button"
                  key={value}
                  aria-pressed={access === value}
                  onClick={() => setAccess(value)}
                >
                  {value === "read" ? "Read only" : "Read and write"}
                </button>
              ))}
            </div>
          ) : null}
          <h3>Where it’s on</h3>
          {personal ? (
            <label className="card__row">
              <span className="card__row-body">Everywhere</span>
              <input
                className="switch"
                role="switch"
                aria-label="Everywhere"
                type="checkbox"
                checked={everywhere}
                onChange={(event) => setEverywhere(event.currentTarget.checked)}
              />
            </label>
          ) : null}
          {!everywhere
            ? snapshot.workspaces.map((place) => (
                <label className="card__row" key={place.id}>
                  <span className="card__row-body">{place.name}</span>
                  <input
                    className="switch"
                    role="switch"
                    aria-label={place.name}
                    type="checkbox"
                    checked={places.includes(place.id)}
                    onChange={(event) =>
                      setPlaces(
                        event.currentTarget.checked
                          ? [...places, place.id]
                          : places.filter((id) => id !== place.id),
                      )
                    }
                  />
                </label>
              ))
            : null}
          <SettingsError message={placementError} />
          <button
            className="btn btn--primary"
            type="button"
            disabled={placing || !definition || (!everywhere && places.length === 0)}
            onClick={() => {
              setPlacing(true);
              setPlacementError(null);
              void (async () => {
                if (integration?.entry)
                  await addPluginService(hostClient, {
                    kind: definition?.computerApp ? "device-app" : "service",
                    definitionId,
                  });
                setReady(true);
              })()
                .catch((reason: unknown) => setPlacementError(actionErrorMessage(reason)))
                .finally(() => setPlacing(false));
            }}
          >
            {definition?.computerApp ? "Add" : `Add and sign in to ${definition?.name ?? "plugin"}`}
          </button>
        </>
      )}
    </div>
  );
}
function AwaitDevicePlacement({
  definitionId,
  runnerId,
  onConnected,
}: {
  definitionId: string;
  runnerId: string;
  onConnected: (connectionId: string) => Promise<void>;
}) {
  const { hostClient } = useShell();
  const detail = useSettingsRead(
    () =>
      hostClient.rpc["plugins.detail.get"]({ target: { kind: "device-app", definitionId } }).then(
        unwrapRpcResult,
      ),
    `device-consent:${definitionId}:${runnerId}`,
  );
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const account = detail.data?.accounts.find(
      (account) => account.runnerId === runnerId && account.status === "connected",
    );
    if (!account || applied.current === account.connectionId) return;
    applied.current = account.connectionId;
    void onConnected(account.connectionId).catch(() => undefined);
  }, [detail.data, onConnected, runnerId]);
  return (
    <p role="status">
      Waiting for this device’s approval before turning it on in your chosen places.
    </p>
  );
}
function PluginDirectory({ view }: { view: SettingsView }) {
  const { hostClient, snapshot } = useShell();
  const [category, setCategory] = useState("all");
  const metadata = useSettingsRead(
    () => hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    "directory-categories",
  );
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
        placeholder="Search plugins to add"
        aria-label="Search directory"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <div className="settings-plugin-filters" aria-label="Directory categories">
        {["all", "accounts", "devices"].map((value) => (
          <button
            className="btn"
            type="button"
            key={value}
            aria-pressed={category === value}
            onClick={() => setCategory(value)}
          >
            {value === "all" ? "All" : value === "accounts" ? "Accounts" : "On your devices"}
          </button>
        ))}
      </div>
      {directory.data?.requests.length || directory.data?.hasMoreRequests ? (
        <DirectoryRequests />
      ) : null}
      <div className="card settings-directory">
        {directory.data?.catalog
          .filter(
            (item) =>
              category === "all" ||
              metadata.data?.catalog.some(
                (entry) =>
                  entry.definition.id === item.definitionId &&
                  (category === "devices"
                    ? !!entry.definition.computerApp
                    : !entry.definition.computerApp),
              ),
          )
          .filter((item) =>
            `${item.title} ${item.description}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
          )
          .map((item) => (
            <div className="card__row" key={item.definitionId}>
              <IntegrationIcon id={item.definitionId} name={item.title} />
              <span className="card__row-body">
                <strong>{item.title}</strong>
                <span className="card__row-detail">{item.description}</span>
              </span>
              <button className="btn" type="button" onClick={() => setAdding(item.definitionId)}>
                {item.added ? "Connect" : "Add"}
              </button>
            </div>
          ))}
      </div>
      {adding ? (
        <Dialog
          labelledBy="add-plugin-title"
          title="Add plugin"
          onClose={() => {
            setAdding(null);
            directory.reload();
          }}
        >
          <PluginAddSheet definitionId={adding} personal={view.kind === "personal"} />
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
  const [showAll, setShowAll] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [before, setBefore] = useState<string | undefined>();
  const requests = useSettingsRead(
    () => hostClient.rpc["requests.list"](before ? { before } : {}).then(unwrapRpcResult),
    `directory-requests:${before ?? "first"}`,
  );
  return (
    <section>
      <h2>Suggested by your agents</h2>
      {!showAll ? (
        <button className="btn" type="button" onClick={() => setShowAll(true)}>
          View all Requests
        </button>
      ) : null}
      <SettingsError message={requests.error ? actionErrorMessage(requests.error) : null} />
      {requests.data?.requests
        .filter((entry) => entry.request.payload.kind === "integration.access")
        .slice(0, showAll ? undefined : 3)
        .map((entry) => (
          <div className="card card__row" key={entry.request.id}>
            <span className="card__row-body">
              <strong>{entry.request.presentation.title}</strong>
            </span>
            <button className="btn" type="button" onClick={() => setReviewing(entry.request.id)}>
              Review
            </button>
            {reviewing === entry.request.id ? (
              <Dialog
                title={entry.request.presentation.title}
                labelledBy="review-plugin-request"
                onClose={() => {
                  setReviewing(null);
                  requests.reload();
                }}
              >
                <ThreadIntegrationAction
                  request={entry.request}
                  threadId={entry.request.originatingThreadId}
                />
              </Dialog>
            ) : null}
          </div>
        ))}
      {showAll && requests.data?.window.hasMore && requests.data.window.nextBefore ? (
        <button
          className="btn"
          type="button"
          onClick={() => setBefore(requests.data!.window.nextBefore!)}
        >
          Next Requests
        </button>
      ) : null}
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

function PluginIcon({ row }: { row: PluginRow }) {
  if (row.target.kind === "service" || row.target.kind === "device-app")
    return <IntegrationIcon id={row.target.definitionId} name={row.title} />;
  return (
    <span className="card__row-glyph">
      <Icon
        name={
          row.target.kind === "specialist"
            ? "user"
            : row.target.kind === "skill"
              ? "code"
              : "puzzle"
        }
      />
    </span>
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

function PluginSecrets({ detail }: { readonly detail?: PluginDetailView }) {
  const { hostClient, snapshot } = useShell();
  const servers = useSettingsRead(() => localMcpSecretServers(hostClient), "plugin-secrets");
  const [changing, setChanging] = useState<LocalMcpSecretServer | null>(null);
  const [done, setDone] = useState(false);
  const matching = servers.data?.filter(
    (server) => !detail || detail.installationIds.includes(server.installationId),
  );
  return (
    <section className="settings-group">
      <SettingsError message={servers.error ? actionErrorMessage(servers.error) : null} />
      {matching?.length ? (
        <>
          <h2 className="settings-group__title">Secrets on your computers</h2>
          <div className="card">
            {matching.map((server) => (
              <SettingsRow
                key={server.id}
                icon="shield"
                title={server.name}
                detail={[server.computer, ...server.secrets.map((secret) => secret.title)]
                  .filter(Boolean)
                  .join(" · ")}
                action={
                  <button
                    type="button"
                    className="btn"
                    disabled={snapshot.connection !== "connected"}
                    onClick={() => {
                      setDone(false);
                      setChanging(server);
                    }}
                  >
                    Change
                  </button>
                }
              />
            ))}
          </div>
        </>
      ) : null}
      {done ? <p role="status">Secrets changed</p> : null}
      {changing ? (
        <ChangeSecrets
          server={changing}
          onClose={() => setChanging(null)}
          onSaved={() => {
            setChanging(null);
            setDone(true);
          }}
        />
      ) : null}
    </section>
  );
}

function PluginServers({ detail }: { readonly detail: PluginDetailView }) {
  const { hostClient } = useShell();
  const platform = useSettingsRead(
    () => hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    `plugin-servers:${pluginPath(detail.row.target)}`,
  );
  const entries =
    platform.data?.installations.filter(
      (entry) => detail.installationIds.includes(entry.installation.id) && entry.servers.length > 0,
    ) ?? [];
  return (
    <>
      <SettingsError message={platform.error ? actionErrorMessage(platform.error) : null} />
      {entries.length ? (
        <section className="settings-group">
          <h2 className="settings-group__title">MCP servers</h2>
          <div className="card">
            {entries.flatMap((entry) =>
              entry.servers.map((server) => (
                <SettingsRow
                  key={server.id}
                  title={server.name}
                  icon="puzzle"
                  detail={server.status}
                />
              )),
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
