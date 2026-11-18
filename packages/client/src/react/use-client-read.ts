import { useCallback, useSyncExternalStore } from "react";
import type { ClientRead, ClientReadState } from "../reads/client-read.js";

const empty: ClientReadState<never> = { status: "waiting", data: null, issue: null };
export function useClientRead<T>(
  resource: ClientRead<T> | null,
  options?: { readonly enabled?: boolean },
): ClientReadState<T> & { readonly refresh: () => void } {
  const enabled = options?.enabled !== false;
  const subscribe = useCallback(
    (listener: () => void) => (enabled && resource ? resource.subscribe(listener) : () => {}),
    [enabled, resource],
  );
  const snapshot = useCallback(() => resource?.getSnapshot() ?? empty, [resource]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const refresh = useCallback(() => {
    if (enabled) void resource?.refresh();
  }, [enabled, resource]);
  return { ...state, refresh };
}
