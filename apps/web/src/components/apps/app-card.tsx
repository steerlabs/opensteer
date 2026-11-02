import { useAppView } from "@opensteer/client/react";
import type { AppEntry, HostClient } from "@opensteer/client/host";
import {
  appContentHeight,
  appFrameSandbox,
  appFrameScheme,
  type AppTheme,
} from "@opensteer/shared/appFrame";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { AttachmentReader } from "../attachments/message-attachments.js";
import { Dialog } from "../dialog.js";

export function AppCard({ entry }: { readonly entry: AppEntry }) {
  const client = useContext(AttachmentReader);
  const card = useRef<HTMLElement | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(currentTheme);
  const titleId = useId();
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
    <section className="app-card" ref={card} aria-label={title}>
      <header className="app-card__header">
        <span>{title}</span>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => setOpen(true)}
          disabled={!view}
        >
          Open
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
        <AppFrame key={view.url} url={view.url} title={title} theme={theme} retry={retry} />
      ) : (
        <p role="status">{client ? "Loading app…" : "App unavailable"}</p>
      )}
      {open && view ? (
        <Dialog title={title} labelledBy={titleId} fullScreen onClose={() => setOpen(false)}>
          <FullscreenApp client={client} appId={entry.appId} theme={theme} />
        </Dialog>
      ) : null}
    </section>
  );
}

function FullscreenApp({
  client,
  appId,
  theme,
}: {
  readonly client: HostClient | null;
  readonly appId: string;
  readonly theme: AppTheme;
}) {
  const { view, failed, retry } = useAppView(client, appId, theme);
  return view ? (
    <AppFrame
      key={view.url}
      url={view.url}
      title={view.app.title}
      theme={theme}
      retry={retry}
      fullScreen
    />
  ) : failed ? (
    <p role="alert">
      Could not load this app.{" "}
      <button type="button" onClick={retry}>
        Retry
      </button>
    </p>
  ) : (
    <p role="status">Loading app…</p>
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
}: {
  readonly url: string;
  readonly title: string;
  readonly theme: AppTheme;
  readonly retry: () => void;
  readonly fullScreen?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(280);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const sendTheme = () =>
    frame.current?.contentWindow?.postMessage({ type: "opensteer-app:theme", theme }, "*");
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const height = appContentHeight(event.data);
      if (height !== null) {
        setHeight(height);
        setLoaded(true);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [url]);
  useEffect(sendTheme, [theme]);
  if (failed)
    return (
      <p role="alert">
        Could not load this app.{" "}
        <button type="button" onClick={retry}>
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
        loading="lazy"
        referrerPolicy="no-referrer"
        style={fullScreen ? undefined : { height: Math.max(160, Math.min(640, height)) }}
        onError={() => setFailed(true)}
        onLoad={() => {
          setLoaded(true);
          sendTheme();
        }}
      />
    </div>
  );
}
