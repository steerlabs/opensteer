import { useState, type ReactNode } from "react";
import { Link, useInRouterContext } from "react-router";
import {
  chromeTabGrantOptions,
  type ChromeTabGrantCatalog,
  agentWords,
  agentSentence,
  connectionModeDescriptions,
  type ConnectionModeDescription,
  accessModeOptions,
  draftAppsSummary,
  draftBrowserSummary,
  draftHas,
  draftNewProfileHome,
  draftPluginAccess,
  draftPluginsSummary,
  draftSharedProfiles,
  setDraftPluginAccess,
  toggleDraftResource,
  type AgentGrantDraft,
  type AppOption,
  type BrowserOptions,
  type HostClient,
  type PluginChoice,
  type PluginOption,
  type SentencePart,
} from "@opensteer/client/host";
import {
  useAgentAppOptions,
  useAgentPluginOptions,
  type AgentOptionsRead,
} from "@opensteer/client/react";
import type { ChatGrantShape, ThreadAccessMode } from "@opensteer/core";
import { Icon } from "../icon.js";
import { SentenceText } from "../../ui/address-text.js";
import { SettingsSegmented } from "./primitives.js";

type Disclosure = "browser" | "apps" | "plugins" | null;
const devicesPath = "/settings/devices";

/**
 * What a connected agent can use: everything, or the profiles, apps, plugins and Tasks
 * the person picks. Consent and an agent's page draw the same editor; each list opens
 * in place under its row, and apps and plugins are read only when their row opens.
 */
