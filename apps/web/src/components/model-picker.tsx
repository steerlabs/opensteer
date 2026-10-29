import {
  useDeferredValue,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  executionEngines,
  findRoute,
  placementAccountTitle,
  placementForSelection,
  recentChoices,
  searchRoutes,
  spansWorkLocations,
  type ExecutionEngine,
  type ExecutionRoute,
  type ExecutionSelection,
  type ExecutionStatus,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import type { HarnessModelDescriptor } from "@opensteer/protocol";
import { AccountFix, AccountRow, ManageAccountsLink, type AccountFixes } from "./account-picker.js";
import {
  SettingDetail,
  SettingsStrip,
  type ExecutionSettings,
  type SettingKey,
} from "./execution-settings.js";
import { composerFold } from "./fold-to-fit.js";
import { Icon } from "./icon.js";
import { optionsSummary } from "./model-options-picker.js";
import { Popover } from "./popover.js";
import { engineProviderId, ProviderLogo, providerLabel } from "./provider-brand.js";

/**
 * Starting the AI already in use over again. Present only where there is a
 * conversation to start over, and reviewed before anything is applied.
 */
export interface FreshStartAction {
  readonly label: string;
  readonly onSelect: () => void;
}

/** An engine's own mark, or a neutral glyph for an engine placed with no lab. */
export function EngineMark({ driverKind }: { readonly driverKind: string }) {
  const providerId = engineProviderId(driverKind);
  return providerId ? <ProviderLogo providerId={providerId} /> : <Icon name="sparkles" />;
}

const statusWords: Record<ExecutionStatus, string> = {
  attention: "Needs you",
  idle: "Not available right now",
  ready: "Ready",
};

interface ModelPickerProps extends AccountFixes {
  /** A choice the reader made that has since stopped being runnable. */
  blocked?: ExecutionSelection | null;
  disabled?: boolean;
  freshStart?: FreshStartAction | undefined;
  /** The person's earlier complete choices, newest first. */
  history: readonly ExecutionSelection[];
  onSelect: (route: ExecutionRoute) => void;
  /** Every account this composer may run on, available or not. */
  placements: readonly ThreadPlacementOption[];
  /** Nothing chosen yet: the pill is the composer's primary action, "Choose AI". */
  required?: boolean;
  selection: ExecutionSelection | null;
  /** The choice in force's options and access mode, set from the menu's foot. */
  settings?: ExecutionSettings | null;
  /** The model's options in words after its name, e.g. "High · Fast". */
  summary?: string | null;
}

/**
 * The composer's first pill: the engine and the model it runs, "Codex ·
 * GPT-5.6-Sol", wearing the engine's mark. Its menu reads the way the choice is
 * stored — engines down the side, then the browsed engine's accounts, then the
 * models of one account — and a search across all of them.
 */
export function ModelPicker({
  blocked = null,
  disabled,
  freshStart,
  history,
  onAuthenticate,
  onRefresh,
  onSelect,
  placements,
  required = false,
  selection,
  settings = null,
  summary = null,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  // An open setting's choices take the menu's place; Escape steps back out of
  // them before it closes the menu.
  const [setting, setSetting] = useState<SettingKey | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const route = findRoute(placements, selection);
  const blockedPlacement = blocked ? placementForSelection(placements, blocked) : null;
  const placement = route?.placement ?? blockedPlacement;
  const label = route?.model.displayName ?? blocked?.modelSelection.modelId ?? "Choose AI";
  const engine = placement?.engineName ?? null;
  // Where it runs is said only when that is what tells two routes apart.
  const where = placement && spansWorkLocations(placements) ? placement.whereLabel : null;
  // A blocked choice names the account it is waiting on: with no account pill
  // beside it, "Codex · GPT-5.6-Sol" alone would not say which one cannot run.
  const meta =
    blockedPlacement && !route
      ? [placementAccountTitle(blockedPlacement), where].filter(Boolean).join(" · ")
      : where;
  const named = [engine, label, route ? summary : null].filter(Boolean).join(" · ");
  // A choice that cannot run stays the subject even when its account has
  // gone from here entirely: named, marked and explained, never replaced.
  const unavailable = blocked !== null && route === null;
  const reason = unavailable
    ? (blockedPlacement?.detail ?? "Its account is no longer offered here.")
    : null;
  const close = () => {
    setOpen(false);
    setSetting(null);
  };
  return (
    <>
      {required ? (
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          className="btn btn--primary btn--small exec-choose"
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
          ref={anchorRef}
          type="button"
        >
          <Icon data-fold={composerFold.choiceMark} name="sparkles" />
          Choose AI
        </button>
      ) : (
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-description={reason ?? undefined}
          aria-label={
            unavailable ? `Engine and model: ${named} (unavailable)` : `Engine and model: ${named}`
          }
          className={unavailable ? "exec-pill is-unavailable" : "exec-pill"}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
          ref={anchorRef}
          title={[named, meta, reason].filter(Boolean).join("\n")}
          type="button"
        >
          {placement ? <EngineMark driverKind={placement.driverKind} /> : <Icon name="sparkles" />}
          {engine ? (
            <span className="exec-pill__engine" data-fold={composerFold.engine}>
              {engine}
              <span aria-hidden className="exec-pill__dot">
                ·
              </span>
            </span>
          ) : null}
          {/* Shortened, a model's name still names it down to about nine
              characters; below that it folds away rather than becoming "G…". */}
          <span className="exec-pill__label" data-fold={composerFold.model} data-fold-floor={72}>
            {label}
          </span>
          {route && summary ? (
            <span className="exec-pill__summary" data-fold={composerFold.reasoning}>
              <span aria-hidden className="exec-pill__dot">
                ·
              </span>
              {summary}
            </span>
          ) : null}
          {meta ? (
            <span className="exec-pill__meta" data-fold={composerFold.route}>
              <span aria-hidden className="exec-pill__dot">
                ·
              </span>
              {meta}
            </span>
          ) : null}
          <Icon
            className="exec-pill__chevron"
            data-fold={composerFold.chevron}
            name="chevron-down"
          />
        </button>
      )}
      {open && anchorRef.current ? (
        <Popover
          anchor={anchorRef.current}
          className="popover--engines"
          label="Choose an engine and model"
          onClose={close}
          onEscape={setting === null ? undefined : () => setSetting(null)}
          role="dialog"
        >
          <EnginePickerPanel
            blocked={blocked}
            freshStart={
              freshStart
                ? {
                    label: freshStart.label,
                    onSelect: () => {
                      close();
                      freshStart.onSelect();
                    },
                  }
                : undefined
            }
            history={history}
            onAuthenticate={
              onAuthenticate
                ? (account) => {
                    close();
                    onAuthenticate(account);
                  }
                : undefined
            }
            onDone={close}
            onRefresh={onRefresh}
            onSelect={(chosen) => {
              close();
              onSelect(chosen);
            }}
            placements={placements}
            selection={selection}
            setting={setting}
            settings={settings}
            onSetting={setSetting}
          />
        </Popover>
      ) : null}
    </>
  );
}

const recentTab = "recent";
/** Rows drawn per list; a catalog of thousands is found by searching it. */
const listLimit = 300;

interface EnginePickerPanelProps extends AccountFixes {
  blocked: ExecutionSelection | null;
  freshStart?: FreshStartAction | undefined;
  history: readonly ExecutionSelection[];
  /** A setting was chosen: the menu has done its job. */
  onDone?: (() => void) | undefined;
  onSelect: (route: ExecutionRoute) => void;
  placements: readonly ThreadPlacementOption[];
  selection: ExecutionSelection | null;
  /** The setting whose choices take the menu's place, owned by whoever opened the menu. */
  setting?: SettingKey | null;
  settings?: ExecutionSettings | null;
  onSetting?: ((setting: SettingKey | null) => void) | undefined;
}

/**
 * Engines down the side; the browsed engine's accounts, then one account's
 * models. Browsing an engine or an account changes nothing — only picking a
 * model does — so a reader can look at what another account offers without
 * leaving the one in use.
 */
export function EnginePickerPanel({
  blocked,
  freshStart,
  history,
  onAuthenticate,
  onDone,
  onRefresh,
  onSelect,
  placements,
  selection,
  setting = null,
  settings = null,
  onSetting = () => undefined,
}: EnginePickerPanelProps) {
  const engines = useMemo(() => executionEngines(placements), [placements]);
  const recent = useMemo(() => recentChoices(placements, history), [history, placements]);
  const current = findRoute(placements, selection);
  const anchor =
    current?.placement ?? (blocked ? placementForSelection(placements, blocked) : null);
  const showWhere = spansWorkLocations(placements);
  const manageLocation = anchor?.environmentId ?? engines[0]?.accounts[0]?.environmentId ?? null;
  const [tab, setTab] = useState<string>(
    () => anchor?.driverKind ?? (recent.length > 0 ? recentTab : (engines[0]?.driverKind ?? "")),
  );
  const [viewed, setViewed] = useState<string | null>(null);
  // Going back from a setting's choices returns the reader to its row.
  const mainRef = useRef<HTMLDivElement | null>(null);
  const previousSetting = useRef<SettingKey | null>(null);
  useLayoutEffect(() => {
    const left = previousSetting.current;
    previousSetting.current = setting;
    if (setting !== null || left === null) return;
    mainRef.current?.querySelector<HTMLButtonElement>(`[data-setting="${left}"]`)?.focus();
  }, [setting]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const searching = deferredQuery.trim().length > 0;
  const results = useMemo(
    () => (searching ? searchRoutes(placements, deferredQuery) : []),
    [deferredQuery, placements, searching],
  );
  const engine =
    tab === recentTab && recent.length > 0
      ? null
      : (engines.find((candidate) => candidate.driverKind === tab) ?? engines[0] ?? null);
  const account = engine ? viewedAccount(engine, viewed, anchor, history) : null;
  const browse = (next: string) => {
    setTab(next);
    setViewed(null);
    setQuery("");
  };
  const isCurrent = (route: ExecutionRoute) =>
    current !== null &&
    current.placement.harnessInstanceId === route.placement.harnessInstanceId &&
    current.model.providerId === route.model.providerId &&
    current.model.modelId === route.model.modelId;
  // A keyboard opens straight into search; a touch screen keeps its keyboard
  // down until the reader asks for it.
  const autofocusSearch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches === true;

  return (
    <div className="engine-picker">
      <div aria-label="Engines" className="engine-picker__rail" role="tablist">
        {recent.length > 0 ? (
          <button
            aria-selected={!searching && engine === null}
            className="engine-picker__tab"
            onClick={() => browse(recentTab)}
            role="tab"
            type="button"
          >
            <Icon name="recents" />
            <span className="engine-picker__name">Recent</span>
          </button>
        ) : null}
        {engines.map((candidate) => (
          <button
            aria-label={candidate.engineName}
            aria-selected={!searching && engine?.driverKind === candidate.driverKind}
            className={
              candidate.status === "ready"
                ? "engine-picker__tab"
                : "engine-picker__tab engine-picker__tab--off"
            }
            key={candidate.driverKind}
            onClick={() => browse(candidate.driverKind)}
            role="tab"
            title={`${candidate.engineName} · ${statusWords[candidate.status]}`}
            type="button"
          >
            <EngineMark driverKind={candidate.driverKind} />
            <span className="engine-picker__name">{candidate.engineName}</span>
            <span aria-hidden className={`status-dot status-dot--${candidate.status}`} />
          </button>
        ))}
        {manageLocation !== null ? (
          <span className="engine-picker__manage">
            <ManageAccountsLink environmentId={manageLocation} />
          </span>
        ) : null}
      </div>
      <div className="engine-picker__main" ref={mainRef}>
        {setting !== null && settings ? (
          <SettingDetail
            onBack={() => onSetting(null)}
            onDone={onDone ?? (() => onSetting(null))}
            setting={setting}
            settings={settings}
          />
        ) : (
          <>
            <label className="picker__search">
              <Icon name="search" />
              <input
                aria-label="Search models"
                data-autofocus={autofocusSearch ? true : undefined}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search every engine and account…"
                type="search"
                value={query}
              />
            </label>
            <div
              // The pane is the menu its rows belong to. It is replaced when the
              // engine changes; browsing an account replaces only the models below,
              // so the account row the reader pressed keeps the focus.
              aria-label={
                searching
                  ? "Search results"
                  : engine
                    ? `${engine.engineName} accounts and models`
                    : "Recent choices"
              }
              className="picker__list engine-picker__pane"
              key={searching ? "search" : (engine?.driverKind ?? recentTab)}
              role="menu"
            >
              {engines.length === 0 ? (
                <p className="picker__empty">
                  No AI accounts here yet. Add one under Manage accounts to start.
                </p>
              ) : searching ? (
                <RouteList
                  isCurrent={isCurrent}
                  label="Results"
                  onSelect={onSelect}
                  routes={results}
                  showWhere={showWhere}
                  empty={`No model matches “${deferredQuery.trim()}”.`}
                />
              ) : engine === null ? (
                <RecentList
                  current={current}
                  onBrowse={browse}
                  onSelect={onSelect}
                  recent={recent}
                  showWhere={showWhere}
                />
              ) : (
                <>
                  {engine.accounts.length > 1 || !engine.accounts[0]?.available ? (
                    <div
                      aria-label={`${engine.engineName} accounts`}
                      className="picker__section"
                      role="group"
                    >
                      <span className="picker__heading">Accounts</span>
                      {engine.accounts.map((candidate) => (
                        <AccountRow
                          // A blocked choice is still the current one, so its
                          // account keeps the check beside the reason it cannot run.
                          inUse={candidate.harnessInstanceId === anchor?.harnessInstanceId}
                          key={candidate.harnessInstanceId}
                          model={current?.model}
                          onAuthenticate={onAuthenticate}
                          onPress={() => setViewed(candidate.harnessInstanceId)}
                          onRefresh={onRefresh}
                          placement={candidate}
                          showWhere={showWhere}
                          viewing={
                            engine.accounts.length > 1 &&
                            candidate.harnessInstanceId === account?.harnessInstanceId
                          }
                        />
                      ))}
                    </div>
                  ) : null}
                  {account ? (
                    <div className="engine-picker__models" key={account.harnessInstanceId}>
                      <AccountModels
                        account={account}
                        heading={engine.accounts.length > 1 ? placementAccountTitle(account) : null}
                        isCurrent={isCurrent}
                        onAuthenticate={onAuthenticate}
                        onRefresh={onRefresh}
                        onSelect={onSelect}
                      />
                    </div>
                  ) : null}
                </>
              )}
            </div>
            {settings && !searching && (settings.options || settings.access) ? (
              <SettingsStrip onOpen={onSetting} settings={settings} />
            ) : null}
            {freshStart && !searching ? (
              <div className="picker__footer">
                <button className="picker__row" onClick={freshStart.onSelect} type="button">
                  <span className="picker__check" />
                  <span className="picker__label-stack">
                    <span className="picker__label">{freshStart.label}</span>
                    <span className="picker__detail">
                      Keeps this conversation. The AI starts a new session.
                    </span>
                  </span>
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The account whose models the browsed engine shows: the one the reader
 * opened, else the one in use, else the one last used on this engine, else
 * its default — the account a model picked here would run on.
 */
function viewedAccount(
  engine: ExecutionEngine,
  viewed: string | null,
  anchor: ThreadPlacementOption | null,
  history: readonly ExecutionSelection[],
): ThreadPlacementOption | null {
  const byId = (id: string | null | undefined) =>
    id ? engine.accounts.find((candidate) => candidate.harnessInstanceId === id) : undefined;
  const lastUsed = history.find((entry) => byId(entry.harnessInstanceId))?.harnessInstanceId;
  return (
    byId(viewed) ??
    byId(anchor?.harnessInstanceId) ??
    byId(lastUsed) ??
    engine.accounts.find((candidate) => candidate.available && candidate.defaultAccount) ??
    engine.accounts.find((candidate) => candidate.available) ??
    engine.accounts[0] ??
    null
  );
}

function AccountModels({
  account,
  heading,
  isCurrent,
  onAuthenticate,
  onRefresh,
  onSelect,
}: AccountFixes & {
  readonly account: ThreadPlacementOption;
  /** Names the account the models belong to when the engine has several. */
  readonly heading: string | null;
  readonly isCurrent: (route: ExecutionRoute) => boolean;
  readonly onSelect: (route: ExecutionRoute) => void;
}) {
  if (!account.available) {
    return (
      <div className="engine-picker__blocked" role="status">
        <p>{account.detail}</p>
        <AccountFix onAuthenticate={onAuthenticate} onRefresh={onRefresh} placement={account} />
      </div>
    );
  }
  const models = account.models.slice(0, listLimit);
  const labs = [...new Set(models.map((model) => model.providerId))];
  const row = (model: HarnessModelDescriptor) => (
    <ModelRow
      checked={isCurrent({ model, placement: account })}
      key={`${model.providerId}/${model.modelId}`}
      model={model}
      onSelect={() => onSelect({ model, placement: account })}
      showLab={false}
    />
  );
  return (
    <>
      {labs.length > 1 ? (
        labs.map((lab) => (
          <div aria-label={providerLabel(lab)} className="picker__section" key={lab} role="group">
            <span className="picker__heading">
              <ProviderLogo providerId={lab} />
              {providerLabel(lab)}
            </span>
            {models.filter((model) => model.providerId === lab).map(row)}
          </div>
        ))
      ) : (
        <div aria-label="Models" className="picker__section" role="group">
          {heading !== null ? (
            <span className="picker__heading">
              {labs[0] ? <ProviderLogo providerId={labs[0]} /> : null}
              Models on {heading}
            </span>
          ) : null}
          {models.map(row)}
        </div>
      )}
      {account.models.length > models.length ? (
        <p className="picker__empty">
          Search to find the other {account.models.length - models.length} models.
        </p>
      ) : null}
    </>
  );
}

function ModelRow({
  checked,
  detail,
  model,
  onSelect,
  showLab,
  trailing,
}: {
  readonly checked: boolean;
  readonly detail?: string | null;
  readonly model: HarnessModelDescriptor;
  readonly onSelect: () => void;
  readonly showLab: boolean;
  readonly trailing?: ReactNode;
}) {
  const detailId = useId();
  const description = detail ?? model.description ?? null;
  return (
    <button
      aria-checked={checked}
      aria-describedby={description ? detailId : undefined}
      aria-label={model.displayName}
      className="picker__row"
      onClick={onSelect}
      role="menuitemradio"
      type="button"
    >
      <span className="picker__check">{checked ? <Icon name="check" /> : null}</span>
      {showLab ? (
        <span className="picker__glyph">
          <ProviderLogo providerId={model.providerId} />
        </span>
      ) : null}
      <span className="picker__label-stack">
        <span className="picker__label">{model.displayName}</span>
        {description ? (
          <span className="picker__detail" id={detailId}>
            {description}
          </span>
        ) : null}
      </span>
      {trailing ?? (model.isDefault ? <span className="picker__state">Default</span> : null)}
    </button>
  );
}

/** "Codex · demo@opensteer.test", with the work location when routes span several. */
function routeWords(placement: ThreadPlacementOption, showWhere: boolean): string {
  return [
    placement.engineName,
    placementAccountTitle(placement),
    showWhere ? placement.whereLabel : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function RouteList({
  empty,
  isCurrent,
  label,
  onSelect,
  routes,
  showWhere,
}: {
  readonly empty: string;
  readonly isCurrent: (route: ExecutionRoute) => boolean;
  readonly label: string;
  readonly onSelect: (route: ExecutionRoute) => void;
  readonly routes: readonly ExecutionRoute[];
  readonly showWhere: boolean;
}) {
  if (routes.length === 0) return <p className="picker__empty">{empty}</p>;
  const shown = routes.slice(0, listLimit);
  return (
    <div aria-label={label} className="picker__section" role="group">
      {shown.map((route) => (
        <ModelRow
          checked={isCurrent(route)}
          detail={routeWords(route.placement, showWhere)}
          key={`${route.placement.harnessInstanceId}/${route.model.providerId}/${route.model.modelId}`}
          model={route.model}
          onSelect={() => onSelect(route)}
          showLab
          trailing={
            <span className="picker__route-mark">
              <EngineMark driverKind={route.placement.driverKind} />
            </span>
          }
        />
      ))}
      {routes.length > shown.length ? (
        <p className="picker__empty">
          {routes.length - shown.length} more match. Add a word to narrow them.
        </p>
      ) : null}
    </div>
  );
}

function RecentList({
  current,
  onBrowse,
  onSelect,
  recent,
  showWhere,
}: {
  readonly current: ExecutionRoute | null;
  readonly onBrowse: (driverKind: string) => void;
  readonly onSelect: (route: ExecutionRoute) => void;
  readonly recent: ReturnType<typeof recentChoices>;
  readonly showWhere: boolean;
}) {
  return (
    <div aria-label="Recent" className="picker__section" role="group">
      <span className="picker__heading">Recent choices</span>
      {recent.map((choice) => {
        const { placement, route, selection } = choice;
        const name = route?.model.displayName ?? selection.modelSelection.modelId;
        const options =
          route && route.model.options.length > 0
            ? optionsSummary(route.model, selection.modelSelection.options)
            : null;
        // A choice that cannot run now is still the reader's: it stays listed,
        // says why, and opens its engine where the fix is.
        const detail = route
          ? [routeWords(placement, showWhere), options].filter(Boolean).join(" · ")
          : `${routeWords(placement, showWhere)} · ${placement.detail}`;
        const checked =
          route !== null &&
          current !== null &&
          current.placement.harnessInstanceId === placement.harnessInstanceId &&
          current.model.providerId === route.model.providerId &&
          current.model.modelId === route.model.modelId;
        return (
          <RecentRow
            checked={checked}
            detail={detail}
            driverKind={placement.driverKind}
            key={`${placement.harnessInstanceId}/${selection.modelSelection.providerId}/${selection.modelSelection.modelId}`}
            labId={selection.modelSelection.providerId}
            name={name}
            off={route === null}
            onPress={() => (route ? onSelect(route) : onBrowse(placement.driverKind))}
          />
        );
      })}
    </div>
  );
}

function RecentRow({
  checked,
  detail,
  driverKind,
  labId,
  name,
  off,
  onPress,
}: {
  readonly checked: boolean;
  readonly detail: string;
  readonly driverKind: string;
  readonly labId: string;
  readonly name: string;
  readonly off: boolean;
  readonly onPress: () => void;
}) {
  const detailId = useId();
  return (
    <button
      aria-checked={checked}
      aria-describedby={detailId}
      aria-label={name}
      className={off ? "picker__row picker__row--off" : "picker__row"}
      onClick={onPress}
      role="menuitemradio"
      type="button"
    >
      <span className="picker__check">{checked ? <Icon name="check" /> : null}</span>
      <span className="picker__glyph">
        <ProviderLogo providerId={labId} />
      </span>
      <span className="picker__label-stack">
        <span className="picker__label">{name}</span>
        <span className="picker__detail" id={detailId}>
          {detail}
        </span>
      </span>
      <span className="picker__route-mark">
        <EngineMark driverKind={driverKind} />
      </span>
    </button>
  );
}
