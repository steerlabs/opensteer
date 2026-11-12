import { useCallback } from "react";
import { useHostSelector } from "@opensteer/client/react";
import type { HostSnapshot } from "@opensteer/client/host";
import type { TaskSourceView } from "../components/home/home-models.js";
import { useShell } from "../components/app-shell.js";
import { useTeams } from "./team-attachments.js";
import { teamTile } from "./team-people.js";
import { channelKind } from "./team-view-models.js";

const selectThreads = (snapshot: HostSnapshot) => snapshot.threads;

/** "A #support" for any task, by id: the team and channel a team thread started it from. */
export function useTaskSourceLookup(): (taskId: string) => TaskSourceView | null {
  const { hostClient } = useShell();
  const threads = useHostSelector(hostClient, selectThreads);
  const { teams } = useTeams();
  return useCallback(
    (taskId: string) => {
      const origin = threads.find((thread) => thread.id === taskId)?.teamOrigin;
      if (!origin) return null;
      const team = teams.find((candidate) => candidate.teamId === origin.teamId);
      const entry = team?.client
        ?.getSnapshot()
        .sidebar?.channels.find((row) => row.channel.id === origin.channelId);
      return {
        team: teamTile(origin.teamId, team?.name ?? "Team"),
        channel: entry
          ? { kind: channelKind(entry.channel.kind), name: entry.channel.name }
          : { kind: "public", name: "channel" },
        available: team !== undefined && team.link?.state !== "revoked",
      };
    },
    [teams, threads],
  );
}
