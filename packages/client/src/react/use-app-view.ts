import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import type { OpensteerApp } from "@opensteer/core";
import type { AppTheme } from "@opensteer/shared/appFrame";
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
    return `${snapshot?.appVersions?.[appId] ?? 0}:${snapshot?.connection ?? "offline"}:${snapshot?.session ?? "checking"}`;
  }, [client, appId]);
  const revision = useSyncExternalStore(client?.subscribe ?? noSubscription, readRevision);
  const themeForRead = useRef(theme);
  themeForRead.current = theme;
  const [attempt, setAttempt] = useState(0);
  const key = useMemo(() => ({}), [client, appId, enabled, revision, attempt]);
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
        if (!controller.signal.aborted) setResult({ key, view });
      },
      () => {
        if (!controller.signal.aborted) setResult({ key, failed: true });
      },
    );
    return () => controller.abort();
  }, [client, appId, enabled, key]);
  return {
    view: result?.key === key ? (result.view ?? null) : null,
    failed: result?.key === key && result.failed === true,
    retry: () => setAttempt((value) => value + 1),
  };
}
