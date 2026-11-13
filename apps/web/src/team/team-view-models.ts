import { teamAskStatuses } from "@opensteer/client/team";
import type {
  TeamAgentRequest,
  TeamChannel,
  TeamMember,
  TeamMessage,
  TeamFileSchema,
} from "@opensteer/protocol";
import type { TeamSidebar, TeamTimeline } from "@opensteer/client/team";
import type { z } from "zod";
import type {
  AgentRequestView,
  AuthorView,
  ChannelKind,
  ChannelRowView,
  FileView,
  MentionView,
  MessageView,
  PersonView,
  SendStateView,
  StepCount,
  StepKind,
  TeamConnection,
  TeamSidebarView,
  TeamTileView,
  ThreadAgentFact,
  TimelineItem,
} from "../components/team/team-models.js";
import { firstName } from "../components/team/team-models.js";
import { personView, unknownPerson } from "./team-people.js";

type TeamFile = z.infer<typeof TeamFileSchema>;

/** What every mapper needs to say things in this viewer's words. */
export interface TeamWords {
  readonly viewerUserId: string;
  readonly members: ReadonlyMap<string, TeamMember>;
  /** Owners whose Opensteer is connected to the team right now. */
  readonly linkOnline: ReadonlyMap<string, boolean>;
  readonly previews: ReadonlyMap<string, string>;
  readonly managedChannels: ReadonlySet<string>;
}

export function person(words: TeamWords, userId: string): PersonView {
  const member = words.members.get(userId);
  return member ? personView(member, words.viewerUserId) : unknownPerson(userId);
}

export function channelKind(kind: TeamChannel["kind"]): ChannelKind {
  return kind === "group_dm" ? "group-dm" : kind;
}

const directKinds = new Set<TeamChannel["kind"]>(["dm", "group_dm"]);

/** The team's sidebar: channels by name, then direct messages by latest activity. */
export function sidebarView(input: {
  readonly teamId: string;
  readonly tile: TeamTileView;
  readonly connection: TeamConnection;
  readonly sidebar: TeamSidebar | null;
}): TeamSidebarView {
  const rows = (input.sidebar?.channels ?? []).filter((entry) => !entry.channel.archivedAt);
  const row = (entry: TeamSidebar["channels"][number]): ChannelRowView => ({
    id: entry.channel.id,
    kind: channelKind(entry.channel.kind),
    name: entry.channel.name,
    unread: entry.unread,
    mentions: entry.mentionCount,
    peopleOnly: entry.channel.peopleOnly,
    muted: entry.notificationLevel === "muted",
  });
  const channels = rows
    .filter((entry) => !directKinds.has(entry.channel.kind))
    .sort((left, right) => left.channel.name.localeCompare(right.channel.name))
    .map(row);
  const dms = rows
    .filter((entry) => directKinds.has(entry.channel.kind))
    .sort((left, right) => compareIds(right.channel.latestMessageId, left.channel.latestMessageId))
    .map(row);
  return {
    id: input.teamId,
    tile: input.tile,
    connection: input.connection,
    channels,
    dms,
  };
}

export function compareIds(left: string | null, right: string | null): number {
  const a = BigInt(left ?? "0"),
    b = BigInt(right ?? "0");
  return a < b ? -1 : a > b ? 1 : 0;
}

const stepKinds: Readonly<Record<TeamAgentRequest["steps"][number]["kind"], StepKind>> = {
  browsed: "browsed",
  read_files: "read-files",
  edited_files: "edited-files",
  ran_commands: "ran-commands",
  used_integration: "used-integration",
  searched_team: "searched-team",
  asked_you: "asked-owner",
};

function steps(request: TeamAgentRequest): readonly StepCount[] {
  return request.steps.map((step) => ({ kind: stepKinds[step.kind], count: step.count }));
}

function stepTotal(request: TeamAgentRequest): number {
  return request.steps.reduce((sum, step) => sum + step.count, 0);
}

