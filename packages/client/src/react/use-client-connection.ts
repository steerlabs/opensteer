import { useCallback, useSyncExternalStore } from "react";
import type {
  ClientConnection,
  ClientConnectionState,
} from "../connections/connection-controller.js";

export function useClientConnection(connection: ClientConnection): ClientConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
}

import { connectionNotice } from "../connections/connection-notice.js";
import { presentClientIssue } from "../feedback/client-issue.js";

export function useConnectionNotice(connection: ClientConnection): string | null {
  const snapshot = useCallback(() => {
    const issue = connectionNotice(connection.getSnapshot());
    return issue ? presentClientIssue(issue).title : null;
  }, [connection]);
  return useSyncExternalStore(connection.subscribe, snapshot, snapshot);
}
