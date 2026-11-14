/**
 * What the team screens draw, as plain values. Wiring maps the team client's
 * records onto these; the components never read a client or a route.
 */

export type Presence = "active" | "away";

/** A member as the viewer sees them. */
export interface PersonView {
  readonly id: string;
  readonly name: string;
  /** Unique per team, without "@"; their agent's handle is `<handle>-agent`. */
  readonly handle: string;
  /** A disc colour for the initial, when there is no photo. */
  readonly tint: string;
  readonly avatarUrl?: string | null | undefined;
  readonly presence?: Presence | null | undefined;
  /** The viewer themself: their agent reads "Your agent". */
  readonly you?: boolean | undefined;
}

export interface TeamTileView {
  readonly name: string;
  readonly color: string;
}

/** Who a row in a channel is by. An agent always carries its owner. */
export type AuthorView =
  | { readonly kind: "person"; readonly person: PersonView }
  | { readonly kind: "agent"; readonly owner: PersonView };

/**
 * A structured mention, in the words this viewer reads: their own agent is
 * "My agent", someone else's is "Maya's agent". `agent` is an ask its owner
 * made; `agent-reference` names someone else's agent and asks its owner.
 */
export interface MentionView {
  readonly handle: string;
  readonly label: string;
  readonly tone: "you" | "person" | "agent" | "agent-reference";
}

export interface FileView {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  /** The uploader's small preview (images only); the original loads only on open. */
  readonly previewUrl?: string | null | undefined;
}

/** A message the server has not confirmed, or refused. */
export type SendStateView =
  | { readonly kind: "sending" }
  | { readonly kind: "queued" }
  | { readonly kind: "failed"; readonly reason: string };

/** The live fact a thread summary shows about an agent at work in it. */
export type ThreadAgentFact =
  | { readonly kind: "working"; readonly owner: PersonView }
  | { readonly kind: "waiting-owner"; readonly owner: PersonView }
  | { readonly kind: "waiting-computer"; readonly owner: PersonView }
  | { readonly kind: "replied"; readonly owner: PersonView; readonly at: string };

export interface ThreadSummaryView {
  readonly replyCount: number;
  /** Newest first, at most a few; an agent's face is its owner's with the badge. */
  readonly repliers: readonly AuthorView[];
  readonly lastReplyAt: string;
  readonly agent: ThreadAgentFact | null;
}

/** What an agent's work did, by kind and count: never a file, page or query. */
export type StepKind =
  | "read-thread"
  | "searched-team"
  | "checked-knowledge"
  | "browsed"
  | "read-files"
  | "edited-files"
  | "ran-commands"
  | "used-integration"
  | "asked-owner";

export interface StepCount {
  readonly kind: StepKind;
  readonly count: number;
}

/** One ask of one person's agent in a thread, as its status card shows it. */
export interface AgentRequestView {
  readonly id: string;
  readonly owner: PersonView;
  readonly askedAt: string;
  readonly state:
    | {
        readonly kind: "waiting-computer";
        /** The owner's own name for it; others read "Maya's Mac". */
        readonly computerName: string;
        readonly lastSeenAt: string | null;
      }
    | { readonly kind: "queued"; readonly ahead: number }
    | {
        readonly kind: "working";
        readonly startedAt: string;
        readonly steps: readonly StepCount[];
        readonly current: StepKind | null;
      }
    | {
        readonly kind: "needs-owner";
        readonly steps: number;
        /** What the agent asked; only the owner is ever given it. */
        readonly ask: string | null;
      }
    | {
        readonly kind: "failed";
        /** Why; only the owner is ever given it. */
        readonly cause: string | null;
      }
    | {
        readonly kind: "stopped";
        readonly by: string;
        readonly steps: number;
        readonly at: string;
      }
    | { readonly kind: "cannot-post" };
}

export interface MessageView {
  readonly askStatuses?: readonly { id: string; label: string }[];
  readonly id: string;
  readonly author: AuthorView;
  readonly at: string;
  /** Markdown. Mentions are `@handle` in it, resolved by `mentions`. */
  readonly body: string;
  readonly mentions: readonly MentionView[];
  readonly files: readonly FileView[];
  readonly edited?: boolean | undefined;
  readonly pinnedBy?: string | null | undefined;
  readonly send?: SendStateView | null | undefined;
  /** On a root with replies. */
  readonly thread?: ThreadSummaryView | null | undefined;
  /** On an agent's reply: how long it worked, and whether this viewer may open the task. */
  readonly work?:
    | { readonly durationMs: number; readonly steps: number; readonly openable: boolean }
    | null
    | undefined;
  readonly canEdit?: boolean | undefined;
  readonly canDelete?: boolean | undefined;
}

/** A row in a channel or a thread. */
export type TimelineItem =
  | { readonly kind: "message"; readonly message: MessageView }
  | { readonly kind: "card"; readonly request: AgentRequestView }
  | {
      readonly kind: "system";
      readonly id: string;
      readonly at: string;
      readonly text: string;
      readonly icon?: "user" | "users" | "lock" | "pushpin" | undefined;
    };

export type ChannelKind = "public" | "private" | "dm" | "group-dm";

