import { useEffect, useRef, useState } from "react";
import { createSettingsRead } from "@opensteer/client/settings";
import { useShell } from "../app-shell.js";

/** The last value each remembered read published, per Host client and viewer. */
const lastReads = new WeakMap<object, Map<string, unknown>>();

/**
 * One page's read of the Host, kept current. A `remember`ed read paints what it
 * last showed at once on a return visit while it reads again; only for views
 * nothing acts on, since the remembered value may be out of date.
 */
export function useSettingsRead<T>(read: () => Promise<T>, key: string, remember = false) {
  const { hostClient } = useShell();
  // A Host client outlives a sign-in: a read belongs to the person it was made for,
  // so what one person saw is never shown to the next.
  const viewer = hostClient.getSnapshot().user?.id ?? null;
  const identity = `${viewer ?? ""}\n${key}`;
  const last = () =>
    remember && viewer
      ? ((lastReads.get(hostClient)?.get(identity) as T | undefined) ?? null)
      : null;
  const [state, setState] = useState<{
    owner: object;
    identity: string;
    data: T | null;
    error: unknown;
  }>(() => ({ owner: hostClient, identity, data: last(), error: null }));
  const readRef = useRef(read);
  readRef.current = read;
  const readerRef = useRef<ReturnType<typeof createSettingsRead<T>> | null>(null);
  useEffect(() => {
    const reader = createSettingsRead(
      () => readRef.current(),
      (data) => {
        if (remember && viewer) {
          const reads = lastReads.get(hostClient) ?? new Map<string, unknown>();
          lastReads.set(hostClient, reads.set(identity, data));
        }
        setState({ owner: hostClient, identity, data, error: null });
      },
      (error) => setState((previous) => ({ ...previous, owner: hostClient, identity, error })),
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
  }, [hostClient, identity, remember, viewer]);
  const own = state.owner === hostClient && state.identity === identity;
  return {
    data: own ? state.data : last(),
    error: own ? state.error : null,
    reload: () => readerRef.current?.refresh() ?? Promise.resolve(),
  };
}
