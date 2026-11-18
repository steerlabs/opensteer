import { useCallback, useSyncExternalStore } from "react";
import type {
  ClientConnection,
  ClientConnectionState,
} from "../connections/connection-controller.js";

export function useClientConnection(connection: ClientConnection): ClientConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
}

const noConnection = () => () => {};

/** The connection's display name, redrawing only when it changes. */
export function useClientConnectionName(connection: ClientConnection | null): string | null {
  const read = useCallback(() => connection?.getSnapshot().name ?? null, [connection]);
  return useSyncExternalStore(connection?.subscribe ?? noConnection, read, read);
}

/** Whether this connection has been ready at least once in this session. */
export function useClientConnectionEverReady(connection: ClientConnection | null): boolean {
  const read = useCallback(() => (connection?.getSnapshot().readyRevision ?? 0) > 0, [connection]);
  return useSyncExternalStore(connection?.subscribe ?? noConnection, read, read);
}
