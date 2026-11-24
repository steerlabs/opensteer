import {
  appContentHeight,
  appFrameReady,
  appFrameSandbox,
  appLinkPortMessage,
  appLinkRequest,
  appOriginFrameSandbox,
  isAppOriginUrl,
  appFrameScheme,
  type AppTheme,
} from "@opensteer/shared/appFrame";
import { useEffect, useRef, useState } from "react";
import { useOptionalWorkspace } from "../workspace/workspace-context.js";
import { useToast } from "../toast.js";
import { appLinkLabel, openAppLink, watchAppInput, type AppLinkPlaces } from "./app-links.js";

export function useAppTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(currentTheme);
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
  return theme;
}

function currentTheme(): AppTheme {
  return typeof document !== "undefined" &&
    getComputedStyle(document.documentElement).colorScheme === "light"
    ? "light"
    : "dark";
}

export function AppLoadFailure({
  fill = false,
  retry,
}: {
  readonly fill?: boolean;
  readonly retry: () => void;
}) {
  return fill ? (
    <div className="place-state" role="alert">
      <p className="place-state__title">Could not load this app</p>
      <button className="btn" onClick={retry} type="button">
        Try again
      </button>
    </div>
  ) : (
    <p role="alert">
      Could not load this app.{" "}
      <button className="btn btn--small" type="button" onClick={retry}>
        Retry
      </button>
    </p>
  );
}

export function AppLoading({ fill = false }: { readonly fill?: boolean }) {
  return fill ? (
    <div aria-busy className="place-state app-frame__cover" role="status">
      <p className="place-state__title">Loading app…</p>
    </div>
  ) : (
    <p className="app-frame__status" role="status">
      Loading app…
    </p>
  );
}

/**
 * Where links out of an app go from here: the workspace's own opener, and a
 * question in Opensteer's toasts when this page cannot tell a press was in the
 * app. Read through a ref, so a port given to a document keeps the latest.
 */
export function useAppLinkPlaces(inWorkspace = true): { readonly current: AppLinkPlaces } {
  const found = useOptionalWorkspace();
  const workspace = inWorkspace ? found : null;
  const toast = useToast();
  const places = useRef<AppLinkPlaces>({ open: null, ask: () => undefined });
  places.current = {
    open: workspace?.openWebLink ?? null,
    ask: (url, open) =>
      toast.success(`This app wants to open ${appLinkLabel(url)}`, { label: "Open", run: open }),
  };
  useEffect(watchAppInput, []);
  return places;
}

export function AppFrame({
  fill = false,
  retry,
  theme,
  title,
  url,
  workspaceLinks = true,
}: {
  readonly fill?: boolean;
  /**
   * False where the workspace cannot show the tab a link would open (a dialog
   * over Settings, which fills the window): links go to the person's browser.
   */
  readonly workspaceLinks?: boolean;
  readonly retry: () => void;
  readonly theme: AppTheme;
  readonly title: string;
  readonly url: string;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(280);
  const ready = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const origin = isAppOriginUrl(url) ? new URL(url).origin : "null";
  const linkPlaces = useAppLinkPlaces(workspaceLinks);
  const sendTheme = () =>
    frame.current?.contentWindow?.postMessage(
      { type: "opensteer-app:theme", theme },
      origin === "null" ? "*" : origin,
    );
  // Each document the frame loads gets its own port when it says it is ready, kept for the
  // frame's life so a re-run listener never strands the port a document already holds.
  const ports = useRef<MessagePort[]>([]);
  useEffect(
    () => () => {
      for (const port of ports.current.splice(0)) port.close();
    },
    [],
  );
  useEffect(() => {
    const givePort = (target: Window) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent) => {
        const link = appLinkRequest(event.data);
        if (link !== null)
          openAppLink(link, linkPlaces.current, { kind: "frame", frame: frame.current });
      };
      ports.current.push(channel.port1);
      // A document keeps the first port it is given, and says it is ready once; only an app
      // repeating that itself could reach this bound, and only its own links stop.
      while (ports.current.length > 32) ports.current.shift()!.close();
      target.postMessage({ type: appLinkPortMessage }, origin === "null" ? "*" : origin, [
        channel.port2,
      ]);
    };
    const receive = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || event.origin !== origin) return;
      if (appFrameReady(event.data)) {
        ready.current = true;
        setLoaded(true);
        setFailed(false);
        givePort(target);
      }
      const height = appContentHeight(event.data);
      if (height !== null && !fill) setHeight(height);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [fill, url, origin]);
  useEffect(sendTheme, [theme]);
  const parsed = new URL(url);
  const src =
    origin === "null" && globalThis.location?.protocol === "app:"
      ? `${appFrameScheme}://view${parsed.pathname}${parsed.search}`
      : url;
  return (
    <div className={fill ? "app-frame app-frame--fill" : "app-frame"}>
      {failed ? (
        <AppLoadFailure fill={fill} retry={retry} />
      ) : !loaded ? (
        <AppLoading fill={fill} />
      ) : null}
      <iframe
        ref={frame}
        key={src}
        title={title}
        src={src}
        sandbox={origin === "null" ? appFrameSandbox : appOriginFrameSandbox}
        referrerPolicy="no-referrer"
        style={{
          ...(fill ? {} : { height: Math.max(160, Math.min(640, height)) }),
          ...(failed ? { display: "none" } : {}),
        }}
        onError={() => setFailed(true)}
        onLoad={() => {
          if (!ready.current) setFailed(true);
          else sendTheme();
        }}
      />
    </div>
  );
}
