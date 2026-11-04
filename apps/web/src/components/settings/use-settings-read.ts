import { useEffect, useRef, useState } from "react";
import { createSettingsRead } from "@opensteer/client/settings";
import { useShell } from "../app-shell.js";

/** The last value each remembered read published, per Host client. */
const lastReads = new WeakMap<object, Map<string, unknown>>();

/**
 * One page's read of the Host, kept current. A `remember`ed read paints what it
 * last showed at once on a return visit while it reads again; only for views
 * nothing acts on, since the remembered value may be out of date.
 */
export function useSettingsRead<T>(read: () => Promise<T>, key: string, remember = false) {
  const { hostClient } = useShell();
  const last = () =>
    remember ? ((lastReads.get(hostClient)?.get(key) as T | undefined) ?? null) : null;
  const [state, setState] = useState<{
    owner: object;
    key: string;
    data: T | null;
    error: unknown;
  }>(() => ({ owner: hostClient, key, data: last(), error: null }));
  const readRef = useRef(read);
  readRef.current = read;
  const readerRef = useRef<ReturnType<typeof createSettingsRead<T>> | null>(null);
  useEffect(() => {
    const reader = createSettingsRead(
      () => readRef.current(),
      (data) => {
        if (remember) {
          const reads = lastReads.get(hostClient) ?? new Map<string, unknown>();
          lastReads.set(hostClient, reads.set(key, data));
        }
        setState({ owner: hostClient, key, data, error: null });
      },
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
  }, [hostClient, key, remember]);
  const own = state.owner === hostClient && state.key === key;
  return {
    data: own ? state.data : last(),
    error: own ? state.error : null,
    reload: () => void readerRef.current?.refresh(),
  };
}
