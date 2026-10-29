import { useCallback, useSyncExternalStore } from "react";
import {
  computerUseStops,
  type ComputerUseStop,
  type ComputerUseStopClient,
} from "../integrations/computer-use-stops.js";

export function useComputerUseStop(
  hostClient: ComputerUseStopClient | null,
  sessionId: string | null,
): ComputerUseStop | null {
  const store = hostClient ? computerUseStops(hostClient) : null;
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => undefined),
    [store],
  );
  const read = useCallback(() => store?.get(sessionId) ?? null, [sessionId, store]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useComputerUseStopForRun(
  hostClient: ComputerUseStopClient | null,
  runId: string | null,
): ComputerUseStop | null {
  const store = hostClient ? computerUseStops(hostClient) : null;
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => undefined),
    [store],
  );
  const read = useCallback(() => store?.forRun(runId) ?? null, [runId, store]);
  return useSyncExternalStore(subscribe, read, read);
}
