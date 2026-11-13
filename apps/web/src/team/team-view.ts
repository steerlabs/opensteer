import { useEffect, useMemo, useState } from "react";
import type { TeamMember } from "@opensteer/protocol";
import type { TeamSessionClient, TeamSessionSnapshot } from "@opensteer/client/team";
import { useTeamAttachment, useTeamSession, type TeamAttachment } from "./team-attachments.js";
import { useTeamMembers, type PeopleState } from "./team-people.js";
import type { TeamWords } from "./team-view-models.js";

/** One team, as a screen in it needs it: the session, its members and this viewer's words. */
export interface TeamView {
  readonly team: TeamAttachment;
  readonly client: TeamSessionClient;
  readonly snapshot: TeamSessionSnapshot;
  readonly members: ReadonlyMap<string, TeamMember>;
  /** Whether `members` has been read yet; until then it holds only the viewer. */
  readonly people: PeopleState["status"];
  readonly me: TeamMember | null;
  readonly words: TeamWords;
}

export function useTeamView(teamId: string | undefined, previews: ReadonlyMap<string, string>) {
  const team = useTeamAttachment(teamId);
  const client = team?.client ?? null;
  const snapshot = useTeamSession(client);
  const { members, status: people } = useTeamMembers(
    client,
    snapshot?.sidebar?.accessRevision ?? null,
  );
  const linkPresence = snapshot?.channel?.linkPresence;
  const words = useMemo<TeamWords | null>(() => {
    const member = snapshot?.bootstrap?.member;
    if (!member) return null;
    return {
      viewerUserId: member.userId,
      members: members.size > 0 ? members : new Map([[member.userId, member]]),
      linkOnline: new Map((linkPresence ?? []).map((row) => [row.ownerUserId, row.online])),
      previews,
      managedChannels: new Set(
        [
          ...new Map(
            [
              ...(snapshot.sidebar?.channels.map((row) => row.channel) ?? []),
              ...(snapshot.channel?.channel ? [snapshot.channel.channel] : []),
              ...(snapshot.thread?.channel ? [snapshot.thread.channel] : []),
            ].map((channel) => [channel.id, channel] as const),
          ).values(),
        ]
          .filter((channel) => channel.can.manage)
          .map((channel) => channel.id),
      ),
    };
  }, [
    linkPresence,
    members,
    previews,
    snapshot?.bootstrap?.member,
    snapshot?.sidebar,
    snapshot?.channel?.channel,
    snapshot?.thread?.channel,
  ]);
  if (!team || !client || !snapshot || !words) return null;
  return {
    team,
    client,
    snapshot,
    members: words.members,
    people,
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
  const [state, setState] = useState<{ key: string; value: Value | null; error: string | null }>({
    key,
    value: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!read) return;
    let live = true;
    void read()
      .then((value) => live && setState({ key, value, error: null }))
      .catch(
        (error: unknown) =>
          live &&
          setState({
            key,
            value: null,
            error: error instanceof Error ? error.message : "Can’t load.",
          }),
      );
    return () => {
      live = false;
    };
    // The key names what is read; the reader closure is new every render.
  }, [key, attempt]);
  // Another key's answer is never shown as this one's; a reload keeps the last answer meanwhile.
  const current = state.key === key;
  return {
    value: current ? state.value : null,
    error: current ? state.error : null,
    reload: () => setAttempt((value) => value + 1),
  };
}