export interface ChannelInstructionsView {
  readonly text: string;
  readonly changedBy: string;
  readonly changedAt: string;
}

export interface ChannelView {
  readonly id: string;
  readonly kind: ChannelKind;
  /** A channel's name without "#"; for a DM, the other people's names. */
  readonly name: string;
  readonly description: string;
  readonly peopleOnly: boolean;
  /** Null while the team has not said how many are here. */
  readonly memberCount: number | null;
  /** A few faces for the header. */
  readonly faces: readonly PersonView[];
  /** A DM's other people. */
  readonly people?: readonly PersonView[] | undefined;
  readonly instructions: ChannelInstructionsView | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly pinCount: number;
  readonly canManage: boolean;
}

export type ChannelTab = "messages" | "files" | "pinned";

/** A channel or DM row in the sidebar. Unread is a dot of weight; only mentions are counted. */
export interface ChannelRowView {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly name: string;
  readonly people?: readonly PersonView[] | undefined;
  readonly unread: boolean;
  readonly mentions: number;
  readonly peopleOnly: boolean;
  readonly muted?: boolean | undefined;
}

/** How the viewer's app stands with one team's server. */
export type TeamConnection =
  | "online"
  | "reconnecting"
  | "offline"
  | "update-app"
  | "update-server"
  | "sign-in"
  | "removed"
  | "left";

export interface TeamSidebarView {
  readonly id: string;
  readonly tile: TeamTileView;
  readonly connection: TeamConnection;
  readonly channels: readonly ChannelRowView[];
  readonly dms: readonly ChannelRowView[];
}

/** The viewer's agent in a channel, which decides the composer's agent controls. */
export type MyAgentHere =
  | { readonly kind: "ready" }
  /** The channel is people only: agents can't be asked, read or search here. */
  | { readonly kind: "people-only" }
  /** No Opensteer is linked to this team, so asking would do nothing. */
  | { readonly kind: "not-linked" }
  /** A member with no computer of their own. */
  | { readonly kind: "no-computer" };

export interface StagedFileView {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly previewUrl?: string | null | undefined;
  readonly status: "uploading" | "ready" | "failed";
  /** 0 to 1 while uploading. */
  readonly progress?: number | undefined;
  readonly error?: string | null | undefined;
}

export interface TeamSend {
  readonly body: string;
  readonly toMyAgent: boolean;
}

/* ---- Files and pins ---- */

export interface ChannelFileView {
  readonly file: FileView;
  readonly sharedBy: AuthorView;
  readonly at: string;
  /** An excerpt of the message it came with. */
  readonly excerpt: string;
  readonly inThread: boolean;
  readonly pinned: boolean;
}

export interface PinView {
  readonly message: MessageView;
  readonly pinnedBy: string;
  readonly pinnedAt: string;
  readonly inThread: boolean;
}

/* ---- Details and members ---- */

export type NotifyLevel = "everything" | "mentions" | "nothing";

export type MemberEntryView =
  | { readonly kind: "person"; readonly person: PersonView; readonly manager: boolean }
  | {
      readonly kind: "group";
      readonly id: string;
      readonly name: string;
      readonly peopleCount: number;
      readonly manager: boolean;
    };

/* ---- Search ---- */

export interface SearchFilters {
  readonly channelId: string | null;
  /** A person's id, or `agent:<ownerId>` for a person's agent. */
  readonly authorId: string | null;
  readonly inThreads: boolean;
  readonly hasFile: boolean;
}

export interface SearchResultView {
  readonly message: MessageView;
  readonly channel: { readonly id: string; readonly name: string; readonly kind: ChannelKind };
  /** The root's opening words, when the hit is a reply. */
  readonly threadOf: string | null;
}

/* ---- Words ---- */

/** "Maya" from "Maya Chen": what possessives and short lines use. */
export function firstName(person: PersonView): string {
  return person.name.trim().split(/\s+/u)[0] ?? person.name;
}

/** "Your agent" to its owner, "Maya's agent" to everyone else. */
export function agentName(owner: PersonView): string {
  return owner.you ? "Your agent" : `${firstName(owner)}'s agent`;
}

export function authorName(author: AuthorView): string {
  return author.kind === "agent" ? agentName(author.owner) : author.person.name;
}

const stepWords: Readonly<Record<StepKind, readonly [past: string, now: string]>> = {
  "read-thread": ["Read the thread", "Reading the thread"],
  "searched-team": ["Searched the team", "Searching the team"],
  "checked-knowledge": ["Checked knowledge", "Checking knowledge"],
  browsed: ["Used the browser", "Using the browser"],
  "read-files": ["Read files", "Reading files"],
  "edited-files": ["Edited files", "Editing files"],
  "ran-commands": ["Ran commands", "Running commands"],
  "used-integration": ["Used an integration", "Using an integration"],
  "asked-owner": ["Asked its owner", "Asking its owner"],
};

export function stepWord(kind: StepKind, tense: "past" | "now"): string {
  return stepWords[kind][tense === "past" ? 0 : 1];
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function channelLabel(channel: { readonly kind: ChannelKind; readonly name: string }) {
  return channel.kind === "public" || channel.kind === "private"
    ? `#${channel.name}`
    : channel.name;
}
