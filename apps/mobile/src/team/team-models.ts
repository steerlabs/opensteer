import type { TaskMarkView } from "../home/home-models.js";

/**
 * What team screens draw, as plain values.
 *
 * These are view models, not wire types: every word that depends on who is
 * reading ("Your agent" or "Maya's agent", "@My agent" or "@Tim's agent") is
 * already resolved for the reader, and every time is already formatted, so a
 * component only lays out what it is handed.
 */

/** A team's square mark: its initial on its own colour. */
export interface TeamTileView {
  readonly id: string;
  readonly name: string;
  /** A photo the team chose, shown instead of the initial when present. */
  readonly imageUri: string | null;
}

export interface PersonView {
  readonly id: string;
  readonly name: string;
  /** Unique per team, set at join and never edited: "maya". */
  readonly handle: string;
  readonly avatarUri: string | null;
  /** Only avatars on screen hear presence; null where it is not followed. */
  readonly presence: "active" | "away" | null;
}

/** Someone's one agent, named for the reader: "Your agent" or "Maya's agent". */
export interface AgentView {
  readonly owner: PersonView;
  readonly byline: string;
  /** The reader owns it: only they can ask it, open its task or stop it. */
  readonly mine: boolean;
}

/** A face in a summary or a byline: a person, or a person's agent (their face with the orb). */
export type FaceView =
  | { readonly kind: "person"; readonly person: PersonView }
  | { readonly kind: "agent"; readonly owner: PersonView };

/**
 * A structured mention, found in a message's Markdown by its plain handle
 * (`@maya`, `@maya-agent`) and drawn with the reader's own words.
 */
export interface MentionView {
  readonly handle: string;
  /** "@My agent", "@Maya's agent", "@Maya Chen". */
  readonly label: string;
  /**
   * `agent-live` woke its owner's agent (ember, with the orb); `agent-inert`
   * names someone else's agent and woke nothing (outlined, grey); `me` is the
   * reader (amber); `person` is anyone else.
   */
  readonly kind: "agent-live" | "agent-inert" | "me" | "person";
}

/** A file attached to a message. Images carry a small preview; the original loads on open. */
export interface AttachmentView {
  readonly id: string;
  readonly name: string;
  readonly kind: "image" | "file";
  /** "2.4 MB". */
  readonly size: string;
  readonly preview: {
    readonly uri: string;
    readonly width: number;
    readonly height: number;
  } | null;
}

/** A file waiting in the composer. */
export interface StagedAttachmentView {
  readonly id: string;
  readonly name: string;
  readonly kind: "image" | "file";
  readonly previewUri: string | null;
  /** 0–1 while uploading; null once uploaded. */
  readonly progress: number | null;
  /** Why it can't be sent, said on the chip before anything is sent: "Over 100 MB". */
  readonly refused: string | null;
}

export type SendState =
  | { readonly kind: "sent" }
  /** Not confirmed after a moment: "Sending…" takes the time's place. */
  | { readonly kind: "sending" }
  /** Offline: it sends, in order, when the team is reachable again. */
  | { readonly kind: "queued" }
  | { readonly kind: "failed"; readonly reason: string };

/** Under a root message: who replied, how many, and the one live fact. */
export interface ThreadSummaryView {
  readonly replyCount: number;
  readonly faces: readonly FaceView[];
  /** "Your agent is working", "Maya's agent is waiting for Maya", "Last reply 2m ago". */
  readonly fact: string;
  readonly factTone: "ember" | "amber" | "muted";
  /** An agent is working in the thread right now. */
  readonly live: boolean;
}

export type MessageAuthor =
  | { readonly kind: "person"; readonly person: PersonView; readonly mine: boolean }
  | { readonly kind: "agent"; readonly agent: AgentView };

export interface MessageView {
  readonly id: string;
  /** Bumps on every edit, pin or summary change; a row redraws only when this does. */
  readonly version: number;
  readonly author: MessageAuthor;
  /** "9:04". */
  readonly time: string;
  /** Markdown, with mentions written as their plain handles. */
  readonly text: string;
  readonly mentions: readonly MentionView[];
  readonly attachments: readonly AttachmentView[];
  readonly edited: boolean;
  readonly pinned: boolean;
  /** Same author within five minutes of the row above: no face, no name. */
  readonly continued: boolean;
  readonly send: SendState;
  /** On a root in a channel or DM; null in a thread and on roots nobody replied to. */
  readonly thread: ThreadSummaryView | null;
  /** On an agent's reply: "Worked 1m · 4 steps". */
  readonly agentRun: { readonly summary: string } | null;
}

/**
 * The step kinds a status card may name: kinds and counts only, never what
 * was opened, read or run. The targets stay in the owner's private task.
 */
export type StepKind =
  | "read-thread"
  | "browsed"
  | "read-files"
  | "edited-files"
  | "ran-commands"
  | "used-integration"
  | "searched-team"
  | "checked-knowledge"
  | "asked-owner";

/** What a team request is doing, as the channel may see it. */
export type AgentStatusView =
  | {
      /** The owner's computer is offline; the ask waits for it. */
      readonly state: "offline";
      /** "Maya's Mac" for everyone else, "your MacBook Pro" for the owner. */
      readonly computer: string;
      readonly askedAt: string;
      readonly lastSeen: string | null;
    }
  | {
      /** Waiting behind the owner's other asks (one agent, one rate). */
      readonly state: "queued";
      readonly ahead: number;
    }
  | {
      readonly state: "working";
      readonly stepCount: number;
      /** Epoch milliseconds; the elapsed time is counted on the phone. */
      readonly startedAt: number;
      readonly liveStep: StepKind | null;
    }
  | {
      /** The agent asked its owner something. */
      readonly state: "needs-owner";
      /** The question itself, which only the owner's own Opensteer knows; null for everyone else. */
      readonly ask: string | null;
    }
  | {
      readonly state: "failed";
      /** Why, for the owner only. */
      readonly cause: string | null;
    }
  | {
      readonly state: "stopped";
      /** "Maya", or "you". */
      readonly by: string;
      readonly stepCount: number;
    }
  | {
      /** Access changed before the reply could post; nothing was posted. */
      readonly state: "blocked";
    };

