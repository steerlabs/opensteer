import { useEffect, useRef, useState } from "react";
import { createSettingsRead } from "@opensteer/client/settings";
import { useShell } from "../app-shell.js";

export function useSettingsRead<T>(read: () => Promise<T>, key: string) {
  const { hostClient } = useShell();
  const [state, setState] = useState<{
    owner: object;
    key: string;
    data: T | null;
    error: unknown;
  }>({ owner: hostClient, key, data: null, error: null });
  const readRef = useRef(read);
  readRef.current = read;
  const readerRef = useRef<ReturnType<typeof createSettingsRead<T>> | null>(null);
  useEffect(() => {
    const reader = createSettingsRead(
      () => readRef.current(),
      (data) => setState({ owner: hostClient, key, data, error: null }),
      (error) => setState((previous) => ({ ...previous, owner: hostClient, key, error })),
    );
    readerRef.current = reader;
    void reader.refresh();
    const unsubscribe = hostClient.subscribePluginsChanged(() => void reader.refresh());
    let connection = hostClient.getSnapshot().connection;
    const unsubscribeConnection = hostClient.subscribe(() => {
      const next = hostClient.getSnapshot().connection;
      if (next === "connected" && connection !== next) void reader.reconnect();
      connection = next;
    });
    return () => {
      unsubscribe();
      unsubscribeConnection();
      reader.dispose();
    };
  }, [hostClient, key]);
  const own = state.owner === hostClient && state.key === key;
  return {
    data: own ? state.data : null,
    error: own ? state.error : null,
    reload: () => void readerRef.current?.refresh(),
  };
}
