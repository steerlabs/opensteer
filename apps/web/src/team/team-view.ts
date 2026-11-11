import { useEffect, useMemo, useState } from "react";
import type { TeamMember } from "@opensteer/protocol";
import type { TeamSessionClient, TeamSessionSnapshot } from "@opensteer/client/team";
import { useTeamAttachment, useTeamSession, type TeamAttachment } from "./team-attachments.js";
import { useTeamMembers } from "./team-people.js";
import type { TeamWords } from "./team-view-models.js";

/** One team, as a screen in it needs it: the session, its members and this viewer's words. */
export interface TeamView {
  readonly team: TeamAttachment;
  readonly client: TeamSessionClient;
  readonly snapshot: TeamSessionSnapshot;
  readonly members: ReadonlyMap<string, TeamMember>;
  readonly me: TeamMember | null;
  readonly words: TeamWords;
}

export function useTeamView(teamId: string | undefined, previews: ReadonlyMap<string, string>) {
  const team = useTeamAttachment(teamId);
  const client = team?.client ?? null;
  const snapshot = useTeamSession(client);
  const members = useTeamMembers(client, snapshot?.sidebar?.accessRevision ?? null);
  const linkPresence = snapshot?.channel?.linkPresence;
  const words = useMemo<TeamWords | null>(() => {
    const member = snapshot?.bootstrap?.member;
    if (!member) return null;
    return {
      viewerUserId: member.userId,
      members: members.size > 0 ? members : new Map([[member.userId, member]]),
      linkOnline: new Map((linkPresence ?? []).map((row) => [row.ownerUserId, row.online])),
      previews,
      canModerate: member.role === "owner" || member.role === "admin",
    };
  }, [linkPresence, members, previews, snapshot?.bootstrap?.member]);
  if (!team || !client || !snapshot || !words) return null;
  return {
    team,
    client,
    snapshot,
    members: words.members,
    me: snapshot.bootstrap?.member ?? null,
    words,
  } satisfies TeamView;
}

/** A team read that runs once per key; its answer, its failure, and a way to read again. */
export function useTeamRead<Value>(
  read: (() => Promise<Value>) | null,
  key: string,
): {
  readonly value: Value | null;
  readonly error: string | null;
  readonly reload: () => void;
} {
  const [state, setState] = useState<{ value: Value | null; error: string | null }>({
    value: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!read) return;
    let live = true;
    void read()
      .then((value) => live && setState({ value, error: null }))
      .catch(
        (error: unknown) =>
          live &&
          setState({ value: null, error: error instanceof Error ? error.message : "Can’t load." }),
      );
    return () => {
      live = false;
    };
    // The key names what is read; the reader closure is new every render.
  }, [key, attempt]);
  return { ...state, reload: () => setAttempt((value) => value + 1) };
}
