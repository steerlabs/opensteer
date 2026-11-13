import type { TeamChannelId, UserId } from "@opensteer/core";
import {
  teamChannelNameKey,
  teamChannelNameTakenReason,
  type TeamChannelSummary,
  type TeamCommandSchema,
  type TeamMember,
} from "@opensteer/protocol";
import type { z } from "zod";

type ChannelCreate = Extract<z.infer<typeof TeamCommandSchema>, { type: "team.channel.create" }>;

/** A channel name as typed, as the team keeps it: without the `#` people type before it. */
export function channelNameFromInput(input: string): string {
  return input.trim().replace(/^#+/u, "").trim();
}

/**
 * The live channel in `channels` already called `input`, when the reader can see it. A
 * direct message's name is its people's, never a channel name, so it never matches.
 */
export function channelNamed<
  Channel extends Pick<TeamChannelSummary, "kind" | "name" | "archivedAt">,
>(channels: readonly Channel[], input: string): Channel | null {
  const key = teamChannelNameKey(channelNameFromInput(input));
  if (key === "") return null;
  return (
    channels.find(
      (channel) =>
        (channel.kind === "public" || channel.kind === "private") &&
        channel.archivedAt === null &&
        teamChannelNameKey(channel.name) === key,
    ) ?? null
  );
}

/** The team refused a name another live channel holds, maybe one the reader can't see. */
export function isChannelNameTaken(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "conflict" &&
    "reason" in error &&
    error.reason === teamChannelNameTakenReason
  );
}

/**
 * What a new channel form sends. A private channel starts with the people chosen; the team
 * adds its maker as a manager either way, and a public one is open to everyone.
 */
export function newChannelCommand(input: {
  readonly id: TeamChannelId;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly peopleOnly: boolean;
  readonly people: readonly UserId[];
}): ChannelCreate {
  return {
    type: "team.channel.create",
    id: input.id,
    kind: input.isPrivate ? "private" : "public",
    name: channelNameFromInput(input.name),
    peopleOnly: input.peopleOnly,
    access: input.isPrivate
      ? input.people.map((userId) => ({
          subject: { kind: "person", userId },
          level: "post",
          manage: false,
        }))
      : [],
  };
}

/**
 * The channels to browse, without direct messages: those whose name holds `query`, names
 * that start with it first, then by name, and archived ones last.
 */
export function browsableChannels<
  Channel extends Pick<TeamChannelSummary, "kind" | "name" | "archivedAt">,
>(channels: readonly Channel[], query: string): Channel[] {
  const words = teamChannelNameKey(channelNameFromInput(query));
  const rank = (channel: Channel) =>
    (channel.archivedAt === null ? 0 : 2) +
    (words !== "" && !teamChannelNameKey(channel.name).startsWith(words) ? 1 : 0);
  return channels
    .filter(
      (channel) =>
        (channel.kind === "public" || channel.kind === "private") &&
        teamChannelNameKey(channel.name).includes(words),
    )
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
}

/**
 * The people the reader can pick for a message or a channel: active, not the reader, and
 * answering to `query` by name or @handle. Those a word of whose name or handle starts with
 * it come first, then by name.
 */
export function pickablePeople<
  Member extends Pick<TeamMember, "userId" | "displayName" | "handle" | "state">,
>(members: Iterable<Member>, viewerUserId: string, query: string): Member[] {
  const words = query.trim().replace(/^@+/u, "").toLocaleLowerCase();
  const starts = (member: Member) =>
    [
      ...member.displayName.toLocaleLowerCase().split(/\s+/u),
      member.handle.toLocaleLowerCase(),
    ].some((word) => word.startsWith(words));
  return [...members]
    .filter(
      (member) =>
        member.state === "active" &&
        member.userId !== viewerUserId &&
        (member.displayName.toLocaleLowerCase().includes(words) ||
          member.handle.toLocaleLowerCase().includes(words)),
    )
    .sort(
      (left, right) =>
        Number(!starts(left)) - Number(!starts(right)) ||
        left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }),
    );
}
