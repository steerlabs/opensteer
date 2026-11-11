/**
 * What the platform knows about the app that the Host client cannot observe.
 *
 * A browser tab, an Electron renderer and a React Native app each report being
 * hidden and losing the network in their own vocabulary; this is the whole of
 * what the client needs from any of them. Every listener returns its own
 * disposer, so a client that registers them releases exactly what it took.
 */
export type ClientNetworkState = "offline" | "online" | "unknown";
export type ClientVisibility = "background" | "foreground";
export type ClientNetworkPath = "changed" | "same";

export interface ClientLifecycleSnapshot {
  readonly network: ClientNetworkState;
  readonly visibility: ClientVisibility;
}

export interface ClientLifecycle {
  getSnapshot(): ClientLifecycleSnapshot;
  onBackground(listener: () => void): () => void;
  onForeground(listener: () => void): () => void;
  /**
   * Notifies that the network path may have changed — not that the reported
   * state differs from the last one. A Wi-Fi to cellular handover is `online`
   * on both sides of the move and still invalidates every open socket, so
   * `changed` says the platform saw a move and the client replaces its sockets.
   * Phones also report paths that did not move, for reasons that leave sockets
   * working, and a move between two Wi-Fi networks can look the same: `same`
   * is delivered rather than filtered out, and the client asks its sockets.
   */
  onNetworkChange(
    listener: (state: ClientNetworkState, path: ClientNetworkPath) => void,
  ): () => void;
  /**
   * How long this platform keeps a hidden app's sockets, `socketTrustWindowMs`
   * unless it knows better. A desktop app's sockets are never torn down for
   * being hidden, so it trusts them however long it was away.
   */
  readonly socketTrustWindowMs?: number;
}

/**
 * How long a backgrounded client trusts its sockets on a platform that may
 * tear them down. Under this the operating system is unlikely to have done
 * so, so a probe is cheaper than a reconnect; over it a replacement is cheaper
 * than waiting for a probe that a dead socket will never answer.
 */
export const socketTrustWindowMs = 10_000;

/** A probe that goes unanswered this long means the socket is dead. */
export const socketProbeDeadlineMs = 3_000;

/**
 * How long a connection may be down before a person is told. A reconnect
 * resumes from its cursor and loses nothing, so one that finishes inside this
 * never happened as far as they can tell. It outlasts an unanswered probe and
 * the reconnect that follows it.
 */
export const connectionInterruptionHoldMs = 5_000;

export const realtimeIdleProbeMs = 25_000;

/**
 * How long that question waits for its answer. Nothing suggested the socket
 * was dead, so this is longer than the foreground probe's: a slow link or a
 * large frame still in flight must not read as a dead one.
 */
export const realtimeIdleProbeDeadlineMs = 10_000;
