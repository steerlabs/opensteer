import { useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { idleSessionStopState, SessionStopOwner } from "../host/session-stop.js";

const idle = {
  subscribe: () => () => {},
  getSnapshot: () => idleSessionStopState,
  run: async () => {},
  reconcile: async () => {},
};

export function useSessionStop(client: HostClient, threadId: string, sessionId: string | null) {
  const owner = sessionId === null ? idle : SessionStopOwner.for(client, threadId, sessionId);
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  return { ...state, run: owner.run, reconcile: owner.reconcile };
}