export function AgentGrantEditor({
  agent,
  browser,
  chromeTabs,
  client,
  disabled,
  draft,
  home,
  onChange,
  chat,
}: {
  /** Its name (a `{ name }`), or Opensteer's words for an agent with none. */
  readonly agent: SentencePart;
  readonly browser: BrowserOptions;
  readonly chromeTabs?: ChromeTabGrantCatalog | undefined;
  readonly client: HostClient;
  readonly disabled: boolean;
  readonly draft: AgentGrantDraft;
  readonly home: string;
  readonly onChange: (draft: AgentGrantDraft) => void;
  /** A chat's grant as the Home says it may be: only that is offered, and Tasks stays on. */
  readonly chat?: ChatGrantShape | undefined;
}) {
  const offers = (kind: ChatGrantShape["resources"][number]) =>
    chat === undefined || chat.resources.includes(kind);
  const [open, setOpen] = useState<Disclosure>(null);
  const apps = useAgentAppOptions(client, open === "apps" || hasKind(draft, "computer-app"));
  const plugins = useAgentPluginOptions(client, open === "plugins" || hasKind(draft, "plugin"));
  const chrome = chromeTabGrantOptions(chromeTabs);
  const names = { profiles: browser.profiles.map(({ id, name }) => ({ id, name })) };
  const shared = draftSharedProfiles(draft, names);
  const toggle = (which: Exclude<Disclosure, null>) => setOpen(open === which ? null : which);
  return (
    <>
      <fieldset className="settings-group" disabled={disabled}>
        <legend className="settings-group__title">{agentWords("consent.scope.title")}</legend>
        <div className="card">
          <Choice
            checked={draft.scope === "selected"}
            detail={agentWords("consent.scope.selected.detail")}
            label={agentWords("consent.scope.selected.label")}
            name="agent-grant-scope"
            onSelect={() => onChange({ ...draft, scope: "selected" })}
            value="selected"
          />
          {chat !== undefined && !chat.everything ? null : (
            <Choice
              checked={draft.scope === "everything"}
              detail={agentWords("consent.scope.everything.detail")}
              label={agentWords("consent.scope.everything.label")}
              name="agent-grant-scope"
              onSelect={() => onChange({ ...draft, scope: "everything" })}
              value="everything"
            />
          )}
        </div>
      </fieldset>
      {draft.scope === "selected" ? (
        <section aria-label={agentWords("consent.scope.selected.label")} className="settings-group">
          <div className="card agent-grant">
            {offers("browser-profile") ? (
              <>
                <DisclosureRow
                  disabled={disabled}
                  icon="globe"
                  id="browser"
                  onToggle={() => toggle("browser")}
                  open={open === "browser"}
                  summary={draftBrowserSummary(draft, browser)}
                  title={agentWords("consent.browser.title")}
                />
                {open === "browser" ? (
                  <BrowserChoices
                    agent={agent}
                    browser={browser}
                    disabled={disabled}
                    draft={draft}
                    onChange={onChange}
                  />
                ) : null}
              </>
            ) : null}
            {!offers("chrome-tabs")
              ? null
              : chrome.options.map((option) => (
                  <label className="card__row" key={option.resource.sourceId}>
                    <span aria-hidden className="card__row-glyph">
                      <Icon name="browser" />
                    </span>
                    <span className="card__row-body">
                      <span className="card__row-title">{option.name}</span>
                      <span
                        className="card__row-detail"
                        id={`agent-grant-chrome-${option.resource.sourceId}`}
                      >
                        {agentWords("consent.chromeTabs.detail")}
                      </span>
                    </span>
                    <span className="card__row-actions">
                      <input
                        aria-describedby={`agent-grant-chrome-${option.resource.sourceId}`}
                        aria-label={option.name}
                        checked={draftHas(draft, option.resource)}
                        className="switch"
                        disabled={disabled}
                        onChange={(event) =>
                          onChange(
                            toggleDraftResource(
                              draft,
                              option.resource,
                              event.currentTarget.checked,
                            ),
                          )
                        }
                        role="switch"
                        type="checkbox"
                      />
                    </span>
                  </label>
                ))}
            {chrome.repair && offers("chrome-tabs") ? (
              <p className="settings-footnote">{chrome.repair}</p>
            ) : null}
            {offers("computer-app") ? (
              <>
                <DisclosureRow
                  disabled={disabled}
                  icon="app"
                  id="apps"
                  onToggle={() => toggle("apps")}
                  open={open === "apps"}
                  summary={draftAppsSummary(draft, apps.status === "ready" ? apps.data : null)}
                  title={agentWords("consent.apps.title")}
                />
                {open === "apps" ? (
                  <div className="card__form agent-grant__list" id="agent-grant-apps">
                    <OptionsState read={apps}>
                      {(options) =>
                        options.length === 0 ? (
                          <EmptyChoice
                            detail={agentWords("consent.edge.noApps.detail")}
                            title={agentWords("consent.edge.noApps.title")}
                          />
                        ) : (
                          <>
                            {options.map((option) => (
                              <AppChoice
                                disabled={disabled}
                                key={option.key}
                                on={draftHas(draft, option.resource)}
                                onChange={(on) =>
                                  onChange(toggleDraftResource(draft, option.resource, on))
                                }
                                option={option}
                              />
                            ))}
                            <p className="settings-footnote">
                              <SentenceText
                                parts={agentSentence("consent.apps.footer", { agent })}
                              />
                            </p>
                          </>
                        )
                      }
                    </OptionsState>
                  </div>
                ) : null}
              </>
            ) : null}
            {offers("plugin") ? (
              <DisclosureRow
                disabled={disabled}
                icon="puzzle"
                id="plugins"
                onToggle={() => toggle("plugins")}
                open={open === "plugins"}
                summary={draftPluginsSummary(
                  draft,
                  plugins.status === "ready" ? plugins.data.options : null,
                )}
                title={agentWords("consent.plugins.title")}
              />
            ) : null}
            {open === "plugins" && offers("plugin") ? (
              <div className="card__form agent-grant__list" id="agent-grant-plugins">
                <OptionsState read={plugins}>
                  {({ options, more }) =>
                    options.length === 0 ? (
                      <EmptyChoice title={agentWords("consent.edge.noPlugins")} />
                    ) : (
                      <>
                        {options.map((option) => (
                          <PluginChoiceRow
                            disabled={disabled}
                            key={option.key}
                            onChange={(access) =>
                              onChange(setDraftPluginAccess(draft, option.target, access))
                            }
                            option={option}
                            value={draftPluginAccess(draft, option.target)}
                          />
                        ))}
                        <p className="settings-footnote">
                          {agentWords("consent.plugins.footer")}
                          {more ? ` ${agentWords("consent.plugins.more")}` : ""}
                        </p>
                      </>
                    )
                  }
                </OptionsState>
              </div>
            ) : null}
            <div className="card__row">
              <span aria-hidden className="card__row-glyph">
                <Icon name="list" />
              </span>
              <span className="card__row-body">
                <span className="card__row-title" id="agent-grant-tasks">
                  {agentWords("consent.tasks.title")}
                </span>
                <span className="card__row-detail" id="agent-grant-tasks-detail">
                  {chat
                    ? agentWords("chat.grant.tasks")
                    : agentWords("consent.tasks.detail", { home })}
                </span>
              </span>
              <span className="card__row-actions">
                <input
                  aria-describedby="agent-grant-tasks-detail"
                  aria-labelledby="agent-grant-tasks"
                  checked={draft.tasks}
                  className="switch"
                  disabled={disabled || chat !== undefined}
                  onChange={(event) => onChange({ ...draft, tasks: event.currentTarget.checked })}
                  role="switch"
                  type="checkbox"
                />
              </span>
            </div>
          </div>
          {/* The warning belongs to choosing Tasks: a chat holds it always, so it is not said. */}
          {draft.tasks && chat === undefined ? (
            <p className="settings-footnote agent-grant__warning" role="note">
              {agentWords("consent.tasks.warning", { home })}
            </p>
          ) : null}
          {shared.length > 0 ? (
            <p className="settings-footnote agent-grant__caution" role="note">
              <SentenceText
                parts={agentSentence(
                  "consent.browser.shareWarning",
                  { agent },
                  { profile: shared.join(", ") },
                )}
              />
            </p>
          ) : null}
          {draft.newProfile !== null && draftNewProfileHome(draft, browser)?.online === false ? (
            <p className="settings-footnote">
              <SentenceText
                parts={agentSentence(
                  "consent.edge.noDeviceOnline",
                  { agent },
                  { device: draftNewProfileHome(draft, browser)?.name ?? home },
                )}
              />
            </p>
          ) : null}
          {draft.tasks || draft.resources.length > 0 || draft.newProfile ? null : (
            <p className="settings-footnote">
              <SentenceText parts={agentSentence("consent.scope.nothingChosen", { agent })} />
            </p>
          )}
        </section>
      ) : null}
    </>
  );
}

