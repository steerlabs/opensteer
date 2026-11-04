import { canRespondToRequests, type HostClient } from "@opensteer/client/host";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { createSettingsRead } from "@opensteer/client/settings";

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
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isCurrent = useSettingsLease(host);
  const readRef = useRef(read);
  readRef.current = read;
  const readerRef = useRef<ReturnType<typeof createSettingsRead<T>> | null>(null);
  const reload = useCallback(
    () => (isCurrent() ? (readerRef.current?.refresh() ?? Promise.resolve()) : Promise.resolve()),
    [isCurrent],
  );
  useEffect(() => {
    const reader = createSettingsRead(
      () => readRef.current(),
      (value: T) => {
        if (isCurrent()) {
          setData(value);
          setError(null);
        }
      },
      () => {
        if (isCurrent()) setError("Couldn’t refresh settings. Try again.");
      },
    );
    setData(null);
    readerRef.current = reader;
    void reload();
    let connected = canRespondToRequests(host.getSnapshot());
    const unsubscribe = host.subscribe(() => {
      const next = canRespondToRequests(host.getSnapshot());
      if (next && !connected) void reader.reconnect();
      connected = next;
    });
    const unsubscribePlugins = host.subscribePluginsChanged(() => {
      void reload();
    });
    return () => {
      reader.dispose();
      unsubscribe();
      unsubscribePlugins();
    };
  }, [host, reload, isCurrent, key]);
  return { data, error, reload };
}
