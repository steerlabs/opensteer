import { OpensteerError } from "@opensteer/core";
import type { TeamChannelSummary, TeamMember, TeamRemotePeopleSchema } from "@opensteer/protocol";
import type { z } from "zod";

export type TeamRemotePeople = Readonly<
  Record<
    string,
    z.infer<typeof TeamRemotePeopleSchema>[keyof z.infer<typeof TeamRemotePeopleSchema>]
  >
>;
export type TeamPerson = Pick<TeamMember, "userId" | "displayName" | "handle" | "image"> & {
  readonly externalTeam?: string;
};

export function mergeTeamPeople(
  held: TeamRemotePeople,
  incoming?: TeamRemotePeople,
): TeamRemotePeople {
  let next: Record<string, TeamRemotePeople[string]> | null = null;
  for (const [id, person] of Object.entries(incoming ?? {})) {
    const old = held[id];
    if (
      old?.name === person.name &&
      old.handle === person.handle &&
      old.homeTeamName === person.homeTeamName
    )
      continue;
    next ??= { ...held };
    next[id] = {
      name: person.name,
      handle: person.handle,
      homeTeamName: person.homeTeamName,
      external: true,
    };
  }
  return next ?? held;
}

export function teamPeopleDirectory(
  members: Iterable<TeamPerson>,
  people: TeamRemotePeople = {},
  handles: Readonly<Record<string, string>> = {},
): ReadonlyMap<string, TeamPerson> {
  const directory = new Map<string, TeamPerson>(
    [...members].map((member) => [member.userId, member]),
  );
  for (const [id, person] of Object.entries(people))
    directory.set(id, {
      userId: id as TeamMember["userId"],
      displayName: person.name,
      handle: person.handle,
      image: null,
      externalTeam: person.homeTeamName,
    });
  for (const [id, handle] of Object.entries(handles)) {
    const person = directory.get(id);
    if (person) directory.set(id, { ...person, handle });
  }
  return directory;
}

export function channelShareView(
  share:
    | {
        state: "shared" | "disconnected";
        role: "owner" | "follower";
        teamName: string;
        updateRequired?: boolean | undefined;
      }
    | undefined,
) {
  if (!share) return null;
  if (share.state === "disconnected")
    return {
      label: `No longer shared with ${share.teamName}`,
      detail:
        share.role === "follower"
          ? "This is a read-only archive. You can still read its history."
          : "This channel continues with your team. The other team keeps its received history.",
    };
  return {
    label: `Shared with ${share.teamName}`,
    detail: share.updateRequired
      ? "Update this team's Opensteer server to continue syncing."
      : "Each team manages its own people.",
  };
}

export type TeamPendingSendView =
  | { readonly kind: "sending" | "queued" }
  | { readonly kind: "failed" | "retryable"; readonly reason: string };

export function pendingSendView(
  send: { readonly failure: string | null },
  connected: boolean,
  retry: { readonly error: unknown; readonly teamName: string | undefined } | null,
): TeamPendingSendView {
  if (send.failure !== null) return { kind: "failed", reason: send.failure };
  if (retry)
    return {
      kind: "retryable",
      reason:
        retry.error instanceof OpensteerError &&
        retry.error.reason === "partner-unreachable" &&
        retry.teamName
          ? `Can't reach ${retry.teamName} right now.`
          : "This message hasn't been confirmed. Try again.",
    };
  return { kind: connected ? "sending" : "queued" };
}

export function shareHistoryWarning(channelName: string, partnerName: string): string {
  return `${partnerName} will see the full history of #${channelName}, including past agent answers, and members' names and photos. Each team manages its own people.`;
}

export function shareOfferUnavailable(
  channel: TeamChannelSummary,
  generalChannelId: string | null | undefined,
): string | null {
  if (channel.kind === "dm" || channel.kind === "group_dm")
    return "Direct messages cannot be shared.";
  if (channel.id === generalChannelId || channel.name.toLowerCase() === "general")
    return "The default channel cannot be shared.";
  if (channel.archivedAt) return "Restore this channel before sharing it.";
  if (channel.share?.role === "follower") return "Only the owning team can share this channel.";
  if (channel.share?.state === "shared") return "This channel is already shared.";
  return null;
}

export function teamAskerLabel(asker: {
  readonly displayName: string;
  readonly actor: "human" | "agent";
  readonly homeTeamName?: string | undefined;
}): string {
  return `${asker.displayName}${asker.actor === "agent" ? "'s agent" : ""}${asker.homeTeamName ? ` · ${asker.homeTeamName}` : ""}`;
}