/** A mode's words, with a name from outside drawn as a name. */
function sentenceOrWords(description: ConnectionModeDescription): ReactNode {
  return typeof description === "string" ? description : <SentenceText parts={description} />;
}

/** The four safety modes, in the words a connection's mode is chosen by. */
export function ConnectionModeChoices({
  descriptions = connectionModeDescriptions,
  disabled,
  mode,
  onChange,
  showSettingsNote,
}: {
  /** What each mode means for this connection (a chat for anyone has its own). */
  readonly descriptions?: Readonly<Record<ThreadAccessMode, ConnectionModeDescription>>;
  readonly disabled: boolean;
  readonly mode: ThreadAccessMode;
  readonly onChange: (mode: ThreadAccessMode) => void;
  readonly showSettingsNote: boolean;
}) {
  return (
    <fieldset className="settings-group" disabled={disabled}>
      <legend className="settings-group__title">{agentWords("consent.safety.title")}</legend>
      <div className="card">
        {accessModeOptions.map((option) => (
          <Choice
            checked={mode === option.mode}
            detail={sentenceOrWords(descriptions[option.mode])}
            key={option.mode}
            label={option.label}
            name="agent-consent-mode"
            onSelect={() => onChange(option.mode)}
            value={option.mode}
          />
        ))}
      </div>
      {showSettingsNote && mode !== "full-access" ? (
        <p className="settings-footnote">{agentWords("consent.scope.everything.settingsNote")}</p>
      ) : null}
    </fieldset>
  );
}

