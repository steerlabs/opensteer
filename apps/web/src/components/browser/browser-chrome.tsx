import {
  startPageIndex,
  webSearchUrl,
  type BrowserIdentityChoice,
  type HostClient,
} from "@opensteer/client/host";
import { useHostSelector, usePlaceList } from "@opensteer/client/react";
import { useOptionalWorkspace } from "../workspace/workspace-context.js";
import { OmniboxResults, useOmnibox } from "./omnibox.js";
export { normalizeNavigationInput } from "@opensteer/client/host";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  browserSiteForUrl,
  browserSiteLabel,
  browserTabTitle,
  type BrowserTabSummary,
} from "@opensteer/client/host";
import { Icon } from "../icon.js";
import { useToastToolbar } from "../toast.js";

/**
 * The page's one row, laid out as a browser's toolbar: the drawer's button
 * where there is one (`leading`), back, forward, reload (Stop while the page
 * loads), the address, and then who is in the page and its own actions
 * (`trailing`). On a phone the navigation buttons move into the page's menu,
 * and the row names the page — its title over its site — until a tap asks
 * for the address.
 */
export function BrowserToolbar({
  activeTab,
  canGoBack,
  canGoForward,
  chip = null,
  compact = false,
  disabled,
  focusAddress = false,
  find = null,
  notice = null,
  leading,
  loading = false,
  mark = null,
  omnibox,
  onBack,
  onForward,
  onNavigate,
  onNavigated,
  onReload,
  onStop,
  trailing,
}: {
  activeTab: BrowserTabSummary | undefined;
  canGoBack?: boolean | undefined;
  canGoForward?: boolean | undefined;
  /** Who the page browses as, first in the address: its profile chip. */
  chip?: ReactNode;
  compact?: boolean;
  disabled: boolean;
  /** A blank page: the address takes the keyboard as it appears. */
  focusAddress?: boolean;
  find?: BrowserFindControls | null;
  notice?: ReactNode;
  leading?: ReactNode;
  /** The page is loading: Reload becomes Stop. */
  loading?: boolean;
  /** The site's icon at the start of the address. */
  mark?: ReactNode;
  omnibox: { readonly hostClient: HostClient; readonly choice: BrowserIdentityChoice };
  onBack: () => void;
  onForward: () => void;
  onNavigate: (url: string, typed?: boolean) => void;
  /** After Enter: where the keyboard goes, as a browser hands it to the page. */
  onNavigated?: () => void;
  onReload: () => void;
  onStop?: () => void;
  trailing?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const toolbarRef = useToastToolbar();
  const url = activeTab?.url ?? "";
  // A page with no address yet has nothing to name: the address is the point.
  const named =
    compact && !editing && activeTab !== undefined && url !== "" && url !== "about:blank";
  return (
    <div
      ref={toolbarRef}
      className={
        compact
          ? "browser-toolbar browser-toolbar--compact surface-row"
          : "browser-toolbar surface-row"
      }
    >
      {leading}
      {compact ? null : (
        <div className="browser-controls">
          <button
            aria-label="Go back"
            disabled={disabled || canGoBack === false}
            onClick={onBack}
            title="Back"
            type="button"
          >
            <Icon name="arrow-left" />
          </button>
          <button
            aria-label="Go forward"
            disabled={disabled || canGoForward === false}
            onClick={onForward}
            title="Forward"
            type="button"
          >
            <Icon name="arrow-right" />
          </button>
          {/* One button that changes, as a browser's does, so focus stays on it. */}
          <button
            aria-label={loading && onStop ? "Stop loading" : "Reload page"}
            disabled={disabled}
            onClick={loading && onStop ? onStop : onReload}
            title={loading && onStop ? "Stop" : "Reload"}
            type="button"
          >
            <Icon name={loading && onStop ? "close" : "reload"} />
          </button>
        </div>
      )}
      {named ? (
        <>
          {chip}
          <BrowserPageName onEdit={disabled ? null : () => setEditing(true)} tab={activeTab} />
        </>
      ) : (
        <BrowserAddress
          chip={chip}
          omnibox={omnibox}
          loading={loading}
          disabled={disabled}
          focusOnMount={editing || focusAddress}
          key={activeTab?.id ?? "no-active-tab"}
          mark={mark}
          onDone={compact ? () => setEditing(false) : null}
          onNavigate={onNavigate}
          onNavigated={onNavigated ?? null}
          tabId={activeTab?.id ?? null}
          url={url}
        />
      )}
      {find ? <BrowserFind controls={find} /> : null}
      {notice ? (
        <div className="browser-notice" role="status">
          {notice}
        </div>
      ) : null}
      {trailing}
    </div>
  );
}

/** A phone's row: the page's title over its site, the address a tap away. */
function BrowserPageName({ onEdit, tab }: { onEdit: (() => void) | null; tab: BrowserTabSummary }) {
  const title = browserTabTitle(tab);
  const site = browserSiteForUrl(tab.url);
  const siteLabel = site ? browserSiteLabel(site) : null;
  return (
    <button
      aria-label={`${[title, siteLabel].filter(Boolean).join(", ")}. Show the address`}
      className="browser-page-name"
      disabled={onEdit === null}
      onClick={onEdit ?? undefined}
      type="button"
    >
      <span className="browser-page-name__text">
        <span className="browser-page-name__title">{title}</span>
        {siteLabel && siteLabel !== title ? (
          <span className="browser-page-name__site">{siteLabel}</span>
        ) : null}
      </span>
    </button>
  );
}

/* ---- Address bar ---- */

function BrowserAddress({
  chip,
  disabled,
  focusOnMount,
  loading,
  mark,
  omnibox,
  onDone,
  onNavigate,
  onNavigated,
  tabId,
  url,
}: {
  chip: ReactNode;
  disabled: boolean;
  focusOnMount: boolean;
  loading: boolean;
  mark: ReactNode;
  omnibox: { readonly hostClient: HostClient; readonly choice: BrowserIdentityChoice };
  onDone: (() => void) | null;
  onNavigate: (url: string, typed?: boolean) => void;
  onNavigated: (() => void) | null;
  tabId: string | null;
  url: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLFormElement>(null);
  const workspace = useOptionalWorkspace();
  const snapshot = useHostSelector(omnibox.hostClient, (value) => value);
  const places = usePlaceList(omnibox.hostClient);
  const index = useMemo(
    () => startPageIndex({ snapshot, places, choice: omnibox.choice }),
    [snapshot, places, omnibox.choice],
  );
  const pageValue = url === "about:blank" ? "" : url;
  const controller = useOmnibox({
    hostClient: omnibox.hostClient,
    index,
    choice: omnibox.choice,
    inputRef,
    pageValue,
    loading,
    includeApps: false,
    onChoose: (row) => {
      const action = row.action;
      if (!row.available) return;
      if (action.kind === "switch-to-place")
        workspace?.nav.beginPlaceOperation()(action.destination);
      else if (action.kind === "open-url" || action.kind === "search-web") {
        onNavigate(
          action.kind === "open-url" ? action.url : webSearchUrl(action.query),
          row.kind === "address",
        );
        onNavigated?.();
      }
    },
    onFocusPage: () => onNavigated?.(),
  });
  const parts = !controller.focused && !controller.dirty ? addressParts(pageValue) : null;
  const lastFocusedTab = useRef<string | null>(null);
  useEffect(() => {
    if (disabled || !tabId || lastFocusedTab.current === tabId) return;
    lastFocusedTab.current = tabId;
    if (url === "about:blank" || focusOnMount) inputRef.current?.focus();
  }, [disabled, focusOnMount, tabId, url]);
  return (
    <form
      ref={anchor}
      className={chip ? "browser-address browser-address--chip" : "browser-address"}
      onSubmit={(event) => {
        event.preventDefault();
        controller.submit();
      }}
    >
      {chip}
      {mark ? (
        <span aria-hidden className="browser-address__mark">
          {mark}
        </span>
      ) : null}
      <span className="browser-address__field">
        <input
          {...controller.inputProps}
          aria-label="Search or enter address"
          className={parts ? "is-dressed" : undefined}
          disabled={disabled}
          onBlur={(event) => {
            controller.inputProps.onBlur?.(event);
            onDone?.();
          }}
          placeholder="Search or enter address"
          ref={inputRef}
        />
        {parts ? (
          <span aria-hidden className="browser-address__display">
            <span className="browser-address__host">{parts.host}</span>
            <span className="browser-address__rest">{parts.rest}</span>
          </span>
        ) : null}
      </span>
      {controller.dirty && !controller.submitting && controller.value !== pageValue ? (
        <button
          aria-label="Go"
          className="browser-address__go"
          onPointerDown={(event) => event.preventDefault()}
          type="submit"
        >
          <Icon name="arrow-right" />
        </button>
      ) : null}
      <OmniboxResults controller={controller} hostClient={omnibox.hostClient} anchor={anchor} />
    </form>
  );
}

/** A web address as a person reads it: the site, without `www.`, then everything after it. */
function addressParts(url: string): { readonly host: string; readonly rest: string } | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
    let readable = rest;
    try {
      readable = decodeURI(rest);
    } catch {
      // An address that does not decode is shown as it is.
    }
    return { host: parsed.host.replace(/^www\./i, ""), rest: readable };
  } catch {
    return null;
  }
}