const failureWords: Readonly<Record<NonNullable<TeamAgentRequest["failureCode"]>, string>> = {
  expired: "The ask expired before it could finish.",
  access_revoked: "Access changed before it could post.",
  link_revoked: "Your Opensteer is no longer connected to this team.",
  trigger_deleted: "The message it answered was deleted.",
  trigger_edited: "The message it answered was edited.",
  execution_failed: "It stopped with an error. Open the task to see why.",
};

/** A status card for one ask, or null once its reply is the row. */
export function requestView(words: TeamWords, request: TeamAgentRequest): AgentRequestView | null {
  const owner = person(words, request.ownerUserId);
  const base = { id: request.id, owner, askedAt: request.createdAt };
  switch (request.state) {
    case "awaiting_approval":
    case "declined":
      return null;
    case "queued":
      return words.linkOnline.get(request.ownerUserId) === false
        ? {
            ...base,
            state: {
              kind: "waiting-computer",
              computerName: owner.you ? "your computer" : `${firstName(owner)}’s computer`,
              lastSeenAt: null,
            },
          }
        : { ...base, state: { kind: "queued", ahead: 0 } };
    case "working": {
      const counted = steps(request);
      return {
        ...base,
        state: {
          kind: "working",
          startedAt: request.acceptedAt ?? request.createdAt,
          steps: counted,
          current: counted.at(-1)?.kind ?? null,
        },
      };
    }
    case "needs_you":
      return { ...base, state: { kind: "needs-owner", steps: stepTotal(request), ask: null } };
    case "failed":
      return request.failureCode === "access_revoked"
        ? { ...base, state: { kind: "cannot-post" } }
        : {
            ...base,
            state: {
              kind: "failed",
              cause: owner.you && request.failureCode ? failureWords[request.failureCode] : null,
            },
          };
    case "stopped":
    case "cancelled":
      return {
        ...base,
        state: {
          kind: "stopped",
          by: owner.name,
          steps: stepTotal(request),
          at: request.finishedAt ?? request.createdAt,
        },
      };
    case "done":
      return null;
  }
}

/** The one live fact a thread summary tells about agents at work under a root. */
export function threadFact(
  words: TeamWords,
  requests: readonly TeamAgentRequest[],
): ThreadAgentFact | null {
  const live = [...requests].reverse();
  const working = live.find((request) => request.state === "working");
  if (working) return { kind: "working", owner: person(words, working.ownerUserId) };
  const waiting = live.find((request) => request.state === "needs_you");
  if (waiting) return { kind: "waiting-owner", owner: person(words, waiting.ownerUserId) };
  const queued = live.find(
    (request) => request.state === "queued" && words.linkOnline.get(request.ownerUserId) === false,
  );
  if (queued) return { kind: "waiting-computer", owner: person(words, queued.ownerUserId) };
  const replied = live.find((request) => request.state === "done" && request.finishedAt);
  return replied
    ? { kind: "replied", owner: person(words, replied.ownerUserId), at: replied.finishedAt! }
    : null;
}

export function mentionViews(words: TeamWords, message: TeamMessage): readonly MentionView[] {
  return message.mentions.map((mention) => {
    const member = words.members.get(mention.userId);
    const owner = person(words, mention.userId);
    if (mention.kind === "person")
      return {
        handle: member?.handle ?? owner.handle,
        label: owner.name,
        tone: mention.userId === words.viewerUserId ? "you" : "person",
      };
    return {
      handle: `${member?.handle ?? owner.handle}-agent`,
      label: owner.you ? "My agent" : `${firstName(owner)}’s agent`,
      tone: message.authorUserId === mention.userId ? "agent" : "agent-reference",
    };
  });
}

export function fileView(words: TeamWords, file: TeamFile): FileView {
  return {
    id: file.id,
    name: file.filename,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    previewUrl: words.previews.get(file.id) ?? null,
  };
}

export function author(words: TeamWords, message: TeamMessage): AuthorView {
  const owner = person(words, message.authorUserId);
  return message.authorKind === "agent"
    ? { kind: "agent", owner }
    : { kind: "person", person: owner };
}

