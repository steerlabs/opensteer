import type { HostClient } from "../host/client.js";
import type {
  ClientConnection,
  ClientConnectionState,
} from "../connections/connection-controller.js";

export function testHostConnection(
  host: Pick<HostClient, "getSnapshot" | "subscribe">,
): ClientConnection {
  let signature = "",
    state: ClientConnectionState;
  let login = 0;
  let viewer = "";
  const updateLogin = () => {
    const value = host.getSnapshot();
    const next = `${value.session}:${value.user?.id}:${value.deploymentId}`;
    if (next !== viewer) {
      viewer = next;
      login++;
    }
  };
  host.subscribe(updateLogin);
  updateLogin();
  let epoch = 0,
    readyRevision = 0,
    previousReady = false;
  return {
    getSnapshot() {
      const snapshot = host.getSnapshot();
      const identity = JSON.stringify([
        snapshot.deploymentId,
        snapshot.user?.id,
        snapshot.sessionId,
        snapshot.session,
        snapshot.connection,
        snapshot.network,
      ]);
      if (signature === identity) return state;
      signature = identity;
      epoch++;
      const ready =
        snapshot.session === "authenticated" &&
        snapshot.connection === "connected" &&
        snapshot.network !== "offline";
      if (ready && !previousReady) readyRevision++;
      previousReady = ready;
      state = {
        phase: ready
          ? "ready"
          : snapshot.session === "authentication-required"
            ? "blocked"
            : "recovering",
        scope:
          snapshot.session === "authenticated" && snapshot.user && snapshot.deploymentId
            ? {
                authorityKey: snapshot.deploymentId,
                deploymentId: snapshot.deploymentId,
                viewerId: snapshot.user.id,
                loginId: snapshot.sessionId ?? `test-login:${login}`,
              }
            : null,
        epoch,
        readyRevision,
        network: snapshot.network,
        visibility: "foreground",
        showInterruption: false,
        issue: null,
        trying: false,
        pathRevision: 0,
        lastConnectedAt: null,
        name: null,
        target: "computer",
        route: null,
      };
      return state;
    },
    subscribe: host.subscribe,
    retry() {},
  };
}
