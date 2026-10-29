import type { HostSnapshot } from "./client.js";

type ConnectionSnapshot = Pick<HostSnapshot, "connection" | "session" | "network">;

export interface HostConnectionLine {
  readonly action: "none" | "retry" | "sign-in";
  readonly label: string;
  readonly tone: "green" | "amber" | "red" | "muted";
}

/** Platform reachability is evidence of being offline; an RPC failure is not. */
export function describeHostConnection(snapshot: ConnectionSnapshot | null): HostConnectionLine {
  if (snapshot === null) return { action: "none", label: "Connecting…", tone: "muted" };
  if (snapshot.session === "authentication-required") {
    return { action: "sign-in", label: "Signed out", tone: "amber" };
  }
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
    ? { action: "none", label: "Connected", tone: "green" }
    : { action: "none", label: "Reconnecting…", tone: "muted" };
}

/** Decisions require a synchronized Host, independently of Runner availability. */
export function canRespondToRequests(snapshot: ConnectionSnapshot | null): boolean {
  return (
    snapshot !== null &&
    snapshot.network !== "offline" &&
    snapshot.connection === "connected" &&
    snapshot.session === "authenticated"
  );
}
