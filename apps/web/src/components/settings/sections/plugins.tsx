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
import {
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { PluginRow, PluginDetailView } from "@opensteer/protocol";
import {
  settingsMutationRejected,
  addPluginService,
  pluginCatalogCategories,
  pluginCatalogMatches,
  pluginCatalogProducts,
  pluginCatalogToAdd,
  pluginPlacementAccounts,
  pluginGroups,
  pluginState,
  pluginPath,
  pluginTargetFromPath,
  pluginPlacementLabel,
  pluginAccountRows,
  pluginsPageRows,
  fixDeviceDraftText,
  type PluginCatalogProduct,
} from "@opensteer/client/settings";
import { otherDeviceIcon } from "./agent-devices.js";
import { useStartTask, useThreadPath } from "../../start-task.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";
import { IntegrationIcon } from "../../integrations/integration-icon.js";
import { Dialog } from "../../dialog.js";
import { ThreadIntegrationAction } from "../../thread-integration-action.js";
import { useShell } from "../../app-shell.js";
import { Icon } from "../../icon.js";
import { IntegrationsPage } from "../../integrations/integrations-page.js";
import { LoadingRows } from "../../loading-rows.js";
import {
  SettingsError,
  SettingsRow,
  SettingsSegmented,
  SectionHeader,
  type SettingsView,
} from "../primitives.js";
import { useSettingsRead } from "../use-settings-read.js";
import { actionErrorMessage } from "../../../ui-utils.js";
import { platformIntegrations } from "../../integrations/helpers.js";
import { AddYourOwn } from "./add-your-own.js";

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
  // The catalog lives on this page; its old address still lands on it.
  if (suffix[0] === "add") return <PluginOverview view={view} showCatalog />;
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
function PluginOverview({
  view,
  showCatalog = false,
}: {
  readonly view: SettingsView;
  readonly showCatalog?: boolean;
}) {
  const { hostClient } = useShell();
  const overview = useSettingsRead(
    () => hostClient.rpc["plugins.overview.get"]({}).then(unwrapRpcResult),
    "plugins-overview",
    true,
  );
  const directory = useSettingsRead(
    () => hostClient.rpc["plugins.directory.get"]({}).then(unwrapRpcResult),
    "plugins-directory",
    true,
  );
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
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
  const rows = overview.data?.rows;
  const groups = pluginGroups(pluginsPageRows(rows ?? []), search);
  const toAdd = useMemo(
    () =>
      directory.data && rows
        ? pluginCatalogToAdd(pluginCatalogProducts(directory.data.catalog), rows)
        : null,
    [directory.data, rows],
  );
  return (
    <>
      <div
        className="settings-plugin-overview"
        onFocusCapture={(event) => {
          focused.current = event.target.getAttribute("aria-label");
        }}
      >
        <SectionHeader title="Plugins" lead="Accounts, apps and skills your agents can use." />
        <label className="settings-plugin-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Search your plugins and ones to add"
            aria-label="Search plugins"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <SettingsError message={overview.error ? actionErrorMessage(overview.error) : null} />
        {!rows ? (
          <LoadingRows label="Loading plugins" rows={3} />
        ) : (
          Object.entries(groups).map(([name, group]) =>
            group.length ? (
              name === "Turned off" ? (
                <details key={name} className="settings-plugin-off">
                  <summary>
                    <span>Turned off · {group.length}</span>
                    <span className="settings-off-preview">
                      {group.map((row) => row.title).join(", ")}
                    </span>
                  </summary>
                  <div className="card" role="list">
                    {group.map((row) => (
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
                    role="list"
                  >
                    {group.map((row) => (
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
        {directory.data?.requests.length || directory.data?.hasMoreRequests ? (
          <DirectoryRequests />
        ) : null}
        <PluginCatalog
          error={directory.error}
          onChanged={() => {
            overview.reload();
            directory.reload();
          }}
          products={toAdd}
          query={search}
          reveal={showCatalog}
          view={view}
        />
      </div>
      <PluginSecrets />
    </>
  );
}

/**
 * What a person can add: popular picks first, then every category, each
 * product once. Searching looks through all of it at once.
 */
function PluginCatalog({
  error,
  onChanged,
  products,
  query,
  reveal,
  view,
}: {
  readonly error: unknown;
  readonly onChanged: () => void;
  readonly products: readonly PluginCatalogProduct[] | null;
  readonly query: string;
  readonly reveal: boolean;
  readonly view: SettingsView;
}) {
  const [shelf, setShelf] = useState("popular");
  const [adding, setAdding] = useState<PluginCatalogProduct | null>(null);
  const [addingOwn, setAddingOwn] = useState(false);
  const section = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    if (reveal) section.current?.scrollIntoView({ block: "start" });
  }, [reveal]);
  const categories = products ? pluginCatalogCategories(products) : [];
  const popular = products?.filter((product) => product.popular).slice(0, 6) ?? [];
  const shelves = [
    ...(popular.length ? [{ id: "popular", label: "Popular" }] : []),
    ...categories,
    { id: "all", label: "All" },
  ];
  const active = shelves.some(({ id }) => id === shelf) ? shelf : shelves[0]!.id;
  const matching = query.trim()
    ? (products?.filter((product) => pluginCatalogMatches(product, query)) ?? [])
    : null;
  const open = (product: PluginCatalogProduct) => setAdding(product);
  return (
    <section aria-labelledby={titleId} className="settings-catalog" ref={section}>
      <h2 className="settings-catalog__title" id={titleId}>
        Add more
      </h2>
      <SettingsError message={error ? actionErrorMessage(error) : null} />
      {!products ? (
        error ? null : (
          <LoadingRows label="Loading plugins to add" rows={2} />
        )
      ) : matching ? (
        matching.length ? (
          <ProductRows onOpen={open} products={matching} />
        ) : (
          <p className="settings-catalog__empty">Nothing to add matches “{query.trim()}”.</p>
        )
      ) : (
        <>
          <div aria-label="Browse plugins" className="settings-plugin-filters" role="group">
            {shelves.map(({ id, label }) => (
              <button
                aria-pressed={active === id}
                className="btn"
                key={id}
                onClick={() => setShelf(id)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          {active === "popular" ? (
            <div className="settings-catalog__tiles">
              {popular.map((product) => (
                <button
                  aria-label={`Add ${product.title}`}
                  className="settings-catalog__tile"
                  key={product.id}
                  onClick={() => open(product)}
                  type="button"
                >
                  <span className="settings-catalog__tile-top">
                    <IntegrationIcon id={product.id} name={product.title} />
                    <span className="settings-catalog__name">{product.title}</span>
                    <span aria-hidden className="settings-catalog__plus">
                      <Icon name="plus" />
                    </span>
                  </span>
                  <span className="settings-catalog__description">{product.description}</span>
                </button>
              ))}
            </div>
          ) : active === "all" ? (
            [...categories, { id: null, label: "More" }].map(({ id, label }) => {
              const shelfProducts = products.filter((product) => product.category === id);
              return shelfProducts.length ? (
                <div className="settings-catalog__shelf" key={id ?? "more"}>
                  {categories.length ? (
                    <h3 className="settings-catalog__shelf-title">{label}</h3>
                  ) : null}
                  <ProductRows onOpen={open} products={shelfProducts} />
                </div>
              ) : null;
            })
          ) : (
            <ProductRows
              onOpen={open}
              products={products.filter((product) => product.category === active)}
            />
          )}
          {products.length === 0 ? (
            <p className="settings-catalog__empty">You’ve added everything in the catalog.</p>
          ) : null}
        </>
      )}
      {view.administrator ? (
        <button className="settings-catalog__own" onClick={() => setAddingOwn(true)} type="button">
          <span aria-hidden className="settings-catalog__own-glyph">
            <Icon name="plus" />
          </span>
          <span className="card__row-body">
            <span className="card__row-title">Add your own</span>
            <span className="card__row-detail">
              A plugin folder on {view.name}, or an MCP server’s address
            </span>
          </span>
        </button>
      ) : null}
      {adding ? (
        <Dialog
          labelledBy="add-plugin-title"
          title={adding.title}
          onClose={() => {
            setAdding(null);
            onChanged();
          }}
        >
          <PluginAddSheet personal={view.kind === "personal"} product={adding} />
        </Dialog>
      ) : null}
      {addingOwn ? (
        <AddYourOwn onAdded={onChanged} onClose={() => setAddingOwn(false)} view={view} />
      ) : null}
    </section>
  );
}

function ProductRows({
  onOpen,
  products,
}: {
  readonly onOpen: (product: PluginCatalogProduct) => void;
  readonly products: readonly PluginCatalogProduct[];
}) {
  return (
    <div className="card settings-catalog__rows">
      {products.map((product) => (
        <button
          aria-label={`Add ${product.title}`}
          className="settings-catalog__row"
          key={product.id}
          onClick={() => onOpen(product)}
          title={product.description}
          type="button"
        >
          <IntegrationIcon id={product.id} name={product.title} />
          <span className="settings-catalog__name">{product.title}</span>
          <span aria-hidden className="settings-catalog__add">
            Add
          </span>
        </button>
      ))}
    </div>
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
  const device = data?.row.device ?? null;
  return (
    <>
      {device ? (
        <Link to="/settings/devices">All devices</Link>
      ) : target.kind !== "service" && target.kind !== "device-app" ? (
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
                  title={device?.name ?? data.row.title}
                  {...(device
                    ? {}
                    : {
                        lead: [data.row.source.kind, data.row.source.version]
                          .filter(Boolean)
                          .join(" · "),
                      })}
                />
              </div>
              {device ? <DeviceSetup detail={data} name={device.name} /> : null}
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
          {data.sourceFolder === null &&
          data.row.target.kind === "plugin" &&
          data.row.source.kind !== "workspace" ? (
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
export function PluginAddSheet({
  personal,
  product,
}: {
  readonly personal: boolean;
  readonly product: PluginCatalogProduct;
}) {
  const { hostClient, snapshot } = useShell();
  const [definitionId, setDefinitionId] = useState(product.variants[0].definitionId);
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
    "plugin-add-facts",
  );
  const entry =
    product.variants.find((variant) => variant.definitionId === definitionId) ??
    product.variants[0];
  const integration = facts.data
    ? platformIntegrations(facts.data).integrations.find(
        (item) => item.definition.id === definitionId,
      )
    : null;
  const definition = integration?.definition;
  const device = definition ? !!definition.computerApp : product.category === "devices";
  const comesWith = entry.contents ?? [];
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
  if (ready)
    return (
      <div className="settings-add-sheet">
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
      </div>
    );
  return (
    <div className="settings-add-sheet">
      <div className="settings-add-sheet__hero">
        <IntegrationIcon id={definitionId} name={product.title} size="lg" />
        <p>{entry.description}</p>
      </div>
      {comesWith.length ? (
        <section className="settings-add-sheet__part">
          <h3>Comes with</h3>
          <ul className="settings-add-sheet__chips">
            {comesWith.slice(0, 8).map((item) => (
              <li key={`${item.kind}:${item.name}`}>{item.name}</li>
            ))}
            {comesWith.length > 8 ? <li>and {comesWith.length - 8} more</li> : null}
          </ul>
        </section>
      ) : null}
      <section className="settings-add-sheet__part">
        <h3>What it can reach</h3>
        {device ? (
          <>
            {definition?.computerApp ? (
              <p>
                {access === "read"
                  ? definition.computerApp.accessSummaries.read
                  : definition.computerApp.accessSummaries.readWrite}
              </p>
            ) : null}
            <SettingsSegmented
              label="Agent access"
              onChange={setAccess}
              options={[
                { value: "read", label: "Read only" },
                { value: "read-write", label: "Read and change" },
              ]}
              value={access}
            />
          </>
        ) : (
          <ul className="settings-add-sheet__list">
            {(entry.access ?? []).map((scope) => (
              <li key={scope}>{scopeLabel(scope)}</li>
            ))}
          </ul>
        )}
      </section>
      <section className="settings-add-sheet__part">
        <h3>Turn on in</h3>
        {personal ? (
          <SettingsSegmented
            label="Where it’s on"
            onChange={(value) => setEverywhere(value === "everywhere")}
            options={[
              { value: "everywhere", label: "Everywhere" },
              { value: "choose", label: "Choose places" },
            ]}
            value={everywhere ? "everywhere" : "choose"}
          />
        ) : null}
        {!everywhere ? (
          <div className="card settings-add-sheet__places">
            {snapshot.workspaces.map((place) => (
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
            ))}
          </div>
        ) : null}
      </section>
      {product.variants.length > 1 ? (
        <details className="settings-add-sheet__advanced">
          <summary>
            <Icon name="chevron-right" />
            Advanced · Connects through {entry.variant ?? entry.title}
          </summary>
          <SettingsSegmented
            // Connecting is for the way chosen when it began.
            disabled={placing}
            label="How it connects"
            onChange={setDefinitionId}
            options={product.variants.map((variant) => ({
              value: variant.definitionId,
              label: variant.variant ?? variant.title,
            }))}
            value={definitionId}
          />
        </details>
      ) : null}
      <SettingsError
        message={placementError ?? (facts.error ? actionErrorMessage(facts.error) : null)}
      />
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
        {device ? `Add ${product.title}` : `Connect ${product.title}`}
      </button>
    </div>
  );
}

/** A Google OAuth scope in a person's words; other providers' labels are already words. */
function scopeLabel(scope: string): string {
  if (scope.endsWith("/gmail.readonly")) return "Read and search mail";
  if (scope.endsWith("/gmail.send")) return "Send mail";
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//u, "").replaceAll("_", " ");
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
function DirectoryRequests() {
  const { hostClient } = useShell();
  const [showAll, setShowAll] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [before, setBefore] = useState<string | undefined>();
  const requests = useSettingsRead(
    () => hostClient.rpc["requests.list"](before ? { before } : {}).then(unwrapRpcResult),
    `directory-requests:${before ?? "first"}`,
  );
  const asks =
    requests.data?.requests.filter(
      (entry) => entry.request.payload.kind === "integration.access",
    ) ?? [];
  return (
    <section aria-label="Asked for by your agents" className="settings-plugin-asks">
      <SettingsError message={requests.error ? actionErrorMessage(requests.error) : null} />
      {asks.slice(0, showAll ? undefined : 3).map((entry) => (
        <div className="settings-plugin-ask" key={entry.request.id}>
          <span aria-hidden className="settings-plugin-ask__glyph">
            <Icon name="sparkles" />
          </span>
          <span className="card__row-body">
            <span className="card__row-title">{entry.request.presentation.title}</span>
            <span className="card__row-detail">Asked for by an agent</span>
          </span>
          <button
            className="btn btn--primary btn--small"
            type="button"
            onClick={() => setReviewing(entry.request.id)}
          >
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
      {!showAll && asks.length > 3 ? (
        <button className="link-btn" type="button" onClick={() => setShowAll(true)}>
          Show all {asks.length}
        </button>
      ) : null}
      {/* A page mixes kinds of Request, so older ones can wait behind a page with few of these. */}
      {(showAll || asks.length <= 3) &&
      requests.data?.window.hasMore &&
      requests.data.window.nextBefore ? (
        <button
          className="link-btn"
          type="button"
          onClick={() => setBefore(requests.data!.window.nextBefore!)}
        >
          Show more
        </button>
      ) : null}
    </section>
  );
}

/** Where a device's plugin came from, and a way to have an agent fix it. */
function DeviceSetup({ detail, name }: { detail: PluginDetailView; name: string }) {
  const { snapshot } = useShell();
  const threadPath = useThreadPath();
  const startTask = useStartTask();
  const target = detail.row.target;
  if (target.kind !== "plugin") return null;
  const threadId = detail.setupThreadId ?? null;
  return (
    <section className="settings-group">
      <div className="card">
        {threadId ? (
          <SettingsRow
            icon="message"
            title="Set up in"
            detail={
              <Link to={threadPath(threadId)}>
                {snapshot.threads.find((thread) => thread.id === threadId)?.title ?? "Open task"}
              </Link>
            }
          />
        ) : null}
        <SettingsRow
          icon="help-circle"
          title="Not working?"
          detail="An agent can look into it."
          action={
            <button
              className="btn btn--small"
              type="button"
              onClick={() => startTask(fixDeviceDraftText({ name, pluginId: target.pluginId }))}
            >
              Fix
            </button>
          }
        />
      </div>
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
        if (remove) void navigate(detail.row.device ? "/settings/devices" : "/settings/plugins");
        else reload();
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  }
  return (
    <section>
      <h2>Installation</h2>
      {detail.row.source.kind === "workspace" ? (
        <p>An agent made this plugin and updates it by installing its folder again.</p>
      ) : (
        <button
          className="btn"
          disabled={pending || !detail.row.permissions.canUpdate || detail.sourceFolder === null}
          onClick={() => run(false)}
          type="button"
        >
          Update
        </button>
      )}
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
          title={`Remove ${detail.row.device?.name ?? detail.row.title}?`}
          onClose={() => {
            if (!pending) setRemoving(false);
          }}
        >
          {detail.row.device ? (
            <p>
              Agents can no longer control {detail.row.device.name}. What it saved on its computer,
              such as a pairing, is deleted.
            </p>
          ) : (
            <p>Its skills, tools and specialist leave your agents. The folder stays on disk.</p>
          )}
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
  if (row.device)
    return (
      <span className="card__row-glyph">
        <Icon name={otherDeviceIcon[row.device.kind]} />
      </span>
    );
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
