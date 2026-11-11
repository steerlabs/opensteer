import { useSyncExternalStore } from "react";
import type { TeamSessionClient, TeamSessionSnapshot } from "../team/team-session-client.js";
export function useTeam(client: TeamSessionClient): TeamSessionSnapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