export interface BrowserFindControls {
  readonly query: string;
  readonly activeMatch: number;
  readonly matches: number;
  readonly onQuery: (query: string) => void;
  readonly onStep: (forward: boolean) => void;
  readonly onClose: () => void;
}
function BrowserFind({ controls }: { readonly controls: BrowserFindControls }) {
  return (
    <form
      className={`browser-address browser-find${controls.query && controls.matches === 0 ? " has-no-match" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        controls.onStep(true);
      }}
    >
      <span aria-hidden className="browser-address__mark">
        <Icon name="search" />
      </span>
      <input
        aria-label="Find in page"
        autoFocus
        maxLength={1000}
        value={controls.query}
        onChange={(event) => controls.onQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            controls.onClose();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            controls.onStep(!event.shiftKey);
          }
        }}
      />
      <span aria-live="polite" className="browser-find__count">
        {controls.query ? `${controls.activeMatch}/${controls.matches}` : ""}
      </span>
      <button
        aria-label="Previous match"
        disabled={!controls.query || !controls.matches}
        onClick={() => controls.onStep(false)}
        type="button"
      >
        <Icon name="arrow-up" />
      </button>
      <button
        aria-label="Next match"
        disabled={!controls.query || !controls.matches}
        onClick={() => controls.onStep(true)}
        type="button"
      >
        <span className="browser-find__down">
          <Icon name="arrow-up" />
        </span>
      </button>
      <button aria-label="Close find" onClick={controls.onClose} type="button">
        <Icon name="close" />
      </button>
    </form>
  );
}