function Choice({
  checked,
  detail,
  label,
  name,
  onSelect,
  value,
}: {
  readonly checked: boolean;
  readonly detail: ReactNode;
  readonly label: string;
  readonly name: string;
  readonly onSelect: () => void;
  readonly value: string;
}) {
  return (
    <label className="card__row agent-consent__mode">
      <input checked={checked} name={name} onChange={onSelect} type="radio" value={value} />
      <span className="card__row-body">
        <span className="card__row-title">{label}</span>
        <span className="card__row-detail">{detail}</span>
      </span>
    </label>
  );
}

function DisclosureRow({
  disabled,
  icon,
  id,
  onToggle,
  open,
  summary,
  title,
}: {
  readonly disabled: boolean;
  readonly icon: "globe" | "app" | "puzzle";
  readonly id: string;
  readonly onToggle: () => void;
  readonly open: boolean;
  readonly summary: string;
  readonly title: string;
}) {
  return (
    <div className="card__row">
      <span aria-hidden className="card__row-glyph">
        <Icon name={icon} />
      </span>
      <span className="card__row-body">
        <span className="card__row-title">{title}</span>
        <span className="card__row-detail">{summary}</span>
      </span>
      <span className="card__row-actions">
        <button
          aria-controls={`agent-grant-${id}`}
          aria-expanded={open}
          aria-label={`${open ? agentWords("consent.hide") : agentWords("consent.choose")} ${title}`}
          className={open ? "btn btn--small btn--ghost" : "btn btn--small"}
          disabled={disabled}
          onClick={onToggle}
          type="button"
        >
          {open ? agentWords("consent.hide") : agentWords("consent.choose")}
        </button>
      </span>
    </div>
  );
}

function BrowserChoices({
  agent,
  browser,
  disabled,
  draft,
  onChange,
}: {
  /** Its name (a `{ name }`), or Opensteer's words for an agent with none. */
  readonly agent: SentencePart;
  readonly browser: BrowserOptions;
  readonly disabled: boolean;
  readonly draft: AgentGrantDraft;
  readonly onChange: (draft: AgentGrantDraft) => void;
}) {
  const homes = browser.homes;
  const canCreate = homes === null || homes.length > 0;
  const home = draft.newProfile?.homeRunnerId ?? browser.defaultHome;
  return (
    <div className="card__form agent-grant__list" id="agent-grant-browser">
      {canCreate ? (
        <div className="agent-grant__option">
          <label className="agent-grant__check">
            <input
              checked={draft.newProfile !== null}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...draft,
                  newProfile: event.currentTarget.checked
                    ? { homeRunnerId: browser.defaultHome }
                    : null,
                })
              }
              type="checkbox"
            />
            <span className="card__row-body">
              <span className="card__row-title">
                {agentWords("consent.browser.newProfile")}
                <span className="chip chip--accent">
                  {agentWords("consent.browser.newProfile.badge")}
                </span>
              </span>
              <span className="card__row-detail">
                {agentWords("consent.browser.newProfile.detail")}
              </span>
            </span>
          </label>
          {draft.newProfile !== null && homes && homes.length > 1 && home ? (
            homes.length <= 3 ? (
              <SettingsSegmented
                disabled={disabled}
                label={agentWords("consent.browser.keepOn")}
                onChange={(homeRunnerId) => onChange({ ...draft, newProfile: { homeRunnerId } })}
                options={homes.map((option) => ({ value: option.runnerId, label: option.name }))}
                value={home}
              />
            ) : (
              <label className="field agent-grant__keep">
                <span className="field__label">{agentWords("consent.browser.keepOn")}</span>
                <select
                  className="select-input"
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...draft, newProfile: { homeRunnerId: event.target.value } })
                  }
                  value={home}
                >
                  {homes.map((option) => (
                    <option key={option.runnerId} value={option.runnerId}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
            )
          ) : null}
        </div>
      ) : (
        <EmptyChoice title={agentWords("consent.edge.noBrowser.title")} />
      )}
      {browser.profiles.map((profile) => (
        <label className="agent-grant__check" key={profile.id}>
          <input
            checked={draftHas(draft, profile.resource)}
            disabled={disabled}
            onChange={(event) =>
              onChange(toggleDraftResource(draft, profile.resource, event.currentTarget.checked))
            }
            type="checkbox"
          />
          <span className="card__row-body">
            <span className="card__row-title">{profile.name}</span>
            <span className="card__row-detail">{profile.detail}</span>
          </span>
        </label>
      ))}
      <p className="settings-footnote">
        <SentenceText parts={agentSentence("consent.browser.pickerFooter", { agent })} />
      </p>
    </div>
  );
}

