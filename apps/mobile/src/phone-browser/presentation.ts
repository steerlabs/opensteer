import { useCallback, useSyncExternalStore } from "react";
import type { PhoneBrowserManager, PhoneTabPresentation } from "./manager.js";

export function usePhoneTabPresentation(
  manager: PhoneBrowserManager,
  surfaceId: string,
): PhoneTabPresentation | null {
  const subscribe = useCallback(
    (listener: () => void) => manager.subscribeTab(surfaceId, listener),
    [manager, surfaceId],
  );
  const snapshot = useCallback(() => manager.getTabPresentation(surfaceId), [manager, surfaceId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
