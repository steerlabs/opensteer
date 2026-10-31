import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type InputHTMLAttributes,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  inlineAutocomplete,
  parseNavigationInput,
  startPageResults,
  unwrapRpcResult,
  type BrowserIdentityChoice,
  type HostClient,
  type StartPageIndex,
  type StartPageResult,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { computerNotReadyStatus } from "@opensteer/client/integrations";
import { NativeBrowserOverlay } from "../native-browser-overlays.js";
import { Icon } from "../icon.js";
import { SiteMark } from "../site-mark.js";
import { useToast } from "../toast.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { PlaceMark } from "../workspace/place-mark.js";
import { AppMark } from "../computer-apps/computer-use-section.js";

const requestClocks = new WeakMap<HostClient, { at: number }>();
export function omniboxChoosable(row: StartPageResult): boolean {
  return !row.notReady || computerNotReadyStatus(row.notReady).tone === "attention";
}

export function useOmnibox(options: {
  readonly hostClient: HostClient;
  readonly index: StartPageIndex;
  readonly choice: BrowserIdentityChoice;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly initialValue?: string;
  readonly historyActive?: boolean;
  readonly pageValue?: string;
  readonly loading?: boolean;
  readonly includeApps?: boolean;
  readonly onChoose: (row: StartPageResult) => void;
  readonly onFocusPage: () => void;
  readonly onEdit?: () => void;
  readonly onEmptyDown?: () => void;
}) {
  const { hostClient, inputRef, index, choice } = options;
  const toast = useToast();
  const listId = useId();
  const scope = useHostSelector(
    hostClient,
    (snapshot) =>
      `${snapshot.deploymentId}:${snapshot.user?.id}:${snapshot.searchSuggestionsAvailable === true}:${snapshot.connection}`,
  );
  const viewer = useHostSelector(hostClient, (snapshot) =>
    JSON.stringify([snapshot.deploymentId, snapshot.user?.id, snapshot.session]),
  );
  const [raw, setRaw] = useState(options.initialValue ?? options.pageValue ?? "");
  const [completion, setCompletion] = useState<string | null>(null);
  const completionUrl = useRef<string | null>(null);
  const [highlight, setHighlight] = useState<StartPageResult | null>(null);
  const [frozen, setFrozen] = useState<readonly StartPageResult[] | null>(null);
  const [open, setOpen] = useState(!!options.initialValue);
  const [focused, setFocused] = useState(false);
  const [dirty, setDirty] = useState(!!options.initialValue);
  useSyncExternalStore(hostClient.browserHistory.subscribe, hostClient.browserHistory.getRevision);
  const [provider, setProvider] = useState<{ query: string; rows: readonly string[] }>({
    query: "",
    rows: [],
  });
  const composing = useRef(false);
  const suppress = useRef(false);
  const pointer = useRef<{ x: number; y: number; select: boolean; dragged: boolean } | null>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const submitted = useRef<{ url: string | undefined; loading: boolean } | null>(null);
  const pageValue = options.pageValue ?? "";
  const profileId = choice.kind === "profile" ? choice.profileId : null;
  // Completions and rows came from one identity's history; another identity
  // keeps only what the person typed.
  const identityKey = JSON.stringify([viewer, profileId]);
  const [rowsIdentity, setRowsIdentity] = useState(identityKey);
  if (rowsIdentity !== identityKey) {
    setRowsIdentity(identityKey);
    setCompletion(null);
    setHighlight(null);
    setFrozen(null);
  }
  const historyActive = options.historyActive === true || focused;
  useEffect(() => {
    if (historyActive) void hostClient.browserHistory.load(profileId);
  }, [hostClient, profileId, historyActive, viewer]);
  const history = hostClient.browserHistory.entries(profileId);
  const historyUrls = new Set(history.map((entry) => entry.url));
  const retained = (row: StartPageResult) => !row.historyUrl || historyUrls.has(row.historyUrl);
  // Freeze ordering, but never retain history that another device removed.
  if (frozen?.some((row) => !retained(row))) {
    const remaining = frozen.filter(retained);
    setFrozen(remaining.length ? remaining : null);
  }
  if (highlight && !retained(highlight)) setHighlight(null);
  if (completion && completionUrl.current && !historyUrls.has(completionUrl.current))
    setCompletion(null);
  const rows =
    frozen ??
    startPageResults(index, {
      query: raw,
      choice,
      history,
      suggestions: provider.query === raw ? provider.rows : [],
      completion,
      includeApps: options.includeApps ?? false,
    });
  const active = highlight ?? rows[0] ?? null;
  const visible = focused && open && rows.length > 0;
  const historyIcons = new Map(
    (visible ? rows : []).flatMap((row) =>
      row.historyUrl
        ? [
            [
              row.historyUrl,
              hostClient.browserHistory.icon(
                profileId,
                hostClient.browserHistory.iconRef(profileId, row.historyUrl),
              ),
            ] as const,
          ]
        : [],
    ),
  );
  const value = highlight?.fillText ?? completion ?? (dirty ? raw : pageValue);

  useLayoutEffect(() => {
    const range = selection.current;
    if (!range) return;
    selection.current = null;
    inputRef.current?.setSelectionRange(range.start, range.end);
  });
  useEffect(() => {
    const pending = submitted.current;
    if (pending) {
      if (options.loading) pending.loading = true;
      if (pageValue === pending.url && !(pending.loading && !options.loading)) return;
      submitted.current = null;
    } else if (dirty) return;
    setRaw(pageValue);
    setDirty(false);
    setCompletion(null);
    setHighlight(null);
    setFrozen(null);
    setOpen(false);
  }, [pageValue, options.loading]);

  useEffect(() => {
    const parsed = parseNavigationInput(raw);
    const snapshot = hostClient.getSnapshot();
    if (
      !focused ||
      !open ||
      composing.current ||
      !snapshot.searchSuggestionsAvailable ||
      !hostClient.browserPreferences.showSearchSuggestions ||
      parsed.kind !== "search" ||
      parsed.query.length > 200
    )
      return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const clock = requestClocks.get(hostClient) ?? { at: -Infinity };
    requestClocks.set(hostClient, clock);
    const request = () => {
      const remaining = 100 - (performance.now() - clock.at);
      if (remaining > 0) {
        timer = setTimeout(request, Math.ceil(remaining));
        return;
      }
      if (!current || composing.current || !hostClient.browserPreferences.showSearchSuggestions)
        return;
      clock.at = performance.now();
      void hostClient.rpc["browser.searchSuggestions.get"]({ query: parsed.query })
        .then((result) => {
          if (current) setProvider({ query: raw, rows: unwrapRpcResult(result) });
        })
        .catch(() => {
          if (current) setProvider({ query: raw, rows: [] });
        });
    };
    timer = setTimeout(request, Math.max(0, Math.ceil(100 - (performance.now() - clock.at))));
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [hostClient, raw, focused, open, scope]);

  function setText(text: string) {
    options.onEdit?.();
    submitted.current = null;
    setRaw(text);
    setDirty(true);
    setCompletion(null);
    setHighlight(null);
    setFrozen(null);
    setOpen(!!text.trim());
  }
  function choose(row: StartPageResult) {
    if (
      row.historyUrl &&
      !hostClient.browserHistory.entries(profileId).some((entry) => entry.url === row.historyUrl)
    )
      return;
    // An offline computer's row says why it can't open; choosing it changes nothing.
    if (!omniboxChoosable(row)) return;
    const text = row.fillText ?? row.title;
    setRaw(text);
    setDirty(true);
    setCompletion(null);
    setHighlight(null);
    setFrozen(null);
    setOpen(false);
    submitted.current =
      options.pageValue !== undefined &&
      row.available &&
      (row.action.kind === "open-url" || row.action.kind === "search-web")
        ? { url: options.pageValue, loading: options.loading === true }
        : null;
    options.onChoose(row);
  }
  function remove(row: StartPageResult) {
    if (!row.historyUrl) return;
    void hostClient.browserHistory
      .remove(profileId, row.historyUrl)
      .catch((error: unknown) => toast.error(actionErrorMessage(error)));
    setHighlight(null);
    setFrozen(null);
    setCompletion(null);
  }
  const inputProps: InputHTMLAttributes<HTMLInputElement> = {
    role: "combobox",
    "aria-autocomplete": "both",
    "aria-expanded": visible,
    "aria-controls": visible ? listId : undefined,
    "aria-activedescendant":
      visible && active ? `${listId}-${encodeURIComponent(active.key)}` : undefined,
    value,
    autoComplete: "off",
    autoCapitalize: "off",
    autoCorrect: "off",
    spellCheck: false,
    onChange: (event) => {
      const input = event.currentTarget;
      const text = input.value;
      const inputType = (event.nativeEvent as InputEvent).inputType ?? "";
      const eligible =
        !composing.current &&
        !suppress.current &&
        !inputType.startsWith("delete") &&
        inputType !== "insertFromPaste" &&
        input.selectionStart === text.length &&
        input.selectionEnd === text.length;
      setText(text);
      const completed = eligible ? inlineAutocomplete(text, history) : null;
      completionUrl.current = completed
        ? (history.find((entry) => inlineAutocomplete(text, [entry]) === completed)?.url ?? null)
        : null;
      setCompletion(completed);
      if (completed) selection.current = { start: text.length, end: completed.length };
      suppress.current = false;
    },
    onPaste: () => {
      suppress.current = true;
    },
    onCompositionStart: () => {
      composing.current = true;
      setCompletion(null);
    },
    onCompositionEnd: () => {
      composing.current = false;
      suppress.current = true;
    },
    onSelect: (event) => {
      if (
        completion &&
        (event.currentTarget.selectionStart !== raw.length ||
          event.currentTarget.selectionEnd !== completion.length)
      ) {
        setRaw(completion);
        setCompletion(null);
      }
    },
    onFocus: (event) => {
      setFocused(true);
      if (!pointer.current) event.currentTarget.select();
    },
    onBlur: () => {
      setFocused(false);
      setOpen(false);
      setHighlight(null);
      setFrozen(null);
      if (raw === pageValue && !submitted.current) setDirty(false);
    },
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      pointer.current = {
        x: event.clientX,
        y: event.clientY,
        select: !(document.hasFocus() && document.activeElement === event.currentTarget),
        dragged: false,
      };
      setFocused(true);
    },
    onPointerMove: (event) => {
      const press = pointer.current;
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4)
        press.dragged = true;
    },
    onPointerUp: (event) => {
      const press = pointer.current;
      pointer.current = null;
      if (press?.select && !press.dragged && event.detail < 2) event.currentTarget.select();
    },
    onPointerCancel: () => {
      pointer.current = null;
    },
    onKeyDown: (event) => {
      if (event.nativeEvent.isComposing || composing.current) return;
      const input = event.currentTarget;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (highlight) {
          setHighlight(null);
          setFrozen(null);
          setCompletion(null);
          selection.current = { start: raw.length, end: raw.length };
        } else if (open) {
          setOpen(false);
          setCompletion(null);
        } else if (dirty && raw !== pageValue) {
          setText(pageValue);
          setDirty(false);
          setOpen(false);
          selection.current = { start: 0, end: pageValue.length };
        } else {
          input.blur();
          options.onFocusPage();
        }
      } else if (event.key === "Delete" && event.shiftKey && active?.historyUrl) {
        event.preventDefault();
        event.stopPropagation();
        remove(active);
      } else if (
        (event.key === "Backspace" || event.key === "Delete") &&
        completion &&
        input.selectionStart === raw.length &&
        input.selectionEnd === completion.length
      ) {
        event.preventDefault();
        setCompletion(null);
        selection.current = { start: raw.length, end: raw.length };
      } else if ((event.key === "ArrowRight" || event.key === "End") && completion) {
        event.preventDefault();
        setRaw(completion);
        setCompletion(null);
        selection.current = { start: completion.length, end: completion.length };
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!rows.length) {
          if (event.key === "ArrowDown") options.onEmptyDown?.();
          return;
        }
        setOpen(true);
        setCompletion(null);
        setFrozen(rows);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const from = active ? rows.indexOf(active) : 0;
        for (let offset = 1; offset <= rows.length; offset++) {
          const row = rows[(((from + step * offset) % rows.length) + rows.length) % rows.length]!;
          if (omniboxChoosable(row)) {
            setHighlight(row);
            const text = row.fillText ?? row.title;
            selection.current = { start: text.length, end: text.length };
            break;
          }
        }
      } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (active) choose(active);
      }
    },
  };
  return {
    inputProps,
    submitting: submitted.current !== null,
    raw,
    value,
    dirty,
    focused,
    visible,
    rows,
    historyIcons,
    active,
    listId,
    setText,
    choose,
    remove,
    point: (row: StartPageResult) => {
      if (omniboxChoosable(row)) {
        setHighlight(row);
        setCompletion(null);
        setFrozen(rows);
      }
    },
    submit: () => {
      if (active && !composing.current) choose(active);
    },
  };
}

