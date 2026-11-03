import { useAppView } from "@opensteer/client/react";
import type { AppEntry } from "@opensteer/client/host";
import {
  appContentHeight,
  appFrameReady,
  appFrameSandbox,
  appFrameScheme,
  type AppTheme,
} from "@opensteer/shared/appFrame";
import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { TranscriptHostClientContext } from "../attachments/message-attachments.js";
import { handleModalKeyDown } from "../dialog.js";
import { useNativeBrowserOverlay } from "../native-browser-overlays.js";

export function AppCard({ entry }: { readonly entry: AppEntry }) {
  const client = useContext(TranscriptHostClientContext);
  const card = useRef<HTMLElement | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(currentTheme);
  const titleId = useId();
  const toggle = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useNativeBrowserOverlay(open);
  useEffect(() => {
    if (!open) return;
    const opener = toggle.current;
    toggle.current?.focus();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !card.current?.contains(event.target))
        toggle.current?.focus();
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      opener?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (near || !card.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [near]);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    const changed = () => setTheme(currentTheme());
    query?.addEventListener("change", changed);
    return () => {
      observer.disconnect();
      query?.removeEventListener("change", changed);
    };
  }, []);
  const { view, failed, retry } = useAppView(client, entry.appId, theme, near);
  const title = view?.app.title ?? entry.title;
  return (
    <section
      className={open ? "app-card app-card--full" : "app-card"}
      ref={card}
      role={open ? "dialog" : undefined}
      aria-modal={open ? true : undefined}
      aria-labelledby={titleId}
      onKeyDown={open ? (event) => handleModalKeyDown(event, card.current, close) : undefined}
    >
      <header className="app-card__header">
        <span id={titleId}>{title}</span>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          ref={toggle}
          onClick={() => setOpen((value) => !value)}
          disabled={!view && !open}
        >
          {open ? "Close" : "Open"}
        </button>
      </header>
      {failed ? (
        <p role="alert">
          Could not load this app.{" "}
          <button type="button" onClick={retry}>
            Retry
          </button>
        </p>
      ) : view ? (
        <AppFrame
          key={view.url}
          url={view.url}
          title={title}
          theme={theme}
          retry={retry}
          fullScreen={open}
          onEscape={close}
        />
      ) : (
        <p role="status">{client ? "Loading app…" : "App unavailable"}</p>
      )}
    </section>
  );
}

function currentTheme(): AppTheme {
  return typeof document !== "undefined" &&
    getComputedStyle(document.documentElement).colorScheme === "light"
    ? "light"
    : "dark";
}

function AppFrame({
  url,
  title,
  theme,
  retry,
  fullScreen = false,
  onEscape,
}: {
  readonly url: string;
  readonly title: string;
  readonly theme: AppTheme;
  readonly retry: () => void;
  readonly fullScreen?: boolean;
  readonly onEscape: () => void;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(280);
  const ready = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const sendTheme = () =>
    frame.current?.contentWindow?.postMessage({ type: "opensteer-app:theme", theme }, "*");
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      if (appFrameReady(event.data)) {
        ready.current = true;
        setLoaded(true);
      }
      if (event.data?.type === "opensteer-app:escape") onEscape();
      const height = appContentHeight(event.data);
      if (height !== null) {
        setHeight(height);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [url, onEscape]);
  useEffect(sendTheme, [theme]);
  if (failed)
    return (
      <p role="alert">
        Could not load this app.{" "}
        <button className="btn btn--small" type="button" onClick={retry}>
          Retry
        </button>
      </p>
    );
  const parsed = new URL(url);
  const src =
    globalThis.location?.protocol === "app:"
      ? `${appFrameScheme}://view${parsed.pathname}${parsed.search}`
      : url;
  return (
    <div className={fullScreen ? "app-frame app-frame--full" : "app-frame"}>
      {!loaded ? (
        <p className="app-frame__status" role="status">
          Loading app…
        </p>
      ) : null}
      <iframe
        ref={frame}
        key={src}
        title={title}
        src={src}
        sandbox={appFrameSandbox}
        referrerPolicy="no-referrer"
        style={fullScreen ? undefined : { height: Math.max(160, Math.min(640, height)) }}
        onError={() => setFailed(true)}
        onLoad={() => {
          if (!ready.current) setFailed(true);
          else sendTheme();
        }}
      />
    </div>
  );
}
