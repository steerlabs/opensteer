import type { PendingTeamSend, TeamSidebar, TeamTimeline } from "@opensteer/client/team";
import { teamAgentHandle } from "@opensteer/core";
import type { TeamAgentRequest, TeamMember, TeamMessage } from "@opensteer/protocol";
import type {
  AgentCardView,
  AgentReach,
  AgentStatusView,
  AgentView,
  AttachmentView,
  ChannelHeaderView,
  ChannelKind,
  ChannelRowView,
  DmRowView,
  FaceView,
  MentionOption,
  MentionView,
  MessageView,
  PersonView,
  StepKind,
  TeamDrawerSectionView,
  ThreadSummaryView,
  TimelineItem,
} from "./team-models.js";
import type { TeamState } from "./mobile-teams.js";
import { firstName } from "./status-words.js";

/**
 * Wire rows to what team screens draw. Every word that depends on the reader
 * is resolved here, so components only lay out what they are handed; nothing
 * here decides access — the team's `can` facts do.
 */

export type MemberDirectory = ReadonlyMap<string, TeamMember>;

export function memberDirectory(members: readonly TeamMember[]): MemberDirectory {
  return new Map(members.map((member) => [member.userId, member]));
}

export function personView(
  userId: string,
  members: MemberDirectory,
  presence?: Readonly<Record<string, boolean>>,
): PersonView {
  const member = members.get(userId);
  const online = presence?.[userId];
  return {
    id: userId,
    name: member?.displayName ?? "Someone",
    handle: member?.handle ?? "someone",
    avatarUri: member?.image ?? null,
    presence: online === undefined ? null : online ? "active" : "away",
  };
}

export function agentView(ownerId: string, viewerId: string, members: MemberDirectory): AgentView {
  const owner = personView(ownerId, members);
  const mine = ownerId === viewerId;
  return { owner, byline: mine ? "Your agent" : `${owner.name}'s agent`, mine };
}

function channelKind(kind: TeamMessage["channelId"] extends never ? never : string): ChannelKind {
  return kind === "group_dm" ? "group-dm" : (kind as ChannelKind);
}

export function channelHeader(input: {
  readonly channel: NonNullable<TeamTimeline["channel"]>;
  /** Null until the channel's list has been read. */
  readonly memberCount: number | null;
  readonly people: readonly PersonView[];
}): ChannelHeaderView {
  const { channel } = input;
  return {
    id: channel.id,
    kind: channelKind(channel.kind),
    name: channel.name,
    description: null,
    memberCount: input.memberCount,
    peopleOnly: channel.peopleOnly,
    people: input.people,
    instructions: channel.instructionsMarkdown.trim() === "" ? null : channel.instructionsMarkdown,
  };
}

/** Where the reader's agent can be asked from this place: the team's `can` fact decides. */
export function agentReach(channel: NonNullable<TeamTimeline["channel"]>): AgentReach {
  if (channel.peopleOnly) return "people-only";
  return channel.can.wakeOwnAgent ? "available" : "not-connected";
}

