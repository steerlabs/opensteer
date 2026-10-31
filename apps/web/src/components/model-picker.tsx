import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  executionMenu,
  executionAccounts,
  findRoute,
  placementForSelection,
  placementAccountTitle,
  accessModeOptions,
  reasoningLevel,
  type ExecutionRoute,
  type ExecutionSelection,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { AccountFix, ManageAccountsLink, type AccountFixes } from "./account-picker.js";
import { AccessModePanel, accessModeGlyph } from "./access-mode-control.js";
import type { ExecutionSettings } from "./execution-settings.js";
import { ModelSettingsPanel, LevelMeter } from "./model-options-picker.js";
import { composerFold } from "./fold-to-fit.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";
import { engineProviderId, ProviderLogo } from "./provider-brand.js";

export interface FreshStartAction {
  readonly label: string;
  readonly onSelect: () => void;
}
export function EngineMark({ driverKind }: { readonly driverKind: string }) {
  const providerId = engineProviderId(driverKind);
  return providerId ? <ProviderLogo providerId={providerId} /> : <Icon name="sparkles" />;
}
interface ModelPickerProps extends AccountFixes {
  blocked?: ExecutionSelection | null;
  disabled?: boolean;
  freshStart?: FreshStartAction | undefined;
  history: readonly ExecutionSelection[];
  onSelect: (route: ExecutionRoute) => void;
  onAccount?: ((placement: ThreadPlacementOption) => void) | undefined;
  placements: readonly ThreadPlacementOption[];
  required?: boolean;
  selection: ExecutionSelection | null;
  settings?: ExecutionSettings | null;
  summary?: string | null;
  conversationRequest?: number;
}
export function ModelPicker({
  blocked = null,
  disabled,
  freshStart,
  history,
  onAuthenticate,
  onRefresh,
  onSelect,
  onAccount,
  placements,
  required = false,
  selection,
  settings = null,
  summary = null,
  conversationRequest = 0,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState(conversationRequest);
  if (lastRequest !== conversationRequest) {
    setLastRequest(conversationRequest);
    setOpen(true);
    setView("conversation");
  }
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const route = findRoute(placements, selection ?? blocked);
  const placement =
    route?.placement ?? (blocked ? placementForSelection(placements, blocked) : null);
  const label = route?.model.displayName ?? blocked?.modelSelection.modelId ?? "Choose AI";
  const named = [placement?.engineName, label, summary].filter(Boolean).join(" · ");
  const unavailable = blocked !== null && route === null;
  const level =
    route && selection ? reasoningLevel(route.model, selection.modelSelection.options) : null;
  const close = () => {
    setOpen(false);
    setView(null);
  };
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          required
            ? "Choose AI"
            : `Engine and model: ${named}${unavailable ? " (unavailable)" : ""}`
        }
        title={[named, unavailable ? placement?.accountName : null].filter(Boolean).join(" · ")}
        aria-description={
          unavailable ? (placement?.detail ?? "Its account is no longer offered here.") : undefined
        }
        className={
          required
            ? "btn btn--primary btn--small exec-choose"
            : `exec-pill${unavailable ? " is-unavailable" : ""}`
        }
        onClick={() => setOpen(!open)}
      >
        {placement ? <EngineMark driverKind={placement.driverKind} /> : <Icon name="sparkles" />}
        <span className="exec-pill__label" data-fold={composerFold.model} data-fold-floor={64}>
          {label}
        </span>
        {summary ? (
          <span className="exec-summary" data-fold={composerFold.reasoning}>
            <span className="exec-summary__words">{summary}</span>
            {level ? (
              <span className="exec-summary__meter" data-fold={composerFold.reasoningMeter}>
                <LevelMeter {...level} />
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      {open && anchorRef.current ? (
        <Popover
          align="end"
          anchor={anchorRef.current}
          className="popover--execution"
          label="Choose an engine and model"
          role="dialog"
          onClose={close}
          onEscape={view === null ? undefined : () => setView(null)}
        >
          <EnginePickerPanel
            blocked={blocked}
            history={history}
            placements={placements}
            selection={selection}
            onSelect={(chosen) => {
              close();
              onSelect(chosen);
            }}
            onAccount={
              onAccount
                ? (account) => {
                    close();
                    onAccount(account);
                  }
                : undefined
            }
            onAuthenticate={
              onAuthenticate
                ? (account) => {
                    close();
                    onAuthenticate(account);
                  }
                : undefined
            }
            onRefresh={onRefresh}
            settings={settings}
            view={view}
            onView={setView}
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
          />
        </Popover>
      ) : null}
    </>
  );
}
interface PanelProps extends AccountFixes {
  blocked: ExecutionSelection | null;
  freshStart?: FreshStartAction | undefined;
  history: readonly ExecutionSelection[];
  onSelect: (route: ExecutionRoute) => void;
  onAccount?: ((placement: ThreadPlacementOption) => void) | undefined;
  placements: readonly ThreadPlacementOption[];
  selection: ExecutionSelection | null;
  settings?: ExecutionSettings | null;
  view?: string | null;
  onView?: ((view: string | null) => void) | undefined;
}
export function EnginePickerPanel({
  blocked,
  freshStart,
  history,
  onAuthenticate,
  onRefresh,
  onSelect,
  onAccount,
  placements,
  selection,
  settings = null,
  view = null,
  onView = () => {},
}: PanelProps) {
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const inForce = selection ?? blocked;
  const menu = useMemo(
    () => executionMenu({ placements, history, selection: inForce, browsing, query }),
    [browsing, history, inForce, placements, query],
  );
  const accounts = useMemo(() => executionAccounts(placements, inForce), [inForce, placements]);
  // A keyboard goes straight to search; a touch screen keeps its keyboard
  // down until the person asks for it.
  const finePointer =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches === true;
  const account = accounts.find((item) => item.selected);
  const access = settings?.access;
  const describedBy = useId();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const previousView = useRef(view);
  useLayoutEffect(() => {
    const previous = previousView.current;
    previousView.current = view;
    if (previous === view) return;
    if (view !== null)
      paneRef.current?.querySelector<HTMLButtonElement>("[data-view-back]")?.focus();
    else if (previous === "conversation")
      paneRef.current?.querySelector<HTMLButtonElement>(".execution-menu__bottom")?.focus();
    else
      [...(paneRef.current?.querySelectorAll<HTMLButtonElement>("[data-choice]") ?? [])]
        .find((button) => button.dataset.choice === previous)
        ?.focus();
  }, [view]);
  const location = menu.account?.environmentId ?? placements[0]?.environmentId;
  return (
    <div
      className="execution-menu"
      onKeyDown={(event) => {
        if (
          view === null &&
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !(event.target instanceof HTMLInputElement) &&
          event.key !== " "
        ) {
          setQuery((value) => value + event.key);
          event.preventDefault();
        }
      }}
    >
      <div className="execution-menu__engines" role="tablist" aria-label="AIs">
        {[...menu.ready, ...menu.unavailable].map((engine, index) => (
          <div key={engine.driverKind}>
            {index === menu.ready.length && menu.unavailable.length > 0 ? (
              <span className="execution-menu__heading">Unavailable</span>
            ) : null}
            <button
              type="button"
              role="tab"
              aria-label={engine.name}
              aria-selected={menu.browsed?.driverKind === engine.driverKind}
              className={`execution-menu__engine${engine.note ? " is-unavailable" : ""}`}
              onClick={() => {
                setBrowsing(engine.driverKind);
                setQuery("");
                onView(null);
              }}
            >
              <EngineMark driverKind={engine.driverKind} />
              <span>
                {engine.name}
                {engine.note ? <small>{engine.note}</small> : null}
              </span>
              {engine.inUse ? <i className="execution-menu__in-use" aria-label="In use" /> : null}
            </button>
          </div>
        ))}
      </div>
      <div className="execution-menu__pane" ref={paneRef}>
        {view === "conversation" ? (
          <>
            <button
              data-view-back
              className="execution-menu__back"
              type="button"
              onClick={() => onView(null)}
            >
              <Icon name="chevron-left" />
              This conversation
            </button>
            <div className="execution-menu__scroll">
              {access ? (
                <>
                  <AccessModePanel
                    engine={access.engine}
                    mode={access.mode}
                    onSelect={(mode) => void access.onApply(mode)}
                  />
                </>
              ) : null}
              <h3 className="picker__heading">Account</h3>
              <div role="radiogroup" aria-label="Account">
                {accounts.map((item) => (
                  <button
                    key={item.placement.harnessInstanceId}
                    type="button"
                    className="picker__row"
                    role="radio"
                    aria-checked={item.selected}
                    disabled={!item.placement.available || !onAccount}
                    onClick={() => onAccount?.(item.placement)}
                  >
                    <span className="picker__check">
                      {item.selected ? <Icon name="check" /> : null}
                    </span>
                    <span className="picker__label-stack">
                      <span>{item.title}</span>
                      <small
                        className={item.exhausted ? "execution-menu__exhausted" : "picker__detail"}
                      >
                        {item.detail}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {location ? <ManageAccountsLink environmentId={location} /> : null}
              {freshStart ? (
                <button className="picker__row" type="button" onClick={freshStart.onSelect}>
                  <span className="picker__label-stack">
                    <span>{freshStart.label}</span>
                    <small className="picker__detail">
                      Keeps this conversation. The AI starts a new session.
                    </small>
                  </span>
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            {/* Always in reach: a touch screen has no key to type a hidden search
                into, and the model wanted may be on another account. */}
            <label className="picker__search">
              <Icon name="search" />
              <input
                autoFocus={finePointer || query !== ""}
                aria-label="Search models"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search every AI…"
              />
            </label>
            {menu.blocked && !query ? (
              <div className="execution-menu__scroll">
                <p className="picker__empty">{menu.blocked.detail}</p>
                <AccountFix
                  placement={menu.blocked}
                  onAuthenticate={onAuthenticate}
                  onRefresh={onRefresh}
                />
                <ManageAccountsLink environmentId={menu.blocked.environmentId} />
              </div>
            ) : (
              <>
                {view === null ? (
                  <div role="menu" aria-label="Models" className="execution-menu__scroll">
                    {(menu.results ?? menu.models).map((model, index) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={model.checked}
                        aria-label={model.name}
                        // The description says where a search result runs, which
                        // is all that tells one account's copy from another's.
                        aria-describedby={model.description ? `${describedBy}-${index}` : undefined}
                        className="picker__row"
                        key={model.key}
                        onClick={() => onSelect(model.route)}
                      >
                        <span className="picker__label-stack">
                          <span className="picker__label">{model.name}</span>
                          {model.description ? (
                            <span className="picker__detail" id={`${describedBy}-${index}`}>
                              {model.description}
                            </span>
                          ) : null}
                        </span>
                        <span className="picker__check">
                          {model.checked ? <Icon name="check" /> : null}
                        </span>
                      </button>
                    ))}
                    {(menu.results ?? menu.models).length === 0 ? (
                      <p className="picker__empty">No models available.</p>
                    ) : null}
                  </div>
                ) : null}
                {menu.settings.length > 0 && settings?.options && !query ? (
                  <ModelSettingsPanel
                    model={settings.options.model}
                    values={settings.options.values}
                    onChange={settings.options.onChange}
                    choice={view}
                    onChoice={onView}
                  />
                ) : null}
              </>
            )}
          </>
        )}
        {view === "conversation" ? null : (
          <button
            type="button"
            className="execution-menu__bottom"
            onClick={() => onView("conversation")}
          >
            <Icon name={access ? accessModeGlyph[access.mode] : "unlock"} />
            <span className="execution-menu__bottom-words">
              {accessModeOptions.find((option) => option.mode === access?.mode)?.label ??
                "Full access"}
              <span className="execution-menu__bottom-account">
                {" · "}
                {account?.title ?? (menu.account ? placementAccountTitle(menu.account) : "Account")}
              </span>
            </span>
            <Icon name="chevron-right" />
          </button>
        )}
      </div>
    </div>
  );
}
