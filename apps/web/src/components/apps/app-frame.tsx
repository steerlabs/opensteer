import {
  appContentHeight,
  appFrameReady,
  appFrameSandbox,
  appFrameScheme,
  type AppTheme,
} from "@opensteer/shared/appFrame";
import { useEffect, useRef, useState } from "react";

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

export function AppFrame({
  fill = false,
  retry,
  theme,
  title,
  url,
}: {
  readonly fill?: boolean;
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
  const sendTheme = () =>
    frame.current?.contentWindow?.postMessage({ type: "opensteer-app:theme", theme }, "*");
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      if (appFrameReady(event.data)) {
        ready.current = true;
        setLoaded(true);
      }
      const height = appContentHeight(event.data);
      if (height !== null && !fill) setHeight(height);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [fill, url]);
  useEffect(sendTheme, [theme]);
  if (failed) return <AppLoadFailure fill={fill} retry={retry} />;
  const parsed = new URL(url);
  const src =
    globalThis.location?.protocol === "app:"
      ? `${appFrameScheme}://view${parsed.pathname}${parsed.search}`
      : url;
  return (
    <div className={fill ? "app-frame app-frame--fill" : "app-frame"}>
      {!loaded ? <AppLoading fill={fill} /> : null}
      <iframe
        ref={frame}
        key={src}
        title={title}
        src={src}
        sandbox={appFrameSandbox}
        referrerPolicy="no-referrer"
        style={fill ? undefined : { height: Math.max(160, Math.min(640, height)) }}
        onError={() => setFailed(true)}
        onLoad={() => {
          if (!ready.current) setFailed(true);
          else sendTheme();
        }}
      />
    </div>
  );
}
