import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";

export function useWorkPolicy(client: HostClient | null) {
  const subscribe = useCallback(
    (listener: () => void) => client?.subscribe(listener) ?? (() => {}),
    [client],
  );
  const read = useCallback(
    () => (client ? client.getSnapshot().effectiveWorkPolicy : null),
    [client],
  );
  return useSyncExternalStore(subscribe, read, read);
}
