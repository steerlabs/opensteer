import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { PersonalRemoteAccessClient } from "../host/personal-remote-access.js";
const empty = { status: null, error: null, pairing: null, working: false } as const;
const detachedSubscribe = () => () => {};
const detachedSnapshot = () => empty;

/** Settings-only observation; it adds no work to connection or first paint. */
export function usePersonalRemoteAccess(client: HostClient | null) {
  const resource = useMemo(
    () => (client ? new PersonalRemoteAccessClient(client) : null),
    [client],
  );
  useEffect(() => resource?.start(), [resource]);
  const state = useSyncExternalStore(
    resource?.subscribe ?? detachedSubscribe,
    resource?.getSnapshot ?? detachedSnapshot,
    resource?.getSnapshot ?? detachedSnapshot,
  );
  return { ...state, request: resource?.request, pair: resource?.pair };
}
