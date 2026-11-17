import { canRespondToRequests, type HostClient } from "@opensteer/client/host";
import { useCallback, useEffect, useRef, useMemo } from "react";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { createClientRead } from "@opensteer/client/reads";
import { useClientRead } from "@opensteer/client/react";
import { presentClientIssue } from "@opensteer/client/feedback";

export type SettingsRpcData<K extends keyof HostClient["rpc"]> = Extract<
  Awaited<ReturnType<HostClient["rpc"][K]>>,
  { ok: true }
>["data"];
export function useSettingsLease(host: HostClient | null) {
  const mobile = useMobileClient();
  const active = useRef(true);
  const userId = useRef(host?.getSnapshot().user?.id ?? null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [host]);
  return useCallback(() => {
    if (!host) return false;
    const snapshot = host.getSnapshot();
    if (
      !active.current ||
      mobile.getSnapshot().selection.hostClient !== host ||
      !canRespondToRequests(snapshot)
    )
      return false;
    // A page may mount before bootstrap; bind its first authenticated viewer once.
    if (userId.current === null) userId.current = snapshot.user?.id ?? null;
    return userId.current !== null && snapshot.user?.id === userId.current;
  }, [host, mobile]);
}
export function useSettingsRead<T>(host: HostClient, read: () => Promise<T>, key = "") {
  const current = useRef(read);
  current.current = read;
  const resource = useMemo(
    () =>
      createClientRead(host, {
        key,
        label: "settings",
        read: () => current.current(),
        subscribeInvalidation: (listener) => host.subscribePluginsChanged(listener),
      }),
    [host, key],
  );
  const state = useClientRead(resource);
  const reload = useCallback(async () => {
    state.refresh();
  }, [state.refresh]);
  return { ...state, error: state.issue ? presentClientIssue(state.issue).title : null, reload };
}
