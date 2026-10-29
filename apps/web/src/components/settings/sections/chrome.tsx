import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  browserSiteLabel,
  chromeProfilePresence,
  formatRelativeTime,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import type {
  BrowserSiteGrant,
  BrowserSourcesState,
  BrowserSourceSummary,
} from "@opensteer/protocol/browser-sources";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { ConnectChrome } from "../../chrome/connect-chrome.js";
import { useShellChromeEnvironment } from "../../chrome/use-shell-chrome-environment.js";
import { Icon } from "../../icon.js";
import { LoadingRows } from "../../loading-rows.js";
import { useToast } from "../../toast.js";
import { WorkspaceOrb } from "../../workspace-orb.js";
import { SectionHeader, SettingsError } from "../primitives.js";

const refreshEveryMs = 10_000;

/**
 * Settings → Chrome. Two things only: the Chrome profiles connected to this
 * Opensteer, and the sites each Workspace's agents may sign in to.
 */
export function ChromeSection() {
  const { hostClient, snapshot } = useShell();
  const environment = useShellChromeEnvironment();
  const [state, setState] = useState<BrowserSourcesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setState(unwrapRpcResult(await hostClient.rpc["browser.sources.get"]({})));
      setError(null);
    } catch (reason) {
      setError(actionErrorMessage(reason));
    }
  }, [hostClient]);

  // Online and last seen change without anyone touching this page.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, refreshEveryMs);
    return () => window.clearInterval(timer);
  }, [load]);

  const sources = state?.sources ?? [];
  const connectedFirst = [...sources].sort(
    (left, right) => Number(right.connected) - Number(left.connected),
  );

  return (
    <>
      <SectionHeader
        lead="Let agents use websites you’re already signed in to in Chrome. You approve each site once."
        title="Chrome"
      />
      <section aria-labelledby="chrome-profiles-title" className="settings-group">
        <h2 className="settings-group__title" id="chrome-profiles-title">
          Connected Chrome
        </h2>
        <div className="card">
          {state === null ? (
            error ? null : (
              <LoadingRows label="Loading Chrome" rows={2} />
            )
          ) : sources.length === 0 ? (
            <div className="card__form chrome-settings__connect">
              <p className="chrome-settings__empty">
                Connect the Chrome profile you’re signed in with. Opensteer asks it for a site’s
                sign-in only after you allow that site.
              </p>
              <ConnectChrome
                client={hostClient}
                environment={environment}
                onConnected={(source) => {
                  toast.success(`Connected ${source.name}.`);
                  void load();
                }}
              />
            </div>
          ) : (
            <>
              {connectedFirst.map((source) => (
                <ChromeProfileRow key={source.id} onChanged={load} source={source} />
              ))}
              <div className="card__form chrome-settings__connect">
                {adding ? (
                  <>
                    <ConnectChrome
                      client={hostClient}
                      environment={environment}
                      onConnected={(source) => {
                        setAdding(false);
                        toast.success(`Connected ${source.name}.`);
                        void load();
                      }}
                    />
                    <button
                      className="btn btn--small btn--ghost chrome-settings__cancel"
                      onClick={() => setAdding(false)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn--small chrome-settings__add"
                    onClick={() => setAdding(true)}
                    type="button"
                  >
                    <Icon name="plus" />
                    Connect another Chrome
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <SettingsError message={error} />
      </section>
      <AllowedSites
        onChanged={load}
        sites={state?.sites ?? null}
        workspaces={snapshot.workspaces}
      />
    </>
  );
}

/* ---- One Chrome profile ---- */

function ChromeProfileRow({
  onChanged,
  source,
}: {
  readonly onChanged: () => Promise<void>;
  readonly source: BrowserSourceSummary;
}) {
  const { hostClient } = useShell();
  const toast = useToast();
  const [mode, setMode] = useState<"view" | "rename" | "disconnect">("view");
  const [draft, setDraft] = useState(source.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const presence = chromeProfilePresence(source);

  useEffect(() => {
    if (mode === "rename") inputRef.current?.select();
    if (mode === "disconnect") confirmRef.current?.focus();
  }, [mode]);

  const close = () => {
    setMode("view");
    setError(null);
    window.requestAnimationFrame(() => renameRef.current?.focus());
  };

  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name || pending) return;
    if (name === source.name) {
      close();
      return;
    }
    setPending(true);
    setError(null);
    void hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey(`browser-source-rename:${source.id}`),
        name,
        sourceId: source.id,
        type: "browser.source.rename",
      })
      .then(onChanged)
      .then(close)
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  };

  const disconnect = () => {
    if (pending) return;
    setPending(true);
    setError(null);
    void hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey(`browser-source-revoke:${source.id}`),
        sourceId: source.id,
        type: "browser.source.revoke",
      })
      .then(() => {
        toast.success(`Disconnected ${source.name}.`);
        return onChanged();
      })
      .catch((reason: unknown) => {
        setError(actionErrorMessage(reason));
        setPending(false);
      });
  };

  return (
    <div className="chrome-profile">
      <div className="card__row">
        <span className="card__row-glyph">
          <Icon name="browser" />
        </span>
        {mode === "rename" ? (
          <form className="chrome-profile__rename" onSubmit={rename}>
            <input
              aria-label={`New name for ${source.name}`}
              className="text-input"
              disabled={pending}
              maxLength={120}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(source.name);
                  close();
                }
              }}
              ref={inputRef}
              value={draft}
            />
            <button className="btn btn--small" onClick={close} type="button">
              Cancel
            </button>
            <button
              className="btn btn--small btn--primary"
              disabled={pending || !draft.trim()}
              type="submit"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </form>
        ) : (
          <>
            <span className="card__row-body">
              <span className="card__row-title">{source.name}</span>
              <span className="card__row-detail chrome-profile__presence">
                <span
                  aria-hidden
                  className={`status-dot ${source.connected ? "status-dot--ok" : "status-dot--muted"}`}
                />
                {presence}
              </span>
            </span>
            <span className="card__row-actions">
              <button
                aria-label={`Rename ${source.name}`}
                className="icon-btn icon-btn--small"
                onClick={() => {
                  setDraft(source.name);
                  setMode("rename");
                }}
                ref={renameRef}
                title="Rename"
                type="button"
              >
                <Icon name="pencil" />
              </button>
              <button
                aria-expanded={mode === "disconnect"}
                className="btn btn--small"
                onClick={() => setMode(mode === "disconnect" ? "view" : "disconnect")}
                type="button"
              >
                Disconnect
              </button>
            </span>
          </>
        )}
      </div>
      {mode === "disconnect" ? (
        <div
          className="chrome-profile__confirm"
          role="group"
          aria-label={`Disconnect ${source.name}`}
        >
          <p>
            Agents stop getting new sign-ins from {source.name}. Browsers already signed in stay
            signed in. You can connect it again anytime.
          </p>
          <div className="chrome-profile__confirm-actions">
            <button className="btn btn--small" onClick={close} type="button">
              Cancel
            </button>
            <button
              className="btn btn--small btn--danger"
              disabled={pending}
              onClick={disconnect}
              ref={confirmRef}
              type="button"
            >
              {pending ? "Disconnecting…" : `Disconnect ${source.name}`}
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="chrome-profile__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ---- Allowed sites ---- */

interface SiteGroup {
  readonly grants: readonly BrowserSiteGrant[];
  readonly lastSignedInAt: string | null;
  readonly site: string;
}

function groupSites(sites: readonly BrowserSiteGrant[]): readonly SiteGroup[] {
  const groups = new Map<string, BrowserSiteGrant[]>();
  for (const grant of sites) groups.set(grant.site, [...(groups.get(grant.site) ?? []), grant]);
  return [...groups.entries()]
    .map(([site, grants]) => ({
      grants,
      lastSignedInAt:
        grants
          .map((grant) => grant.lastSignedInAt)
          .filter((value): value is string => value !== null)
          .sort()
          .at(-1) ?? null,
      site,
    }))
    .sort((left, right) => browserSiteLabel(left.site).localeCompare(browserSiteLabel(right.site)));
}

function AllowedSites({
  onChanged,
  sites,
  workspaces,
}: {
  readonly onChanged: () => Promise<void>;
  readonly sites: readonly BrowserSiteGrant[] | null;
  readonly workspaces: readonly WorkspaceSummary[];
}) {
  const { hostClient } = useShell();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = sites ? groupSites(sites) : [];

  const remove = (grant: BrowserSiteGrant, workspaceName: string) => {
    const key = `${grant.workspaceId}\0${grant.site}`;
    if (pending) return;
    setPending(key);
    setError(null);
    void hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey(`browser-site-remove:${grant.workspaceId}`),
        site: grant.site,
        type: "browser.site.remove",
        workspaceId: grant.workspaceId,
      })
      .then(() => {
        toast.success(`${browserSiteLabel(grant.site)} removed from ${workspaceName}.`);
        return onChanged();
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(null));
  };

  return (
    <section aria-labelledby="chrome-sites-title" className="settings-group">
      <h2 className="settings-group__title" id="chrome-sites-title">
        Allowed sites
      </h2>
      <div className="card">
        {sites === null ? (
          <LoadingRows label="Loading sites" rows={2} />
        ) : groups.length === 0 ? (
          <p className="card__empty chrome-settings__sites-empty">
            No sites yet. The first time an agent needs a site you’re signed in to, it asks you in
            the conversation. Allow it once, and agents in that Workspace can use the site.
          </p>
        ) : (
          <ul className="chrome-sites">
            {groups.map((group) => {
              const domain = browserSiteLabel(group.site);
              return (
                <li className="chrome-site" key={group.site}>
                  <div className="chrome-site__head">
                    <span className="card__row-glyph">
                      <Icon name="globe" />
                    </span>
                    <span className="card__row-body">
                      <span className="card__row-title">{domain}</span>
                      <span className="card__row-detail">
                        {group.lastSignedInAt
                          ? `Last signed in ${relative(group.lastSignedInAt)}`
                          : "Not signed in yet"}
                      </span>
                    </span>
                  </div>
                  <ul
                    aria-label={`Workspaces that can use ${domain}`}
                    className="chrome-site__workspaces"
                  >
                    {group.grants.map((grant) => {
                      const workspace = workspaces.find(({ id }) => id === grant.workspaceId);
                      const name = workspace?.name ?? "Another Workspace";
                      const key = `${grant.workspaceId}\0${grant.site}`;
                      return (
                        <li className="chrome-site__workspace" key={grant.workspaceId}>
                          {workspace ? (
                            <WorkspaceOrb
                              icon={workspace.icon}
                              name={workspace.name}
                              size="tiny"
                              color={workspace.color}
                            />
                          ) : (
                            <Icon name="workspace" />
                          )}
                          <span className="chrome-site__workspace-name">{name}</span>
                          <button
                            aria-label={`Remove ${domain} from ${name}`}
                            className="btn btn--small btn--ghost"
                            disabled={pending !== null}
                            onClick={() => remove(grant, name)}
                            type="button"
                          >
                            {pending === key ? "Removing…" : "Remove"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <SettingsError message={error} />
      <p className="settings-footnote">
        Removing a site stops new sign-ins; browsers already signed in stay signed in. Chrome shares
        a site’s sign-in cookies. Opensteer’s browser can’t use passkeys, so a site that asks for
        one, or relies on this device, may still ask you to sign in.
      </p>
    </section>
  );
}

function relative(value: string): string {
  const ago = formatRelativeTime(value);
  if (ago === "now") return "just now";
  return /\d[mhd]$/u.test(ago) ? `${ago} ago` : `on ${ago}`;
}