/** An agent's live card in a thread: a row by the agent, whose body is the card. */
export interface AgentCardView {
  /** The request it stands for. */
  readonly id: string;
  readonly version: number;
  readonly agent: AgentView;
  readonly status: AgentStatusView;
}

export type TimelineItem =
  | { readonly kind: "day"; readonly id: string; readonly label: string }
  | { readonly kind: "new"; readonly id: string }
  | { readonly kind: "message"; readonly message: MessageView }
  | { readonly kind: "card"; readonly card: AgentCardView }
  /** One line the team writes: "Sam made #support people only". */
  | { readonly kind: "system"; readonly id: string; readonly text: string };

export type ChannelKind = "public" | "private" | "dm" | "group-dm";

export interface ChannelHeaderView {
  readonly id: string;
  readonly kind: ChannelKind;
  /** "support", or the person's name in a DM, or "Leo, Priya". */
  readonly name: string;
  readonly description: string | null;
  readonly memberCount: number;
  readonly peopleOnly: boolean;
  /** The other people in a DM, for its faces. */
  readonly people: readonly PersonView[];
  /** Shown at the start of a channel; everyone here can read them. */
  readonly instructions: string | null;
}

/** Where the reader's agent can be asked from this composer. */
export type AgentReach =
  /** Linked: the pill and @ My agent work. */
  | "available"
  /** People only: no pill, no My agent, a badge instead. */
  | "people-only"
  /** No Opensteer linked to this team (or none at all): asking opens "Connect your Opensteer". */
  | "not-connected";

export type MentionOption =
  | {
      readonly kind: "my-agent";
      /** "Others see “Tim's agent”", or why it can't be asked from here. */
      readonly detail: string;
      readonly disabled: boolean;
    }
  | { readonly kind: "person"; readonly person: PersonView }
  /** Someone else's agent: listed only when its name is typed, and inert. */
  | { readonly kind: "agent"; readonly owner: PersonView; readonly label: string };

export interface JumpView {
  readonly direction: "up" | "down";
  /** "6 new", "6 new since 9:12". */
  readonly label: string;
}

export interface ConnectionBannerView {
  /** "Reconnecting to Acme…", "Your MacBook Pro is offline. Asks to your agent start when it's back". */
  readonly text: string;
  readonly tone: "muted" | "amber" | "danger";
  readonly action: { readonly label: string; readonly onPress: () => void } | null;
}

/** One channel row in the drawer. */
export interface ChannelRowView {
  readonly id: string;
  readonly kind: "public" | "private";
  readonly name: string;
  readonly unread: boolean;
  readonly mentions: number;
  readonly peopleOnly: boolean;
  readonly muted: boolean;
}

/** One DM row in the drawer. A DM has a dot and mentions, never an unread number. */
export interface DmRowView {
  readonly id: string;
  readonly people: readonly PersonView[];
  readonly label: string;
  readonly unread: boolean;
  readonly mentions: number;
}

export interface TeamDrawerSectionView {
  readonly team: TeamTileView;
  readonly folded: boolean;
  /** Mentions of the reader across the team, shown on a folded header. */
  readonly mentionTotal: number;
  readonly unread: boolean;
  /** `removed` keeps one row until it is taken out of the drawer. */
  readonly state: "live" | "offline" | "update-app" | "update-server" | "removed";
  readonly channels: readonly ChannelRowView[];
  readonly dms: readonly DmRowView[];
  /** DMs past the first eight. */
  readonly moreDms: number;
}

export type ChannelRole = "manager" | "member";

export interface MemberRowView {
  readonly id: string;
  readonly kind: "person" | "group";
  readonly name: string;
  /** "@maya", or "6 people" for a group. */
  readonly detail: string;
  readonly person: PersonView | null;
  readonly role: ChannelRole;
  /** The reader may take this member off the channel. */
  readonly canRemove: boolean;
}

export interface FileRowView {
  readonly id: string;
  readonly messageId: string;
  readonly attachment: AttachmentView;
  /** A person, or "Tim's agent". */
  readonly sharedBy: string;
  readonly when: string;
  readonly pinned: boolean;
}

export interface PinnedRowView {
  readonly message: MessageView;
  /** "Pinned by Sam · today". */
  readonly pinnedBy: string;
}

export interface TopicSummaryView {
  readonly id: string;
  readonly name: string;
  /** This channel's own topic, or one attached to it. */
  readonly kind: "channel" | "shared";
  /** "Same as #support", "Leadership group and 2 people". */
  readonly access: string;
  readonly factCount: number;
  readonly peopleOnly: boolean;
}

export interface FactView {
  readonly id: string;
  readonly property: string;
  readonly value: string;
  /** A person, or "Tim's agent". */
  readonly writer: string;
  readonly when: string;
  /** The message it came from, when it came from one. */
  readonly sourceMessageId: string | null;
}

export interface ThingView {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly facts: readonly FactView[];
}

export interface SearchMessageResult {
  readonly message: MessageView;
  /** "#support", "#support thread". */
  readonly where: string;
  /** The words matched, as they appear in the message's plain text. */
  readonly match: string;
}

export interface SearchTaskResult {
  readonly id: string;
  readonly title: string;
  readonly mark: TaskMarkView;
}

export type SearchFilter = "channel" | "author" | "thread" | "file";
