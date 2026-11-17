import {
  presentClientIssue,
  connectedLabel,
  presentConnectionStarting,
} from "../feedback/client-issue.js";
import type { HostSnapshot } from "./client.js";

type ConnectionState = Pick<HostSnapshot, "connection" | "session" | "network">;
type ConnectionSnapshot = ConnectionState & Pick<HostSnapshot, "connectionInterrupted">;

export interface HostConnectionLine {
  readonly action: "none" | "retry" | "sign-in";
  readonly label: string;
  readonly tone: "green" | "amber" | "red" | "muted";
}

const connected: HostConnectionLine = { action: "none", label: connectedLabel, tone: "green" };

/**
 * Platform reachability is evidence of being offline; an RPC failure is not.
 * A signed-in client whose connection is down reads Connected until the
 * interruption has lasted, because decisions are what `canRespondToRequests` gates.
 */
export function describeHostConnection(snapshot: ConnectionSnapshot | null): HostConnectionLine {
  if (snapshot === null)
    return { action: "none", label: presentConnectionStarting(), tone: "muted" };
  if (snapshot.session === "authentication-required") {
    return {
      action: "sign-in",
      label: presentClientIssue({ code: "sign-in" }).title,
      tone: "amber",
    };
  }
  if (!snapshot.connectionInterrupted)
    return snapshot.session === "authenticated"
      ? connected
      : { action: "none", label: presentConnectionStarting(), tone: "muted" };
  if (snapshot.network === "offline") {
    return {
      action: "none",
      label: presentClientIssue({ code: "connection", reason: "offline" }).title,
      tone: "muted",
    };
  }
  if (snapshot.connection === "offline") {
    return {
      action: "retry",
      label: presentClientIssue({ code: "connection", reason: "unreachable" }).title,
      tone: "muted",
    };
  }
  if (snapshot.session === "checking") {
    return { action: "none", label: presentConnectionStarting(), tone: "muted" };
  }
  return snapshot.connection === "connected"
    ? connected
    : {
        action: "retry",
        label: presentClientIssue({ code: "connection", reason: "reconnecting" }).title,
        tone: "muted",
      };
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
