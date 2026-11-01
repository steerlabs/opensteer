import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { schedulesClient } from "../host/schedules.js";

/** Enable only while the screen is visible, including when navigation keeps it mounted. */
export function useSchedules(client: HostClient, workspaceId?: string, enabled = true) {
  const resource = schedulesClient(client, workspaceId).list;
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? resource.subscribe(listener) : () => undefined),
    [enabled, resource],
  );
  return useSyncExternalStore(subscribe, resource.getSnapshot, resource.getSnapshot);
}
export function useSchedule(client: HostClient, triggerId: string, enabled = true) {
  const resource = schedulesClient(client).detail(triggerId);
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? resource.subscribe(listener) : () => undefined),
    [enabled, resource],
  );
  return useSyncExternalStore(subscribe, resource.getSnapshot, resource.getSnapshot);
}
