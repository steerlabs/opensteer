import type { ClientConnectionState, ClientScope } from "../connections/connection-controller.js";

export function controlledClientSession() {
  const scope: ClientScope = {
    authorityKey: "verified-host",
    deploymentId: "deployment",
    viewerId: "viewer",
    loginId: "login",
  };
  let state: ClientConnectionState = {
    phase: "ready",
    network: "online",
    visibility: "foreground",
    scope,
    epoch: 1,
    readyRevision: 1,
    showInterruption: false,
    issue: null,
    trying: false,
    pathRevision: 0,
    lastConnectedAt: 1,
    name: "Tim's Mac",
    target: "computer",
    route: "connect",
  };
  const listeners = new Set<() => void>();
  return {
    connection: {
      getSnapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      retry() {},
    },
    change(patch: Partial<ClientConnectionState>) {
      state = { ...state, ...patch };
      listeners.forEach((fn) => fn());
    },
  };
}