/** One team's drawer section, from its sidebar answer. */
export function drawerSection(input: {
  readonly teamId: string;
  readonly name: string;
  readonly state: TeamState;
  readonly folded: boolean;
  readonly sidebar: TeamSidebar | null;
}): TeamDrawerSectionView {
  const rows = input.sidebar?.channels ?? [];
  const channels: ChannelRowView[] = rows
    .filter((row) => row.channel.kind === "public" || row.channel.kind === "private")
    .filter((row) => row.channel.archivedAt === null)
    .map((row) => ({
      id: row.channel.id,
      kind: row.channel.kind === "private" ? ("private" as const) : ("public" as const),
      name: row.channel.name,
      unread: row.unread,
      mentions: row.mentionCount,
      peopleOnly: row.channel.peopleOnly,
      muted: row.notificationLevel === "muted",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const dmRows = rows
    .filter((row) => row.channel.kind === "dm" || row.channel.kind === "group_dm")
    .sort((left, right) => compareIds(right.channel.latestMessageId, left.channel.latestMessageId));
  const dms: DmRowView[] = dmRows.map((row) => ({
    id: row.channel.id,
    people: [],
    label: row.channel.name,
    unread: row.unread,
    mentions: row.mentionCount,
  }));
  return {
    team: { id: input.teamId, name: input.name, imageUri: null },
    folded: input.folded,
    mentionTotal: input.sidebar?.totalMentionCount ?? 0,
    unread: rows.some((row) => row.unread && row.notificationLevel !== "muted"),
    state:
      input.state === "update-app"
        ? "update-app"
        : input.state === "update-server"
          ? "update-server"
          : input.state === "removed"
            ? "removed"
            : input.state === "live" || input.state === "loading"
              ? "live"
              : "offline",
    channels,
    dms,
  };
}

function compareIds(left: string | null, right: string | null): number {
  const a = BigInt(left ?? "0");
  const b = BigInt(right ?? "0");
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

/** What a request's card shows, or null where the reply itself stands in for it. */
export function statusView(
  request: TeamAgentRequest,
  input: {
    readonly viewerId: string;
    readonly members: MemberDirectory;
    readonly ownerOnline: boolean | null;
    readonly time: (iso: string) => string;
  },
): AgentStatusView | null {
  const mine = request.ownerUserId === input.viewerId;
  const steps = request.steps.reduce((total, step) => total + step.count, 0);
  switch (request.state) {
    case "awaiting_approval":
    case "declined":
      return null;
    case "queued":
      return input.ownerOnline === false
        ? {
            state: "offline",
            computer: mine
              ? "your computer"
              : `${firstName(personView(request.ownerUserId, input.members).name)}'s computer`,
            askedAt: input.time(request.createdAt),
            lastSeen: null,
          }
        : { state: "queued", ahead: 0 };
    case "working": {
      const last = request.steps.at(-1);
      return {
        state: "working",
        stepCount: steps,
        startedAt: Date.parse(request.acceptedAt ?? request.createdAt),
        liveStep: last === undefined ? null : stepKinds[last.kind],
      };
    }
    case "needs_you":
      return { state: "needs-owner", ask: null };
    case "failed":
      return request.failureCode === "access_revoked" || request.failureCode === "link_revoked"
        ? { state: "blocked" }
        : { state: "failed", cause: mine ? failureCause(request.failureCode) : null };
    case "stopped":
      return {
        state: "stopped",
        by: mine ? "you" : firstName(personView(request.ownerUserId, input.members).name),
        stepCount: steps,
      };
    case "done":
    case "cancelled":
      return null;
  }
}

function failureCause(code: TeamAgentRequest["failureCode"]): string | null {
  switch (code) {
    case "expired":
      return "It waited a week without starting.";
    case "trigger_deleted":
      return "The message it was asked in was deleted.";
    case "execution_failed":
      return "The task stopped with an error. Open it to see why.";
    default:
      return null;
  }
}

/** The one live fact under a root, from the requests the team reports on it. */
function liveFact(
  requests: readonly TeamAgentRequest[],
  viewerId: string,
  members: MemberDirectory,
): Pick<ThreadSummaryView, "fact" | "factTone" | "live"> | null {
  const active = requests.find((request) =>
    ["queued", "working", "needs_you"].includes(request.state),
  );
  if (active === undefined) return null;
  const agent = agentView(active.ownerUserId, viewerId, members);
  if (active.state === "needs_you")
    return {
      fact: agent.mine
        ? "Your agent needs you"
        : `${agent.byline} is waiting for ${firstName(agent.owner.name)}`,
      factTone: "amber",
      live: false,
    };
  return {
    fact: `${agent.byline} is ${active.state === "working" ? "working" : "about to start"}`,
    factTone: "ember",
    live: active.state === "working",
  };
}

function threadSummary(
  message: TeamMessage,
  viewerId: string,
  members: MemberDirectory,
): ThreadSummaryView | null {
  const live = liveFact(message.requests, viewerId, members);
  if (message.replySummary.count === 0 && live === null) return null;
  const faces: FaceView[] = message.replySummary.repliers.map((userId) => ({
    kind: "person",
    person: personView(userId, members),
  }));
  return {
    replyCount: message.replySummary.count,
    faces,
    ...(live ?? { fact: "View thread", factTone: "muted" as const, live: false }),
  };
}

/** A structured mention, in the reader's words. */
export function mentionView(
  mention: TeamMessage["mentions"][number],
  message: { readonly authorKind: TeamMessage["authorKind"]; readonly authorUserId: string },
  viewerId: string,
  members: MemberDirectory,
): MentionView {
  const member = members.get(mention.userId);
  const handle = member?.handle ?? "someone";
  if (mention.kind === "agent") {
    const mine = mention.userId === viewerId;
    return {
      handle: teamAgentHandle(handle),
      label: mine ? "@My agent" : `@${member?.displayName ?? "Someone"}'s agent`,
      // Only its owner wakes an agent, and an agent's own words never do.
      kind:
        message.authorKind === "human" && message.authorUserId === mention.userId
          ? "agent-live"
          : "agent-inert",
    };
  }
  return {
    handle,
    label: `@${member?.displayName ?? handle}`,
    kind: mention.userId === viewerId ? "me" : "person",
  };
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentView(
  file: TeamMessage["attachments"][number],
  previews: ReadonlyMap<string, string>,
): AttachmentView {
  const uri = previews.get(file.id);
  return {
    id: file.id,
    name: file.filename,
    kind: file.preview !== null && file.mediaType.startsWith("image/") ? "image" : "file",
    size: fileSize(file.sizeBytes),
    preview: uri === undefined ? null : { uri, width: 240, height: 180 },
  };
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  const start = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", weekday: "short" });
}

export function messageView(
  message: TeamMessage,
  input: {
    readonly viewerId: string;
    readonly members: MemberDirectory;
    readonly presence?: Readonly<Record<string, boolean>>;
    readonly previews: ReadonlyMap<string, string>;
    readonly previous: TeamMessage | null;
    readonly requests: readonly TeamAgentRequest[];
    readonly inThread: boolean;
  },
): MessageView {
  const { viewerId, members } = input;
  const agent = message.authorKind === "agent";
  const previous = input.previous;
  const continued =
    previous !== null &&
    previous.authorUserId === message.authorUserId &&
    previous.authorKind === message.authorKind &&
    previous.deletedAt === null &&
    Date.parse(message.createdAt) - Date.parse(previous.createdAt) < 5 * 60_000;
  const answered = agent
    ? input.requests.find((request) => request.replyMessageId === message.id)
    : undefined;
  const deleted = message.deletedAt !== null;
  return {
    id: message.id,
    version: Number(BigInt(message.changeSeq) % BigInt(Number.MAX_SAFE_INTEGER)),
    author: agent
      ? { kind: "agent", agent: agentView(message.authorUserId, viewerId, members) }
      : {
          kind: "person",
          person: personView(message.authorUserId, members, input.presence),
          mine: message.authorUserId === viewerId,
        },
    time: clockTime(message.createdAt),
    text: deleted ? "_This message was deleted._" : message.bodyMarkdown,
    mentions: deleted
      ? []
      : message.mentions.map((mention) => mentionView(mention, message, viewerId, members)),
    attachments: deleted
      ? []
      : message.attachments.map((file) => attachmentView(file, input.previews)),
    edited: message.editedAt !== null && !deleted,
    pinned: message.pinned,
    continued,
    send: { kind: "sent" },
    thread: input.inThread ? null : threadSummary(message, viewerId, members),
    agentRun: answered === undefined ? null : { summary: workedSummary(answered) },
  };
}

function workedSummary(request: TeamAgentRequest): string {
  const steps = request.steps.reduce((total, step) => total + step.count, 0);
  const started = Date.parse(request.acceptedAt ?? request.createdAt);
  const finished = Date.parse(request.finishedAt ?? request.createdAt);
  const minutes = Math.max(1, Math.round((finished - started) / 60_000));
  return `Worked ${minutes}m · ${steps === 1 ? "1 step" : `${steps} steps`}`;
}

/**
 * The newest reply by the reader's own agent that is on screen in a thread: the
 * one whose task reading it reads. A later reply arriving in an open thread is
 * a new one to read; a reply scrolled out of view is none.
 */
export function ownReplyInView(
  messages: readonly Pick<TeamMessage, "id" | "authorKind" | "authorUserId">[],
  viewerId: string,
  rootId: string,
  visible: ReadonlySet<string>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      message.id !== rootId &&
      message.authorKind === "agent" &&
      message.authorUserId === viewerId &&
      visible.has(message.id)
    )
      return message.id;
  }
  return null;
}

/** A message this phone sent that the team has not confirmed yet, drawn in place. */
function pendingView(
  send: PendingTeamSend,
  viewerId: string,
  members: MemberDirectory,
  connected: boolean,
): MessageView {
  return {
    id: `pending:${send.command.clientMessageId}`,
    version: 0,
    author: { kind: "person", person: personView(viewerId, members), mine: true },
    time: clockTime(send.createdAt),
    text: send.command.bodyMarkdown,
    mentions: send.command.mentions.map((mention) =>
      mentionView(mention, { authorKind: "human", authorUserId: viewerId }, viewerId, members),
    ),
    attachments: [],
    edited: false,
    pinned: false,
    continued: false,
    send:
      send.failure !== null
        ? { kind: "failed", reason: send.failure }
        : connected
          ? { kind: "sending" }
          : { kind: "queued" },
    thread: null,
    agentRun: null,
  };
}

/**
 * A channel's or thread's rows, oldest first: day pills, the NEW line at the
 * first unread message, messages, live cards under the message that asked,
 * and this phone's unconfirmed sends at the foot.
 */
export function timelineItems(input: {
  readonly timeline: TeamTimeline;
  readonly viewerId: string;
  readonly members: MemberDirectory;
  readonly presence?: Readonly<Record<string, boolean>>;
  readonly previews: ReadonlyMap<string, string>;
  readonly lastReadMessageId: string | null;
  readonly pending: readonly PendingTeamSend[];
  readonly connected: boolean;
  readonly now: Date;
  /** In a thread the root is drawn above the list, not in it. */
  readonly skipId?: string;
}): TimelineItem[] {
  const { timeline, viewerId, members } = input;
  const items: TimelineItem[] = [];
  const inThread = timeline.scope.kind === "thread";
  const requests = [
    ...timeline.requests,
    ...timeline.messages.flatMap((message) => message.requests),
  ];
  const online = new Map(timeline.linkPresence.map((row) => [row.ownerUserId, row.online]));
  let previous: TeamMessage | null = null;
  let day: string | null = null;
  let newPlaced = input.lastReadMessageId === null;
  for (const message of timeline.messages) {
    if (message.id === input.skipId) {
      previous = message;
      continue;
    }
    const label = dayLabel(message.createdAt, input.now);
    if (label !== day) {
      items.push({ kind: "day", id: `day:${message.id}`, label });
      day = label;
      previous = null;
    }
    if (
      !newPlaced &&
      input.lastReadMessageId !== null &&
      BigInt(message.id) > BigInt(input.lastReadMessageId) &&
      message.authorUserId !== viewerId
    ) {
      items.push({ kind: "new", id: "new" });
      newPlaced = true;
    }
    items.push({
      kind: "message",
      message: messageView(message, {
        viewerId,
        members,
        ...(input.presence === undefined ? {} : { presence: input.presence }),
        previews: input.previews,
        previous,
        requests,
        inThread,
      }),
    });
    previous = message;
    if (inThread) {
      for (const request of uniqueRequests(requests)) {
        if (request.triggerMessageId !== message.id) continue;
        const status = statusView(request, {
          viewerId,
          members,
          ownerOnline: online.get(request.ownerUserId) ?? null,
          time: clockTime,
        });
        if (status === null) continue;
        items.push({ kind: "card", card: cardView(request, status, viewerId, members) });
      }
    }
  }
  const scope = timeline.scope;
  for (const send of input.pending) {
    const command = send.command;
    if (command.channelId !== scope.channelId) continue;
    const root = command.threadRootId ?? null;
    if (scope.kind === "channel" ? root !== null : root !== scope.rootId) continue;
    items.push({
      kind: "message",
      message: pendingView(send, viewerId, members, input.connected),
    });
  }
  return items;
}

function uniqueRequests(requests: readonly TeamAgentRequest[]): TeamAgentRequest[] {
  const byId = new Map<string, TeamAgentRequest>();
  for (const request of requests) {
    const held = byId.get(request.id);
    if (held === undefined || BigInt(request.changeSeq) >= BigInt(held.changeSeq))
      byId.set(request.id, request);
  }
  return [...byId.values()];
}

export function cardView(
  request: TeamAgentRequest,
  status: AgentStatusView,
  viewerId: string,
  members: MemberDirectory,
): AgentCardView {
  return {
    id: request.id,
    version: Number(BigInt(request.changeSeq) % BigInt(Number.MAX_SAFE_INTEGER)),
    agent: agentView(request.ownerUserId, viewerId, members),
    status,
  };
}

/**
 * The @ list: My agent first (or why it can't be asked here), then people,
 * filtered by what was typed. Another person's agent is listed only when its
 * name or handle is typed, and inert.
 */
export function mentionOptions(input: {
  readonly query: string;
  readonly viewerId: string;
  readonly members: readonly TeamMember[];
  readonly reach: AgentReach;
}): MentionOption[] {
  const query = input.query.toLowerCase();
  const me = input.members.find((member) => member.userId === input.viewerId);
  const options: MentionOption[] = [];
  if (input.reach !== "people-only") {
    const handle = me === undefined ? null : teamAgentHandle(me.handle);
    if (
      query === "" ||
      "my agent".startsWith(query) ||
      (handle !== null && handle.startsWith(query))
    )
      options.push({
        kind: "my-agent",
        detail:
          input.reach === "available"
            ? `Others see “${me?.displayName ?? "your"}'s agent”${handle === null ? "" : ` · @${handle}`}`
            : "Connect your Opensteer to ask it here",
        disabled: input.reach !== "available",
      });
  }
  for (const member of input.members) {
    if (member.userId === input.viewerId || member.state !== "active") continue;
    const name = member.displayName.toLowerCase();
    if (query === "" || name.includes(query) || member.handle.startsWith(query))
      options.push({
        kind: "person",
        person: personView(member.userId, memberDirectory([member])),
      });
    const agentHandle = teamAgentHandle(member.handle);
    if (query.length >= 2 && (agentHandle.startsWith(query) || `${name}'s agent`.startsWith(query)))
      options.push({
        kind: "agent",
        owner: personView(member.userId, memberDirectory([member])),
        label: `${member.displayName}'s agent`,
      });
    if (options.length >= 12) break;
  }
  return options;
}

/** Who is typing, in one reserved line. */
export function typingLine(
  userIds: readonly string[],
  viewerId: string,
  members: MemberDirectory,
): string | null {
  const names = userIds
    .filter((id) => id !== viewerId)
    .map((id) => firstName(personView(id, members).name));
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return "Several people are typing";
}