function AppChoice({
  disabled,
  on,
  onChange,
  option,
}: {
  readonly disabled: boolean;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
  readonly option: AppOption;
}) {
  const id = `agent-grant-app-${option.key}`;
  return (
    <div className="agent-grant__check">
      <span aria-hidden className="card__row-glyph">
        <Icon name={option.phone ? "phone" : "app"} />
      </span>
      <span className="card__row-body">
        <span className="card__row-title" id={id}>
          {option.name}
        </span>
        {option.detail ? <span className="card__row-detail">{option.detail}</span> : null}
      </span>
      <input
        aria-labelledby={id}
        checked={on}
        className="switch"
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        role="switch"
        type="checkbox"
      />
    </div>
  );
}

function PluginChoiceRow({
  disabled,
  onChange,
  option,
  value,
}: {
  readonly disabled: boolean;
  readonly onChange: (access: PluginChoice) => void;
  readonly option: PluginOption;
  readonly value: PluginChoice;
}) {
  const choices: { value: PluginChoice; label: string }[] = [
    { value: "off", label: agentWords("consent.plugins.off") },
    { value: "read", label: agentWords("consent.plugins.read") },
    ...(option.writable
      ? [{ value: "read-write" as const, label: agentWords("consent.plugins.readWrite") }]
      : []),
  ];
  return (
    <div className="agent-grant__check agent-grant__plugin">
      <span className="card__row-body">
        <span className="card__row-title">{option.name}</span>
        {option.detail ? <span className="card__row-detail">{option.detail}</span> : null}
      </span>
      <SettingsSegmented
        disabled={disabled}
        label={option.name}
        onChange={onChange}
        options={choices}
        value={option.writable || value !== "read-write" ? value : "read"}
      />
    </div>
  );
}

function EmptyChoice({ detail, title }: { readonly detail?: string; readonly title: string }) {
  // Settings edits a grant inside the app's router; the consent page (app.tsx) stands before it,
  // with no router, where a router Link cannot render: there it is a link to the page.
  const inApp = useInRouterContext();
  return (
    <div className="agent-grant__empty">
      <span className="card__row-body">
        <span className="card__row-title">{title}</span>
        {detail ? <span className="card__row-detail">{detail}</span> : null}
      </span>
      {inApp ? (
        <Link className="btn btn--small" to={devicesPath}>
          {agentWords("consent.edge.openDevices")}
        </Link>
      ) : (
        <a className="btn btn--small" href={devicesPath}>
          {agentWords("consent.edge.openDevices")}
        </a>
      )}
    </div>
  );
}

function OptionsState<T>({
  children,
  read,
}: {
  readonly children: (data: T) => ReactNode;
  readonly read: AgentOptionsRead<T>;
}) {
  if (read.status === "ready") return <>{children(read.data)}</>;
  if (read.status === "failed")
    return (
      <div className="agent-grant__empty" role="alert">
        <span className="card__row-detail">{read.error}</span>
        <button className="btn btn--small" onClick={read.retry} type="button">
          {agentWords("common.tryAgain")}
        </button>
      </div>
    );
  return (
    <p className="card__row-detail" role="status">
      {agentWords("common.loading")}
    </p>
  );
}

function hasKind(draft: AgentGrantDraft, kind: "computer-app" | "plugin"): boolean {
  return draft.scope === "selected" && draft.resources.some((resource) => resource.kind === kind);
}
