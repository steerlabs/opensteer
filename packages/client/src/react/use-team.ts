import { useEffect, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { TeamSession, type TeamSessionState } from "../host/team-session.js";

export interface TeamState extends TeamSessionState {
  readonly refresh: () => void;
  readonly holdLink: (invitationId: string, url: string) => void;
  readonly forgetLink: (invitationId: string) => void;
}

const sessions = new WeakMap<HostClient, TeamSession>();

function sessionFor(client: HostClient): TeamSession {
  let session = sessions.get(client);
  if (!session) {
    session = new TeamSession(client);
    sessions.set(client, session);
  }
  return session;
}

/**
 * The team this Host is, for whoever is signed in to it now, read once after
 * the first screen and shared by every team screen. A Host without
 * `team-administration-v1` gets no read at all.
 */
export function useTeam(client: HostClient): TeamState {
  const session = sessionFor(client);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  useEffect(() => session.start(), [session]);
  return {
    ...state,
    refresh: session.refresh,
    holdLink: session.holdLink,
    forgetLink: session.forgetLink,
  };
}
