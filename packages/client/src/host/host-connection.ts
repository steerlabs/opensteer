import type { HostSnapshot } from "./client.js";

type ConnectionState = Pick<HostSnapshot, "connection" | "session" | "network">;
type ConnectionSnapshot = ConnectionState & Pick<HostSnapshot, "connectionInterrupted">;

export interface HostConnectionLine {
  readonly action: "none" | "retry" | "sign-in";
  readonly label: string;
  readonly tone: "green" | "amber" | "red" | "muted";
}

const connected: HostConnectionLine = { action: "none", label: "Connected", tone: "green" };

/**
 * Platform reachability is evidence of being offline; an RPC failure is not.
 * A signed-in client whose connection is down reads Connected until the
 * interruption has lasted, because decisions are what `canRespondToRequests` gates.
 */
export function describeHostConnection(snapshot: ConnectionSnapshot | null): HostConnectionLine {
  if (snapshot === null) return { action: "none", label: "Connecting…", tone: "muted" };
  if (snapshot.session === "authentication-required") {
    return { action: "sign-in", label: "Signed out", tone: "amber" };
  }
  if (snapshot.session === "authenticated" && !snapshot.connectionInterrupted) return connected;
  if (snapshot.network === "offline") {
    return { action: "none", label: "Offline", tone: "muted" };
  }
  if (snapshot.connection === "offline") {
    return { action: "retry", label: "Unavailable", tone: "muted" };
  }
  if (snapshot.session === "checking") {
    return { action: "none", label: "Connecting…", tone: "muted" };
  }
  return snapshot.connection === "connected"
    ? connected
    : { action: "retry", label: "Reconnecting…", tone: "muted" };
}

/** What is drawn as live stays drawn through a drop nobody is being told about. */
export function showsHostLive(snapshot: ConnectionSnapshot | null): boolean {
  return describeHostConnection(snapshot).tone === "green";
}

/** Decisions require a synchronized Host, independently of Runner availability. */
export function canRespondToRequests(snapshot: ConnectionState | null): boolean {
  return (
    snapshot !== null &&
    snapshot.network !== "offline" &&
    snapshot.connection === "connected" &&
    snapshot.session === "authenticated"
  );
}