export type OmniboxController = ReturnType<typeof useOmnibox>;
export function OmniboxResults({
  controller,
  hostClient,
  anchor,
  pending,
}: {
  readonly controller: OmniboxController;
  readonly hostClient: HostClient;
  readonly anchor?: RefObject<HTMLElement | null>;
  readonly pending?: string | null;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!controller.visible || !anchor) return;
    const update = () => setRect(anchor.current?.getBoundingClientRect() ?? null);
    update();
    const observer = new ResizeObserver(update);
    if (anchor.current) observer.observe(anchor.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, controller.visible]);
  if (!controller.visible) return null;
  const list = (
    <ul
      aria-label="Results"
      className={
        anchor
          ? "start-page__results omnibox-results omnibox-results--toolbar"
          : "start-page__results omnibox-results"
      }
      id={controller.listId}
      role="listbox"
      style={
        anchor && rect
          ? { position: "fixed", left: rect.left, top: rect.bottom + 4, width: rect.width }
          : undefined
      }
      onPointerDown={(event) => event.preventDefault()}
    >
      {controller.rows.map((row) => (
        <li
          key={row.key}
          id={`${controller.listId}-${encodeURIComponent(row.key)}`}
          role="option"
          aria-selected={row === controller.active}
          aria-disabled={!omniboxChoosable(row) || (!row.available && !row.notReady) || undefined}
          data-history-url={row.historyUrl}
          className={`start-result${row === controller.active ? " is-active" : ""}${row.available ? "" : " is-unavailable"}${omniboxChoosable(row) ? "" : " is-inert"}`}
          onClick={() => controller.choose(row)}
          onPointerMove={() => controller.point(row)}
        >
          <span aria-hidden className="start-result__mark">
            {pending === row.key ? (
              <span className="spinner" />
            ) : row.kind === "search" ? (
              <Icon name="search" />
            ) : row.kind === "address" ? (
              <Icon name="globe" />
            ) : row.kind === "phone" ? (
              <Icon name="phone" />
            ) : row.kind === "app" && row.app?.target.kind === "app" ? (
              <AppMark
                iconPng={row.app.iconPng ?? undefined}
                identity={row.app.target.app}
                machineId={row.app.machineId}
              />
            ) : row.place ? (
              <PlaceMark hostClient={hostClient} icon={row.place.icon} />
            ) : (
              <SiteMark favicon={controller.historyIcons.get(row.historyUrl ?? "") ?? null} />
            )}
          </span>
          <span className="start-result__text">
            <span className="start-result__title">{row.title}</span>
            {row.detail ? <span className="start-result__detail">{row.detail}</span> : null}
          </span>
          <span className="start-result__action">{row.label}</span>
          {row === controller.active ? (
            <kbd aria-hidden className="start-result__enter">
              ↵
            </kbd>
          ) : null}
        </li>
      ))}
    </ul>
  );
  return anchor
    ? createPortal(<NativeBrowserOverlay>{rect ? list : null}</NativeBrowserOverlay>, document.body)
    : list;
}
