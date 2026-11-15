import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { useHostSelector } from "./use-host-snapshot.js";

interface Icon {
  src: string | null;
  reading: boolean;
  tries: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly listeners: Set<() => void>;
}

/** A miss waits this long before each retry, then waits for a reconnect or a new reader. */
const retries = [250, 1_000];
/** Icons kept beyond the ones a row shows now; a long list scrolls back to them at once. */
const kept = 2_048;
const caches = new WeakMap<HostClient, Map<string, Icon>>();
const selectConnection = (snapshot: HostSnapshot) => snapshot.connection;

function entry(hostClient: HostClient, key: string): Icon {
  let cache = caches.get(hostClient);
  if (!cache) caches.set(hostClient, (cache = new Map()));
  let icon = cache.get(key);
  if (!icon) {
    icon = { src: null, reading: false, tries: 0, timer: undefined, listeners: new Set() };
    cache.set(key, icon);
    if (cache.size > kept)
      for (const [old, value] of cache) {
        if (cache.size <= kept) break;
        if (!value.listeners.size && !value.reading) cache.delete(old);
      }
  }
  return icon;
}

function read(hostClient: HostClient, icon: Icon, sessionId: string, iconRef: string) {
  if (icon.src !== null || icon.reading || icon.timer !== undefined) return;
  if (hostClient.getSnapshot().connection !== "connected") return;
  icon.reading = true;
  void hostClient
    .readBrowserTabIcon(sessionId, iconRef)
    .catch(() => null)
    .then((src) => {
      icon.reading = false;
      if (src) {
        icon.src = src;
        for (const listener of icon.listeners) listener();
        return;
      }
      // A lost connection or a catalog race says nothing about immutable icon content.
      const delay = retries[icon.tries++];
      if (delay === undefined || !icon.listeners.size) icon.tries = 0;
      else
        icon.timer = setTimeout(() => {
          icon.timer = undefined;
          read(hostClient, icon, sessionId, iconRef);
        }, delay);
    });
}

/**
 * A tab's site icon, read once per client and reference and shared by every
 * row that shows it; null until it arrives, when a row shows its glyph.
 */
export function useBrowserTabIcon(
  hostClient: HostClient,
  sessionId: string,
  iconRef: string | null,
): string | null {
  const connection = useHostSelector(hostClient, selectConnection);
  const key = iconRef === null ? null : `${sessionId}\u0000${iconRef}`;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (key === null) return () => {};
      const icon = entry(hostClient, key);
      icon.listeners.add(listener);
      return () => {
        icon.listeners.delete(listener);
        if (!icon.listeners.size && icon.timer !== undefined) {
          clearTimeout(icon.timer);
          icon.timer = undefined;
          icon.tries = 0;
        }
      };
    },
    [hostClient, key],
  );
  const get = useCallback(
    () => (key === null ? null : (caches.get(hostClient)?.get(key)?.src ?? null)),
    [hostClient, key],
  );
  const src = useSyncExternalStore(subscribe, get, get);
  useEffect(() => {
    if (key !== null && iconRef !== null && connection === "connected")
      read(hostClient, entry(hostClient, key), sessionId, iconRef);
  }, [connection, hostClient, iconRef, key, sessionId]);
  return src;
}