export function messageView(
  words: TeamWords,
  message: TeamMessage,
  options: {
    readonly send?: SendStateView | null;
    readonly requests?: readonly TeamAgentRequest[];
  } = {},
): MessageView {
  const mine = message.authorUserId === words.viewerUserId && message.authorKind === "human";
  const reply = message.agentRequestId
    ? (options.requests ?? message.requests).find((row) => row.id === message.agentRequestId)
    : undefined;
  const replies = message.replySummary;
  return {
    askStatuses: teamAskStatuses(
      [...(options.requests ?? []), ...message.requests],
      message.id,
      (id) => person(words, id).name,
    ),
    id: message.id,
    author: author(words, message),
    at: message.createdAt,
    body: message.deletedAt ? "_This message was deleted._" : message.bodyMarkdown,
    mentions: mentionViews(words, message),
    files: message.attachments.map((file) => fileView(words, file)),
    edited: message.editedAt !== null,
    pinnedBy: message.pinned ? "" : null,
    send: options.send ?? null,
    thread:
      replies.count > 0 || message.requests.length > 0
        ? {
            replyCount: replies.count,
            repliers: replies.repliers.map((userId) => ({
              kind: "person" as const,
              person: person(words, userId),
            })),
            lastReplyAt: message.createdAt,
            agent: threadFact(words, message.requests),
          }
        : null,
    work: reply
      ? {
          durationMs:
            reply.finishedAt && reply.acceptedAt
              ? Date.parse(reply.finishedAt) - Date.parse(reply.acceptedAt)
              : 0,
          steps: stepTotal(reply),
          openable: reply.ownerUserId === words.viewerUserId,
        }
      : null,
    canEdit: mine && !message.deletedAt,
    canDelete: (mine || words.managedChannels.has(message.channelId)) && !message.deletedAt,
  };
}

/** A message the server has not confirmed yet, drawn from what was sent. */
export function pendingView(
  words: TeamWords,
  send: {
    readonly clientMessageId: string;
    readonly bodyMarkdown: string;
    readonly createdAt: string;
    readonly mentions: readonly { readonly userId: string; readonly kind: "person" | "agent" }[];
  },
  state: SendStateView,
): MessageView {
  const me = person(words, words.viewerUserId);
  return {
    id: `pending:${send.clientMessageId}`,
    author: { kind: "person", person: me },
    at: send.createdAt,
    body: send.bodyMarkdown,
    mentions: send.mentions.map((mention) => {
      const owner = person(words, mention.userId);
      return mention.kind === "person"
        ? { handle: owner.handle, label: owner.name, tone: owner.you ? "you" : "person" }
        : {
            handle: `${owner.handle}-agent`,
            label: owner.you ? "My agent" : `${firstName(owner)}’s agent`,
            tone: mention.userId === words.viewerUserId ? "agent" : "agent-reference",
          };
    }),
    files: [],
    canEdit: state.kind === "failed",
    canDelete: state.kind === "failed",
    send: state,
  };
}

/**
 * A timeline in rows: messages in order, each live ask's card right after the
 * message that asked, and unconfirmed sends at the end in written order.
 */
export function timelineItems(
  words: TeamWords,
  timeline: TeamTimeline,
  pending: readonly MessageView[],
  cards: boolean,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const replied = new Set(
    timeline.messages.flatMap((message) =>
      message.agentRequestId ? [message.agentRequestId] : [],
    ),
  );
  const asks = new Map<string, TeamAgentRequest[]>();
  if (cards)
    for (const request of timeline.requests) {
      if (replied.has(request.id) || request.kind === "ask") continue;
      asks.set(request.triggerMessageId, [...(asks.get(request.triggerMessageId) ?? []), request]);
    }
  for (const message of timeline.messages) {
    items.push({
      kind: "message",
      message: messageView(words, message, { requests: timeline.requests }),
    });
    for (const request of asks.get(message.id) ?? []) {
      const card = requestView(words, request);
      if (card) items.push({ kind: "card", request: card });
    }
  }
  for (const message of pending) items.push({ kind: "message", message });
  return items;
}
