import type {
  ClientLifecycle,
  ClientLifecycleSnapshot,
  ClientNetworkPath,
  ClientNetworkState,
} from "@opensteer/client/host";

/** React Native's `AppState`, as this adapter needs it. */
export interface AppStateLike {
  readonly currentState: string | null | undefined;
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
}

export interface NetworkReading {
  readonly type?: string | undefined;
  readonly isConnected?: boolean | undefined;
  readonly isInternetReachable?: boolean | undefined;
}

/** `expo-network`, as this adapter needs it. */
export interface NetworkSource {
  addNetworkStateListener(listener: (reading: NetworkReading) => void): { remove(): void };
  getNetworkStateAsync(): Promise<NetworkReading>;
}

export interface MobileLifecycle extends ClientLifecycle {
  dispose(): void;
}

/**
 * What the phone knows about this app that the Host client cannot see.
 *
 * Two facts, from two places. Foreground comes from `AppState`, where only
 * `active` is the foreground: `inactive` is the app under the multitasking
 * switcher or a system prompt, and treating it as backgrounded would drop
 * sockets every time a notification slides down.
 *
 * Network comes from `expo-network`'s listener, which stops being told anything
 * while the process is suspended — the radio can change, or the phone can move
 * between Wi-Fi and cellular, with nothing delivered on the way back. So every
 * return to the foreground re-reads the state instead of trusting the listener
 * to have kept up.
 */
export function createMobileLifecycle(options: {
  readonly appState: AppStateLike;
  readonly network: NetworkSource;
  readonly onReadFailure?: (error: unknown) => void;
}): MobileLifecycle {
  const { appState, network } = options;
  const onReadFailure = options.onReadFailure ?? (() => undefined);
  const backgroundListeners = new Set<() => void>();
  const foregroundListeners = new Set<() => void>();
  const networkListeners = new Set<(state: ClientNetworkState, path: ClientNetworkPath) => void>();

  let snapshot: ClientLifecycleSnapshot = {
    network: "unknown",
    visibility: appState.currentState === "active" ? "foreground" : "background",
  };

  // Every notification is forwarded, repeats included, because a move between
  // two Wi-Fi networks reads the same and filtering it out would leave a client
  // holding sockets on a path that no longer exists. The reading only says
  // whether the phone saw a move; the client decides what each is worth.
  const publishNetwork = (state: ClientNetworkState, path: ClientNetworkPath): void => {
    snapshot = { ...snapshot, network: state };
    for (const listener of networkListeners) listener(state, path);
  };

  let lastReading: NetworkReading | undefined;
  let networkRevision = 0;

  // A foreground reread that finds the path it left is the foreground itself,
  // which the client already recovers from by probing or replacing. Announcing
  // it as well would replace the sockets that recovery just kept or reopened.
  // A listener notification, or a reread that finds another path, still goes out.
  const readNetwork = (foreground = false): void => {
    const revision = networkRevision;
    void network
      .getNetworkStateAsync()
      .then((reading) => {
        if (revision !== networkRevision) return;
        const path = pathOf(lastReading, reading);
        lastReading = reading;
        if (foreground && path === "same") return;
        publishNetwork(networkStateOf(reading), path);
      })
      .catch(onReadFailure);
  };

  const networkSubscription = network.addNetworkStateListener((reading) => {
    networkRevision += 1;
    const path = pathOf(lastReading, reading);
    lastReading = reading;
    publishNetwork(networkStateOf(reading), path);
  });

  const appStateSubscription = appState.addEventListener("change", (state) => {
    const visibility = state === "active" ? "foreground" : "background";
    if (visibility === snapshot.visibility) return;
    snapshot = { ...snapshot, visibility };
    if (visibility === "foreground") {
      readNetwork(true);
      for (const listener of foregroundListeners) listener();
      return;
    }
    for (const listener of backgroundListeners) listener();
  });

  readNetwork();

  return {
    dispose(): void {
      appStateSubscription.remove();
      networkSubscription.remove();
      backgroundListeners.clear();
      foregroundListeners.clear();
      networkListeners.clear();
    },
    getSnapshot: () => snapshot,
    onBackground(listener) {
      backgroundListeners.add(listener);
      return () => backgroundListeners.delete(listener);
    },
    onForeground(listener) {
      foregroundListeners.add(listener);
      return () => foregroundListeners.delete(listener);
    },
    onNetworkChange(listener) {
      networkListeners.add(listener);
      return () => networkListeners.delete(listener);
    },
  };
}

function pathOf(previous: NetworkReading | undefined, reading: NetworkReading): ClientNetworkPath {
  return previous?.type &&
    reading.type === previous.type &&
    reading.isConnected === previous.isConnected &&
    reading.isInternetReachable === previous.isInternetReachable
    ? "same"
    : "changed";
}

/**
 * A reading with neither field set says nothing, and "unknown" is the honest
 * answer: the client treats it as worth trying, which is right when the phone
 * has not told us otherwise.
 */
export function networkStateOf(reading: NetworkReading): ClientNetworkState {
  if (reading.isInternetReachable === false) return "offline";
  if (reading.isConnected === false) return "offline";
  if (reading.isConnected === true) return "online";
  return "unknown";
}
