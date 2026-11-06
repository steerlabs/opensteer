import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import type { OpensteerApp } from "@opensteer/core";
import { isAppOriginUrl, type AppTheme } from "@opensteer/shared/appFrame";
const noSubscription = () => () => undefined;

/** View capabilities live only in the mounted reader, never in saved client state. */
export function useAppView(
  client: HostClient | null,
  appId: string,
  theme: AppTheme,
  enabled = true,
) {
  const readRevision = useCallback(() => {
    const snapshot = client?.getSnapshot();
    return `${snapshot?.appVersions?.[appId] ?? 0}:${snapshot?.connection ?? "offline"}:${snapshot?.session ?? "checking"}:${snapshot?.user?.id ?? ""}:${snapshot?.deploymentId ?? ""}:${snapshot?.sessionId ?? ""}`;
  }, [client, appId]);
  const revision = useSyncExternalStore(client?.subscribe ?? noSubscription, readRevision);
  const themeForRead = useRef(theme);
  themeForRead.current = theme;
  const [attempt, setAttempt] = useState(0);
  const [version, , session, viewer, deployment, sessionId] = revision.split(":");
  const key = useMemo(
    () => ({}),
    [client, appId, enabled, version, session, viewer, deployment, sessionId, attempt],
  );
  const [result, setResult] = useState<{
    key: object;
    view?: { app: OpensteerApp; url: string };
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!client || !enabled) return;
    const controller = new AbortController();
    void client.viewApp(appId, themeForRead.current, controller.signal).then(
      (view) => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            key,
            view:
              previous?.key === key &&
              previous.view &&
              isAppOriginUrl(view.url) &&
              isAppOriginUrl(previous.view.url) &&
              new URL(view.url).origin === new URL(previous.view.url).origin
                ? { ...view, url: previous.view.url }
                : view,
          }));
      },
      () => {
        if (!controller.signal.aborted)
          setResult((previous) =>
            previous?.key === key && previous.view ? previous : { key, failed: true },
          );
      },
    );
    return () => controller.abort();
  }, [client, appId, enabled, key, revision]);
  return {
    view: result?.key === key ? (result.view ?? null) : null,
    failed: result?.key === key && result.failed === true,
    retry: () => setAttempt((value) => value + 1),
  };
}
