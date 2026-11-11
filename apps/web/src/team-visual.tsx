import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";
import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Composer } from "./components/composer.js";
import { Icon } from "./components/icon.js";
import { ProviderLogo } from "./components/provider-brand.js";
import { ToastProvider } from "./components/toast.js";
import { StartFreshScreen } from "./components/start-fresh-screen.js";
import { ChatOrb } from "./components/workspace/task-mark.js";
import { FolderChip, type FolderPickerProps } from "./components/home/folder-picker.js";
import type {
  FolderGroupView,
  FolderView,
  NeedsYouItemView,
  TaskRowView,
} from "./components/home/home-models.js";
import { NeedsYouPage } from "./components/home/needs-you.js";
import {
  DoneRow,
  FolderHeaderRow,
  PersonalTopRows,
  SidebarTaskRow,
} from "./components/home/personal-sidebar.js";
import { TasksHome } from "./components/home/tasks-home.js";
import { AgentCardRow } from "./components/team/agent-status-card.js";
import { ChannelDetails, MembersPane } from "./components/team/channel-details.js";
import { FilesTab, PinnedTab } from "./components/team/channel-tabs.js";
import {
  ChannelIntro,
  ChannelMessages,
  ChannelScreen,
  ThreadPane,
} from "./components/team/channel-view.js";
import {
  ConnectOpensteerCard,
  FirstOwnerSetup,
  InvitePage,
  JoinTeamDialog,
} from "./components/team/join-team.js";
import { KnowledgeTab } from "./components/team/knowledge-tab.js";
import { MessageList } from "./components/team/message-list.js";
import {
  GroupsAdmin,
  InvitesAdmin,
  PeopleAdmin,
  TeamSettings,
} from "./components/team/team-admin.js";
import { AgentUnavailable, AskAgentHint, TeamComposer } from "./components/team/team-composer.js";
import type {
  AgentRequestView,
  ChannelTab,
  ChannelView,
  MessageView,
  MyAgentHere,
  PersonView,
  SearchFilters,
  TeamSidebarView,
  TeamTileView,
  TimelineItem,
} from "./components/team/team-models.js";
import { TeamSearch } from "./components/team/team-search.js";
import { TeamSection } from "./components/team/team-sidebar.js";
import {
  ConnectionBanner,
  TeamBlockedScreen,
  TeamProblemCard,
} from "./components/team/team-status.js";

/* ---- Sample data ---- */

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const noop = () => {};

const person = (
  id: string,
  name: string,
  tint: string,
  extra: Partial<PersonView> = {},
): PersonView => ({
  handle: id,
  id,
  name,
  tint,
  ...extra,
});
const tim = person("tim", "Tim Jang", "#b0684f", { you: true, presence: "active" });
const maya = person("maya", "Maya Chen", "#b4507a", { presence: "active" });
const leo = person("leo", "Leo Park", "#4f86c6", { presence: "active" });
const dana = person("dana", "Dana Ortiz", "#c39a3a");
const priya = person("priya", "Priya Shah", "#3f9b7a");
const sam = person("sam", "Sam Rivera", "#7a62c4", { presence: "active" });
const people = [maya, leo, dana, priya, sam];

const acme: TeamTileView = { color: "#d4704f", name: "Acme" };
const family: TeamTileView = { color: "#5aa06a", name: "Jang family" };

const photo = (a: string, b: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="240" height="150" fill="url(#g)"/><circle cx="170" cy="60" r="34" fill="rgba(255,255,255,0.08)"/></svg>`,
  )}`;

const agentHome: FolderView = {
  agentHome: true,
  computerName: "Tim’s MacBook Pro",
  id: "home",
  label: "Agent home",
  path: "~/Opensteer",
};
const repo: FolderView = {
  agentHome: false,
  computerName: "Tim’s MacBook Pro",
  id: "repo",
  label: "opensteer",
  path: "~/code/opensteer",
};
const taxes: FolderView = {
  agentHome: false,
  computerName: "Tim’s MacBook Pro",
  id: "taxes",
  label: "taxes-2026",
  path: "~/Documents/taxes-2026",
};

const supportSource = {
  available: true,
  channel: { kind: "public" as const, name: "support" },
  team: acme,
  threadAuthor: "Dana Ortiz",
};

const tasks: Record<string, TaskRowView> = {
  refund: {
    ask: null,
    id: "refund",
    mark: { color: "teal", icon: "chat" },
    source: supportSource,
    status: "Working · Using the browser",
    title: "Refund for order 4411",
    tone: "working",
    unread: false,
    updatedAt: ago(2),
  },
  ryokan: {
    ask: "Approve a ¥48,000 deposit?",
    id: "ryokan",
    mark: { color: "purple", icon: "hotel" },
    source: null,
    status: null,
    title: "Book a ryokan in Kyoto",
    tone: "needs-you",
    unread: false,
    updatedAt: ago(4),
  },
  grocery: {
    ask: null,
    id: "grocery",
    mark: { color: "green", icon: "cart" },
    source: null,
    status: "Finished · cart is ready for checkout",
    title: "Weekly grocery order",
    tone: "finished",
    unread: true,
    updatedAt: ago(60),
  },
  flaky: {
    ask: null,
    id: "flaky",
    mark: { color: "blue", icon: "bug" },
    source: null,
    status: "Working · running vitest on packages/client",
    title: "Fix the flaky sync test",
    tone: "working",
    unread: false,
    updatedAt: ago(14),
  },
  notes: {
    ask: null,
    id: "notes",
    mark: { color: "purple", icon: "pen" },
    source: {
      ...supportSource,
      channel: { kind: "public", name: "launch" },
      threadAuthor: "Maya Chen",
    },
    status: "Finished · replied in the thread",
    title: "Draft release notes for 0.9",
    tone: "finished",
    unread: false,
    updatedAt: ago(60 * 30),
  },
};

const folders: readonly FolderGroupView[] = [
  {
    folder: agentHome,
    more: 0,
    needsYou: 1,
    signal: "needs-you",
    tasks: [tasks.refund!, tasks.ryokan!, tasks.grocery!],
  },
  { folder: repo, more: 0, needsYou: 0, signal: "working", tasks: [tasks.flaky!, tasks.notes!] },
  { folder: taxes, more: 0, needsYou: 0, signal: "unread", tasks: [] },
];

const needsYou: readonly NeedsYouItemView[] = [
  {
    answer: { approve: "Approve", deny: "Deny", kind: "approve" },
    askedAt: ago(4),
    channelSees: null,
    detail: "Card ending 4242. Refundable until March 1.",
    id: "n1",
    mark: { color: "purple", icon: "hotel" },
    taskId: "ryokan",
    taskTitle: "Book a ryokan in Kyoto",
    title: "Approve a ¥48,000 deposit to Hoshinoya?",
    where: { kind: "folder", label: "Agent home" },
  },
  {
    answer: { kind: "sign-in", label: "Sign in" },
    askedAt: ago(9),
    channelSees: "#support sees “Waiting for Tim” until you answer.",
    detail: null,
    id: "n2",
    mark: { color: "teal", icon: "chat" },
    taskId: "refund",
    taskTitle: "Refund for order 4411",
    title: "Sign in to Stripe to issue the refund",
    where: { kind: "team", source: supportSource },
  },
  {
    answer: {
      kind: "choices",
      options: [
        { id: "main", label: "main" },
        { id: "release", label: "release-0.9" },
        { id: "else", label: "Something else…" },
      ],
    },
    askedAt: ago(22),
    channelSees: null,
    detail: null,
    id: "n3",
    mark: { color: "blue", icon: "bug" },
    taskId: "flaky",
    taskTitle: "Fix the flaky sync test",
    title: "Which branch should I base the fix on?",
    where: { kind: "folder", label: "opensteer" },
  },
];

const acmeSidebar: TeamSidebarView = {
  channels: [
    {
      id: "announcements",
      kind: "public",
      mentions: 0,
      name: "announcements",
      peopleOnly: false,
      unread: false,
    },
    {
      id: "general",
      kind: "public",
      mentions: 0,
      name: "general",
      peopleOnly: false,
      unread: true,
    },
    {
      id: "support",
      kind: "public",
      mentions: 2,
      name: "support",
      peopleOnly: false,
      unread: true,
    },
    {
      id: "leadership",
      kind: "private",
      mentions: 0,
      name: "leadership",
      peopleOnly: true,
      unread: false,
    },
  ],
  connection: "online",
  dms: [
    {
      id: "dm-maya",
      kind: "dm",
      mentions: 1,
      name: "Maya Chen",
      people: [maya],
      peopleOnly: false,
      unread: true,
    },
    {
      id: "dm-lp",
      kind: "group-dm",
      mentions: 0,
      name: "Leo, Priya",
      people: [leo, priya],
      peopleOnly: false,
      unread: false,
    },
  ],
  id: "acme",
  moreDms: 0,
  tile: acme,
};
const familySidebar: TeamSidebarView = {
  channels: [
    {
      id: "f-general",
      kind: "public",
      mentions: 1,
      name: "general",
      peopleOnly: false,
      unread: true,
    },
  ],
  connection: "online",
  dms: [],
  id: "family",
  moreDms: 0,
  tile: family,
};

const support: ChannelView = {
  canManage: false,
  createdAt: ago(60 * 24 * 40),
  createdBy: "Sam Rivera",
  description: "Customer issues, newest first. Agents: be brief and cite the order.",
  faces: [maya, leo, dana],
  fileCount: 18,
  id: "support",
  instructions: {
    changedAt: ago(60 * 24 * 9),
    changedBy: "Sam Rivera",
    text: "Be brief. Cite the order number. Damaged orders inside 30 days: refund on Standard, store credit on Basic. Never promise delivery dates.",
  },
  kind: "public",
  memberCount: 12,
  name: "support",
  peopleOnly: false,
  pinCount: 3,
};
const leadership: ChannelView = {
  ...support,
  canManage: true,
  description: "Founders and leads.",
  faces: [sam, maya],
  fileCount: 6,
  id: "leadership",
  instructions: null,
  kind: "private",
  memberCount: 5,
  name: "leadership",
  peopleOnly: true,
  pinCount: 1,
};
const dmMaya: ChannelView = {
  ...support,
  description: "",
  faces: [maya],
  fileCount: 4,
  id: "dm-maya",
  instructions: null,
  kind: "dm",
  memberCount: 2,
  name: "Maya Chen",
  people: [maya],
  pinCount: 0,
};

const mention = {
  maya: { handle: "maya", label: "Maya Chen", tone: "person" as const },
  me: { handle: "tim", label: "Tim", tone: "you" as const },
  myAgent: { handle: "tim-agent", label: "My agent", tone: "agent" as const },
  priyaAgent: { handle: "priya-agent", label: "Priya’s agent", tone: "agent" as const },
  mayaAgent: { handle: "maya-agent", label: "Maya’s agent", tone: "agent" as const },
  mayaRef: { handle: "maya-agent", label: "Maya’s agent", tone: "agent-reference" as const },
};

const message = (
  id: string,
  author: PersonView,
  minutes: number,
  body: string,
  extra: Partial<MessageView> = {},
): MessageView => ({
  at: ago(minutes),
  author: { kind: "person", person: author },
  body,
  files: [],
  id,
  mentions: [],
  ...extra,
});

const rootDana = message(
  "m1",
  dana,
  95,
  "Customer on **4411** says the lid arrived cracked. Photos below. They want a refund, not a replacement.",
  {
    files: [
      {
        id: "f1",
        mediaType: "image/jpeg",
        name: "IMG_4411_lid.jpg",
        previewUrl: photo("#3c4a63", "#7d5a4c"),
        sizeBytes: 2_100_000,
      },
      {
        id: "f2",
        mediaType: "image/jpeg",
        name: "IMG_4411_box.jpg",
        previewUrl: photo("#5b4a3d", "#2c2a2f"),
        sizeBytes: 1_800_000,
      },
    ],
    thread: {
      agent: { kind: "working", owner: tim },
      lastReplyAt: ago(3),
      replyCount: 6,
      repliers: [
        { kind: "person", person: tim },
        { kind: "person", person: leo },
        { kind: "agent", owner: maya },
      ],
    },
  },
);

const channelItems: readonly TimelineItem[] = [
  {
    kind: "message",
    message: message(
      "m0",
      sam,
      60 * 26,
      "Pinned the new returns checklist. Please use it for anything over $200.",
      { pinnedBy: "Sam Rivera" },
    ),
  },
  { kind: "message", message: rootDana },
  {
    kind: "message",
    message: message(
      "m2",
      leo,
      83,
      "Heads up: Shopify’s refund API is flaky this morning. If a refund fails, use store credit and note it on the order.",
    ),
  },
  {
    kind: "message",
    message: message(
      "m3",
      maya,
      75,
      "@tim can you look at the Stripe payout that bounced? Details in the sheet.",
      {
        files: [
          {
            id: "f3",
            mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            name: "payouts-nov.xlsx",
            sizeBytes: 48_000,
          },
        ],
        mentions: [mention.me],
      },
    ),
  },
  { kind: "message", message: message("m3b", maya, 74, "No rush, end of day is fine.") },
  {
    kind: "message",
    message: message(
      "m4",
      priya,
      64,
      "@priya-agent summarise this week’s refund requests by reason, with order numbers.",
      {
        mentions: [mention.priyaAgent],
        thread: {
          agent: { at: ago(62), kind: "replied", owner: priya },
          lastReplyAt: ago(62),
          replyCount: 1,
          repliers: [{ kind: "agent", owner: priya }],
        },
      },
    ),
  },
  {
    kind: "message",
    message: message(
      "m5",
      sam,
      40,
      "Can someone check whether the carrier claim for 4398 went through? @maya-agent might know, it filed the last one.",
      { mentions: [mention.mayaRef] },
    ),
  },
  {
    kind: "message",
    message: message("m6", tim, 2, "Ok, store credit it is. Closing this one out.", {
      send: { kind: "sending" },
    }),
  },
  {
    kind: "message",
    message: message("m7", tim, 1, "Also: the checklist link 404s for me", {
      send: { kind: "queued" },
    }),
  },
];

const working = (owner: PersonView, steps = 3): AgentRequestView => ({
  askedAt: ago(1),
  id: `r-${owner.id}`,
  owner,
  state: {
    current: "browsed",
    startedAt: new Date(now - 40_000).toISOString(),
    kind: "working",
    steps: [
      { count: 1, kind: "read-thread" },
      { count: 1, kind: "checked-knowledge" },
      { count: steps - 2, kind: "browsed" },
    ],
  },
});

const threadReplies: readonly TimelineItem[] = [
  {
    kind: "message",
    message: message(
      "t1",
      tim,
      52,
      "@tim-agent can you check 4411 and refund it if it’s inside our policy?",
      { mentions: [mention.myAgent] },
    ),
  },
  {
    kind: "message",
    message: {
      ...message(
        "t2",
        tim,
        51,
        "Inside policy: 12 days old, damage in transit, and our 30-day damage rule covers it. The refund is waiting on Tim’s Stripe sign-in.",
      ),
      author: { kind: "agent", owner: tim },
      work: { durationMs: 72_000, openable: true, steps: 4 },
    },
  },
  {
    kind: "message",
    message: message("t3", leo, 44, "This tier gets store credit, not a refund."),
  },
  {
    kind: "message",
    message: message("t4", tim, 41, "@tim-agent do store credit instead", {
      mentions: [mention.myAgent],
    }),
  },
  { kind: "card", request: working(tim) },
  {
    kind: "message",
    message: message("t5", maya, 35, "@maya-agent draft the apology email to the customer", {
      mentions: [mention.mayaAgent],
    }),
  },
  {
    kind: "card",
    request: {
      askedAt: ago(35),
      id: "r-maya",
      owner: maya,
      state: { computerName: "Studio Mac", kind: "waiting-computer", lastSeenAt: ago(190) },
    },
  },
];

/* ---- Frame ---- */

function Sidebar({ open }: { readonly open?: string }) {
  const [folded, setFolded] = useState<Record<string, boolean>>({ family: true });
  return (
    <aside className="sidebar visual-sidebar">
      <div className="sidebar__header">
        <button aria-label="Search" className="icon-btn" title="Search · ⌘K" type="button">
          <Icon name="search" />
        </button>
        <button aria-label="Collapse sidebar" className="icon-btn" type="button">
          <Icon name="panel" />
        </button>
      </div>
      <div className="visual-sidebar__scroll">
        <PersonalTopRows
          needsYou={2}
          onOpenNeedsYou={noop}
          onOpenNewTask={noop}
          onOpenVoice={noop}
          open={open === "home" ? "new-task" : open === "needs-you" ? "needs-you" : null}
        />
        <section className="side-section">
          <div className="side-head">
            <h2 className="side-head__title">Tasks</h2>
          </div>
          <ul className="side-list visual-side-list">
            {folders.map((group) => [
              <FolderHeaderRow
                actions={{ onCopyPath: noop, onHide: noop, onNewTask: noop, onReveal: noop }}
                group={group}
                key={group.folder.id}
                onToggle={noop}
                open={group.tasks.length > 0}
              />,
              ...group.tasks.map((task) => (
                <SidebarTaskRow key={task.id} onOpen={noop} open={open === task.id} task={task} />
              )),
            ])}
            <DoneRow count={24} onOpen={noop} />
          </ul>
          {[acmeSidebar, familySidebar].map((team) => (
            <TeamSection
              actions={{
                onOpenChannel: noop,
                onNewChannel: noop,
                onInvite: noop,
                onSettings: noop,
                onLeave: noop,
              }}
              folded={folded[team.id] === true}
              key={team.id}
              onToggleFold={() => setFolded((value) => ({ ...value, [team.id]: !value[team.id] }))}
              openChannelId={open ?? null}
              team={team}
            />
          ))}
        </section>
      </div>
      <div className="visual-tabs">
        <div className="side-head">
          <h2 className="side-head__title">Tabs</h2>
        </div>
        <ul className="side-list">
          {[
            ["globe", "Google Flights — Kyoto, Mar 14"],
            ["terminal", "opensteer — zsh"],
          ].map(([icon, title]) => (
            <li className="side-tab" key={title}>
              <span className="side-tab__main">
                <Icon className="visual-tab-icon" name={icon === "globe" ? "globe" : "terminal"} />
                <span className="side-tab__title">{title}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="sidebar__footer">
        <div className="visual-place">
          <span className="visual-place__mark">
            <Icon name="laptop" />
          </span>
          <span>
            <span className="visual-place__name">Tim’s MacBook Pro</span>
            <span className="visual-place__status">
              <span className="status-dot status-dot--running" /> Connected
            </span>
          </span>
        </div>
      </div>
    </aside>
  );
}

function Frame({ children, open }: { readonly children: ReactNode; readonly open?: string }) {
  return (
    <div className="app-shell">
      <Sidebar {...(open ? { open } : {})} />
      <div className="app-shell__main">
        <div className="workspace workspace--talk">
          <div className="workspace__conversation">{children}</div>
        </div>
      </div>
    </div>
  );
}

function AreaHeader({ mark, title }: { readonly mark: ReactNode; readonly title: string }) {
  return (
    <header className="conv-header conv-header--area">
      <div className="conv-header__bar">
        <span className="conv-header__mark">{mark}</span>
        <div className="conv-header__text">
          <h1 className="conv-header__title">
            <span className="conv-header__name conv-header__name--static">{title}</span>
          </h1>
        </div>
      </div>
    </header>
  );
}

const folderPicker: FolderPickerProps = {
  browsing: {
    computer: { hosting: true, id: "mbp", kind: "laptop", name: "Tim’s MacBook Pro", online: true },
    crumbs: [{ label: "code", path: "~/code" }],
    entries: [
      { name: "buzz-app", path: "~/code/buzz-app" },
      { name: "opensteer", path: "~/code/opensteer" },
      { name: "opensteer-site", path: "~/code/opensteer-site" },
      { name: "qm", path: "~/code/qm" },
    ],
    path: "~/code",
  },
  computers: [
    { hosting: true, id: "mbp", kind: "laptop", name: "Tim’s MacBook Pro", online: true },
  ],
  current: agentHome,
  onBrowse: noop,
  onChoose: noop,
  onCreateFolder: noop,
  onUse: noop,
  recent: [agentHome, repo, taxes],
};

function HomeComposer({ needsAccount = false }: { readonly needsAccount?: boolean }) {
  return (
    <Composer
      footerExtras={
        <span className="exec-controls">
          <button className="exec-pill" type="button">
            {needsAccount ? (
              <>
                <Icon name="plus" />
                Choose an AI
              </>
            ) : (
              <>
                <ProviderLogo providerId="anthropic" />
                Claude Code · Opus 5.5
              </>
            )}
          </button>
        </span>
      }
      leadingFooter={<FolderChip {...folderPicker} />}
      onSend={async () => {}}
      placeholder="Ask your agent to…"
      sendLabel="Start task"
      variant="work"
    />
  );
}

const homeActions = {
  onAnswer: noop,
  onConnectAccount: noop,
  onNewTaskIn: noop,
  onOpenDone: noop,
  onOpenNeedsYou: noop,
  onOpenTask: noop,
  onSuggestion: noop,
};

function composerFor(
  agent: MyAgentHere,
  placeholder: string,
  extra: Partial<Parameters<typeof TeamComposer>[0]> = {},
) {
  return (
    <TeamComposer
      agent={agent}
      me={tim}
      onAddFiles={noop}
      onSend={noop}
      people={people}
      placeholder={placeholder}
      {...extra}
    />
  );
}

/* ---- Screens ---- */

const screens: Record<string, () => ReactNode> = {
  home: () => (
    <Frame open="home">
      <TasksHome
        actions={homeActions}
        composer={<HomeComposer />}
        doneCount={24}
        folders={folders}
        header={<AreaHeader mark={<ChatOrb size={22} />} title="New task" />}
        needsYou={needsYou.slice(0, 2)}
      />
    </Frame>
  ),
  "home-first-run": () => (
    <div className="app-shell">
      <aside className="sidebar visual-sidebar">
        <div className="sidebar__header">
          <button aria-label="Search" className="icon-btn" type="button">
            <Icon name="search" />
          </button>
          <button aria-label="Collapse sidebar" className="icon-btn" type="button">
            <Icon name="panel" />
          </button>
        </div>
        <div className="visual-sidebar__scroll">
          <PersonalTopRows
            needsYou={0}
            onOpenNeedsYou={noop}
            onOpenNewTask={noop}
            onOpenVoice={noop}
            open="new-task"
          />
        </div>
      </aside>
      <div className="app-shell__main">
        <div className="workspace workspace--talk">
          <div className="workspace__conversation">
            <TasksHome
              actions={homeActions}
              composer={<HomeComposer needsAccount />}
              doneCount={0}
              folders={[]}
              header={<AreaHeader mark={<ChatOrb size={22} />} title="New task" />}
              needsAccount
              needsYou={[]}
            />
          </div>
        </div>
      </div>
    </div>
  ),
  "needs-you": () => (
    <Frame open="needs-you">
      <NeedsYouPage
        actions={homeActions}
        header={<AreaHeader mark={<Icon name="alert-circle" />} title="Needs you" />}
        items={needsYou}
      />
    </Frame>
  ),
  "needs-you-empty": () => (
    <Frame open="needs-you">
      <NeedsYouPage
        actions={homeActions}
        header={<AreaHeader mark={<Icon name="alert-circle" />} title="Needs you" />}
        items={[]}
      />
    </Frame>
  ),
  channel: () => <ChannelScreenSample />,
  thread: () => <ChannelScreenSample pane="thread" />,
  details: () => <ChannelScreenSample manager pane="details" />,
  files: () => <ChannelScreenSample tab="files" />,
  pinned: () => <ChannelScreenSample tab="pinned" />,
  knowledge: () => <ChannelScreenSample tab="knowledge" />,
  members: () => (
    <Frame open="leadership">
      <ChannelScreen
        channel={leadership}
        menu={{ onOpenDetails: noop, onOpenMembers: noop, onSearch: noop }}
        onTab={noop}
        pane={
          <MembersPane
            actions={{ onAdd: noop, onClose: noop, onRemove: noop, onSetManager: noop }}
            canManage
            channel={leadership}
            members={[
              { kind: "person", manager: true, person: sam },
              { kind: "person", manager: false, person: maya },
              { kind: "person", manager: false, person: tim },
              { id: "founders", kind: "group", manager: false, name: "Founders", peopleCount: 2 },
            ]}
          />
        }
        tab="messages"
      >
        <ChannelMessages
          composer={composerFor({ kind: "people-only" }, "Message #leadership")}
          list={
            <MessageList
              firstUnreadId={null}
              hasOlder={false}
              intro={<ChannelIntro channel={leadership} />}
              items={[
                {
                  kind: "message",
                  message: message(
                    "l1",
                    sam,
                    140,
                    "Draft comp bands for Q1 attached. Please don’t forward.",
                    {
                      files: [
                        {
                          id: "lf",
                          mediaType: "application/pdf",
                          name: "comp-bands-q1.pdf",
                          sizeBytes: 220_000,
                        },
                      ],
                    },
                  ),
                },
                {
                  kind: "system",
                  at: ago(120),
                  icon: "lock",
                  id: "s1",
                  text: "Sam Rivera made #leadership people only",
                },
                {
                  kind: "message",
                  message: message(
                    "l2",
                    maya,
                    110,
                    "Looks right to me. One question on the support lead band, will DM.",
                  ),
                },
              ]}
              label="Messages in #leadership"
            />
          }
        />
      </ChannelScreen>
    </Frame>
  ),
  dm: () => (
    <Frame open="dm-maya">
      <ChannelScreen
        channel={dmMaya}
        menu={{ onOpenDetails: noop, onSearch: noop }}
        onTab={noop}
        tab="messages"
      >
        <ChannelMessages
          composer={composerFor({ kind: "ready" }, "Message Maya")}
          list={
            <MessageList
              firstUnreadId={null}
              hasOlder={false}
              intro={<ChannelIntro channel={dmMaya} />}
              items={[
                {
                  kind: "message",
                  message: message(
                    "d1",
                    maya,
                    30,
                    "Are we still on for the offsite on the 21st? I need a headcount by Friday.",
                  ),
                },
                {
                  kind: "message",
                  message: message(
                    "d2",
                    tim,
                    26,
                    "@tim-agent check my calendar for the 21st and tell Maya whether I can make the offsite",
                    {
                      mentions: [mention.myAgent],
                      thread: {
                        agent: { at: ago(25), kind: "replied", owner: tim },
                        lastReplyAt: ago(25),
                        replyCount: 1,
                        repliers: [{ kind: "agent", owner: tim }],
                      },
                    },
                  ),
                },
                {
                  kind: "message",
                  message: message("d3", maya, 24, "Perfect, counting you in 🙌"),
                },
              ]}
              label="Messages with Maya Chen"
            />
          }
        />
      </ChannelScreen>
    </Frame>
  ),
  cards: () => <CardsGallery />,
  composer: () => <ComposerGallery />,
  search: () => <SearchSample />,
  join: () => (
    <div className="visual-gallery visual-gallery--join">
      <div className="visual-cell">
        <p className="visual-label">Invite link, any browser</p>
        <div className="visual-sheet">
          <InvitePage
            invite={{ inviter: maya, memberCount: 23, team: acme }}
            onContinueInBrowser={noop}
            onDownload={noop}
            onOpenInApp={noop}
          />
        </div>
      </div>
      <div className="visual-cell">
        <p className="visual-label">Setup link, before sign-in</p>
        <div className="visual-sheet">
          <FirstOwnerSetup
            inviteUrl={null}
            onCopy={noop}
            onOpenTeam={noop}
            onSignIn={noop}
            step="sign-in"
            team={acme}
          />
        </div>
      </div>
      <div className="visual-cell">
        <p className="visual-label">The first owner, after sign-in</p>
        <div className="visual-sheet">
          <FirstOwnerSetup
            inviteUrl="https://chat.acme.example/invite/k4Pz#Rw8m2x"
            onCopy={noop}
            onOpenTeam={noop}
            onSignIn={noop}
            step="invite"
            team={acme}
          />
        </div>
      </div>
    </div>
  ),
  "join-dialog": () => (
    <Frame open="home">
      <TasksHome
        actions={homeActions}
        composer={<HomeComposer />}
        doneCount={24}
        folders={folders}
        header={<AreaHeader mark={<ChatOrb size={22} />} title="New task" />}
        needsYou={[]}
      />
      <JoinTeamDialog
        account="tim@…"
        invite={{ inviter: maya, memberCount: 23, team: acme }}
        me={tim}
        onCancel={noop}
        onJoin={noop}
      />
    </Frame>
  ),
  states: () => (
    <div className="visual-gallery visual-gallery--grid">
      <TeamProblemCard
        actions={{ onClose: noop }}
        problem={{ inviter: "Maya Chen", kind: "expired" }}
        team={acme}
      />
      <TeamProblemCard
        actions={{ onOpen: noop }}
        problem={{ kind: "already-member", you: "Tim Jang" }}
        team={acme}
      />
      <TeamProblemCard actions={{ onRetry: noop }} problem={{ kind: "unreachable" }} team={acme} />
      <TeamProblemCard actions={{ onUpdate: noop }} problem={{ kind: "update-app" }} team={acme} />
      <TeamProblemCard
        actions={{ onRetry: noop }}
        problem={{ kind: "update-server" }}
        team={acme}
      />
      <div className="visual-stack">
        <ConnectOpensteerCard onConnect={noop} team={acme} />
        <ConnectOpensteerCard code="ost-join:chat.acme.example:3F7Q-K29D" team={acme} />
      </div>
      <div className="visual-stack visual-wide">
        <ConnectionBanner immediate notice={{ kind: "reconnecting" }} team="Acme" />
        <ConnectionBanner immediate notice={{ kind: "unreachable" }} onRetry={noop} team="Acme" />
        <ConnectionBanner
          immediate
          notice={{ computerName: "MacBook Pro", kind: "computer-offline" }}
          team="Acme"
        />
        <ConnectionBanner immediate notice={{ kind: "update-app" }} onUpdate={noop} team="Acme" />
        <ConnectionBanner immediate notice={{ kind: "update-server" }} team="Acme" />
      </div>
      <div className="visual-stack">
        <TeamSection
          actions={{ onOpenChannel: noop, onRemoveFromSidebar: noop }}
          folded={false}
          onToggleFold={noop}
          team={{ ...acmeSidebar, connection: "removed" }}
        />
        <TeamSection
          actions={{ onOpenChannel: noop }}
          folded={false}
          onToggleFold={noop}
          team={{ ...acmeSidebar, connection: "offline" }}
        />
        <TeamSection
          actions={{ onOpenChannel: noop }}
          folded
          onToggleFold={noop}
          team={{ ...acmeSidebar, connection: "update-server" }}
        />
      </div>
    </div>
  ),
  "version-app": () => (
    <Frame open="support">
      <TeamBlockedScreen
        actions={{ onUpdate: noop }}
        problem={{ kind: "update-app" }}
        team={acme}
      />
    </Frame>
  ),
  "version-server": () => (
    <Frame open="support">
      <TeamBlockedScreen
        actions={{ onRetry: noop }}
        problem={{ kind: "update-server" }}
        team={acme}
      />
    </Frame>
  ),
  "admin-people": () => (
    <SettingsFrame>
      <PeopleAdmin
        actions={{
          onAddToGroup: noop,
          onDeactivate: noop,
          onInvite: noop,
          onReactivate: noop,
          onSetRole: noop,
        }}
        people={[
          {
            deactivated: false,
            email: "sam@acme.example",
            groups: ["Founders", "Support"],
            lastActiveAt: ago(0),
            person: sam,
            role: "owner",
          },
          {
            deactivated: false,
            email: "maya@acme.example",
            groups: ["Founders", "Sales"],
            lastActiveAt: ago(2),
            person: maya,
            role: "admin",
          },
          {
            deactivated: false,
            email: "tim@acme.example",
            groups: ["Support"],
            lastActiveAt: ago(0),
            person: tim,
            role: "admin",
          },
          {
            deactivated: false,
            email: "leo@acme.example",
            groups: ["Support", "Support EU"],
            lastActiveAt: ago(60),
            person: leo,
            role: "member",
          },
          {
            deactivated: false,
            email: "dana@acme.example",
            groups: ["Support EU"],
            lastActiveAt: ago(60 * 26),
            person: dana,
            role: "member",
          },
          {
            deactivated: true,
            email: "jordan@acme.example",
            groups: [],
            lastActiveAt: ago(60 * 24 * 12),
            person: person("jordan", "Jordan Lee", "#777"),
            role: "member",
          },
        ]}
        team={acme}
      />
    </SettingsFrame>
  ),
  "admin-groups": () => (
    <SettingsFrame>
      <GroupsAdmin
        actions={{
          onAddMembers: noop,
          onCreate: noop,
          onDelete: noop,
          onRemoveMember: noop,
          onRename: noop,
          onSelect: noop,
        }}
        groups={[
          { id: "everyone", name: "Everyone", peopleCount: 23 },
          { id: "founders", name: "Founders", peopleCount: 2 },
          { id: "sales", name: "Sales", peopleCount: 4 },
          { id: "support", name: "Support", peopleCount: 7 },
          { id: "support-eu", name: "Support EU", peopleCount: 3 },
        ]}
        selected={{
          id: "support",
          members: [
            { group: { id: "support-eu", name: "Support EU", peopleCount: 3 }, kind: "group" },
            { kind: "person", person: tim },
            { kind: "person", person: leo },
          ],
          name: "Support",
          parents: ["Everyone"],
          peopleCount: 7,
          usedBy: [
            { kind: "channel", level: "member", name: "support" },
            { kind: "topic", level: "write", name: "Refund policy" },
            { kind: "topic", level: "read", name: "Carriers" },
          ],
        }}
      />
    </SettingsFrame>
  ),
  "admin-invites": () => (
    <SettingsFrame>
      <InvitesAdmin
        channels={[
          { id: "general", name: "general" },
          { id: "support", name: "support" },
        ]}
        invite={{
          enabled: true,
          expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
          landingChannel: "general",
          url: "https://chat.acme.example/invite/k4Pz#Rw8m2x",
          uses: 4,
        }}
        onCopy={noop}
        onLanding={noop}
        onNewLink={noop}
        onToggle={noop}
      />
    </SettingsFrame>
  ),
  "team-settings": () => (
    <SettingsFrame>
      <TeamSettings
        actions={{
          onChangePhoto: noop,
          onLeave: noop,
          onNotify: noop,
          onRename: noop,
          onTeamColor: noop,
          onTeamName: noop,
        }}
        admin
        me={tim}
        notify={{ channels: "mentions", dms: "everything" }}
        team={acme}
        tileColors={["#d4704f", "#c39a3a", "#5aa06a", "#3f8fa0", "#4f86c6", "#7a62c4", "#b4507a"]}
        webAddress="chat.acme.example"
      />
    </SettingsFrame>
  ),
  "start-fresh": () => (
    <StartFreshScreen
      onQuit={noop}
      onReveal={noop}
      onStartFresh={noop}
      setAsidePath="~/Library/Application Support/Opensteer/Earlier Opensteer 2026-11-11"
    />
  ),
};

function SettingsFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar visual-sidebar visual-settings-nav">
        <div className="sidebar__header" />
        <p className="visual-settings-nav__title">Settings</p>
        {["General", "Account", "Computers & devices", "Messaging"].map((label) => (
          <p className="visual-settings-nav__link" key={label}>
            {label}
          </p>
        ))}
        <p className="visual-settings-nav__caption">
          <span
            className="team-tile team-tile--14"
            style={{ "--team-tile-tint": acme.color } as React.CSSProperties}
          >
            A
          </span>
          Acme
        </p>
        {["Your profile", "People", "Groups", "Invites"].map((label) => (
          <p className="visual-settings-nav__link" key={label}>
            {label}
          </p>
        ))}
      </aside>
      <div className="app-shell__main">
        <div className="workspace workspace--talk">
          <div className="workspace__conversation">
            <div className="page settings settings-layout">
              <div className="settings-content">
                <div className="settings-content__inner">{children}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChannelScreenSample({
  manager = false,
  pane,
  tab: initialTab = "messages",
}: {
  readonly manager?: boolean;
  readonly pane?: "thread" | "details";
  readonly tab?: ChannelTab;
}) {
  const [tab, setTab] = useState<ChannelTab>(initialTab);
  const channel = manager ? { ...support, canManage: true } : support;
  const cardActions = {
    onAnswer: noop,
    onCancel: noop,
    onOpenTask: noop,
    onRetry: noop,
    onStop: noop,
  };
  const actions = {
    onAskAgent: noop,
    onCopyLink: noop,
    onOpenThread: noop,
    onPin: noop,
    onOpenTask: noop,
  };
  return (
    <Frame open="support">
      <ChannelScreen
        channel={channel}
        menu={{
          onCopyLink: noop,
          onLeave: noop,
          onMarkRead: noop,
          onOpenDetails: noop,
          onOpenMembers: noop,
          onSearch: noop,
        }}
        onTab={setTab}
        pane={
          pane === "thread" ? (
            <ThreadPane
              actions={actions}
              cardActions={cardActions}
              channel={channel}
              composer={composerFor({ kind: "ready" }, "Reply…", {
                agentStartsOn: true,
                typing: [],
              })}
              onClose={noop}
              replies={threadReplies}
              root={rootDana}
            />
          ) : pane === "details" ? (
            <ChannelDetails
              actions={{
                onArchive: noop,
                onAttachTopic: noop,
                onClose: noop,
                onDetachTopic: noop,
                onLeave: noop,
                onNotify: noop,
                onOpenMembers: noop,
                onSaveAbout: noop,
                onSaveInstructions: noop,
                onSetPeopleOnly: noop,
                onSetPrivate: noop,
              }}
              channel={channel}
              folder={folderPicker}
              notify="mentions"
              topics={[
                {
                  detail: "Same access as the channel · 41 facts",
                  id: "t-support",
                  kind: "channel",
                  name: "#support’s topic",
                },
                {
                  detail: "Shared topic · Acme-wide",
                  id: "t-refund",
                  kind: "shared",
                  name: "Refund policy",
                },
                {
                  detail: "Shared topic · Ops group",
                  id: "t-carriers",
                  kind: "shared",
                  name: "Carriers",
                },
              ]}
              workingAgents={2}
            />
          ) : null
        }
        tab={tab}
      >
        {tab === "messages" ? (
          <ChannelMessages
            composer={composerFor({ kind: "ready" }, "Message #support", { typing: [leo] })}
            list={
              <MessageList
                actions={actions}
                cardActions={cardActions}
                firstUnreadId={pane ? null : "m2"}
                hasOlder={false}
                intro={<ChannelIntro channel={channel} />}
                items={channelItems}
                label="Messages in #support"
                onMarkRead={noop}
                openThreadId={pane === "thread" ? "m1" : null}
              />
            }
          />
        ) : tab === "files" ? (
          <FilesTab
            channel={channel}
            files={[
              {
                at: ago(26 * 60),
                excerpt: "Pinned the new returns checklist…",
                file: {
                  id: "a",
                  mediaType: "application/pdf",
                  name: "returns-checklist-v3.pdf",
                  sizeBytes: 310_000,
                },
                inThread: false,
                pinned: true,
                sharedBy: { kind: "person", person: sam },
              },
              {
                at: ago(75),
                excerpt: "@Tim can you look at the Stripe…",
                file: {
                  id: "b",
                  mediaType: "application/vnd.ms-excel",
                  name: "payouts-nov.xlsx",
                  sizeBytes: 48_000,
                },
                inThread: false,
                pinned: false,
                sharedBy: { kind: "person", person: maya },
              },
              {
                at: ago(95),
                excerpt: "Customer on 4411 says the lid…",
                file: {
                  id: "c",
                  mediaType: "image/jpeg",
                  name: "IMG_4411_lid.jpg",
                  sizeBytes: 2_100_000,
                },
                inThread: false,
                pinned: false,
                sharedBy: { kind: "person", person: dana },
              },
              {
                at: ago(95),
                excerpt: "Customer on 4411 says the lid…",
                file: {
                  id: "d",
                  mediaType: "image/jpeg",
                  name: "IMG_4411_box.jpg",
                  sizeBytes: 1_800_000,
                },
                inThread: false,
                pinned: false,
                sharedBy: { kind: "person", person: dana },
              },
              {
                at: ago(60 * 24 * 2),
                excerpt: "summarise this week’s…",
                file: {
                  id: "e",
                  mediaType: "text/csv",
                  name: "refunds-week-45.csv",
                  sizeBytes: 6_000,
                },
                inThread: true,
                pinned: false,
                sharedBy: { kind: "agent", owner: priya },
              },
              {
                at: ago(60 * 24 * 9),
                excerpt: "For anything UPS, file within 9…",
                file: {
                  id: "f",
                  mediaType: "application/pdf",
                  name: "carrier-claims-howto.pdf",
                  sizeBytes: 540_000,
                },
                inThread: false,
                pinned: true,
                sharedBy: { kind: "person", person: leo },
              },
            ]}
            onOpenFile={noop}
            onShowMessage={noop}
          />
        ) : tab === "pinned" ? (
          <PinnedTab
            onShowMessage={noop}
            onUnpin={noop}
            pins={[
              {
                inThread: false,
                message: message(
                  "p1",
                  sam,
                  26 * 60,
                  "Pinned the new returns checklist. Please use it for anything over $200.",
                  {
                    files: [
                      {
                        id: "pf",
                        mediaType: "application/pdf",
                        name: "returns-checklist-v3.pdf",
                        sizeBytes: 310_000,
                      },
                    ],
                  },
                ),
                pinnedAt: ago(30),
                pinnedBy: "Sam Rivera",
              },
              {
                inThread: true,
                message: {
                  ...message(
                    "p2",
                    priya,
                    60 * 24 * 2,
                    "This week: 14 refund requests. Damaged in transit (8), wrong size (4), changed mind (2).",
                  ),
                  author: { kind: "agent", owner: priya },
                },
                pinnedAt: ago(60 * 24),
                pinnedBy: "Priya Shah",
              },
            ]}
          />
        ) : (
          <KnowledgeTab
            actions={{ onAddFact: noop, onHistory: noop, onSelectTopic: noop, onShowSource: noop }}
            selectedTopicId="t-support"
            things={[
              {
                facts: [
                  {
                    at: ago(52),
                    id: "k1",
                    property: "resolution",
                    sourceLabel: "thread",
                    value: "Store credit, $64",
                    writer: { kind: "agent", owner: tim },
                  },
                  {
                    at: ago(95),
                    id: "k2",
                    property: "damage",
                    value: "Lid cracked in transit (photos in thread)",
                    writer: { kind: "person", person: dana },
                  },
                  {
                    at: ago(44),
                    id: "k3",
                    property: "tier",
                    value: "Basic",
                    writer: { kind: "person", person: leo },
                  },
                ],
                id: "order-4411",
                key: "order/4411",
                name: "Order 4411",
              },
              {
                facts: [
                  {
                    at: ago(60 * 24 * 7),
                    id: "k4",
                    property: "contact",
                    value: "dana@hoshino.example",
                    writer: { kind: "person", person: maya },
                  },
                  {
                    at: ago(60 * 24 * 5),
                    id: "k5",
                    property: "open_orders",
                    value: "2",
                    writer: { kind: "agent", owner: maya },
                  },
                ],
                id: "hoshino",
                key: "customer/hoshino-co",
                name: "Hoshino & Co.",
              },
            ]}
            topics={[
              {
                access: "Same access as #support · 12 people and their agents",
                factCount: 41,
                id: "t-support",
                kind: "channel",
                name: "support",
                peopleOnly: false,
                thingCount: 17,
              },
              {
                access: "Acme-wide",
                factCount: 12,
                id: "t-refund",
                kind: "shared",
                name: "Refund policy",
                peopleOnly: false,
                thingCount: 4,
              },
              {
                access: "Ops group",
                factCount: 9,
                id: "t-carriers",
                kind: "shared",
                name: "Carriers",
                peopleOnly: false,
                thingCount: 3,
              },
              {
                access: "Founders",
                factCount: 6,
                id: "t-pricing",
                kind: "shared",
                name: "Pricing",
                peopleOnly: true,
                thingCount: 3,
              },
            ]}
          />
        )}
      </ChannelScreen>
    </Frame>
  );
}

function CardsGallery() {
  const actions = { onAnswer: noop, onCancel: noop, onOpenTask: noop, onRetry: noop, onStop: noop };
  const card = (label: string, request: AgentRequestView) => (
    <div className="visual-card-cell" key={label}>
      <p className="visual-label">{label}</p>
      <AgentCardRow actions={actions} request={request} />
    </div>
  );
  const base = (owner: PersonView, state: AgentRequestView["state"]): AgentRequestView => ({
    askedAt: ago(35),
    id: `r-${owner.id}-${state.kind}`,
    owner,
    state,
  });
  return (
    <div className="visual-gallery visual-gallery--cards">
      {card(
        "Queued · owner’s computer offline — others",
        base(maya, { computerName: "Studio Mac", kind: "waiting-computer", lastSeenAt: ago(190) }),
      )}
      {card(
        "Queued · owner’s computer offline — owner",
        base(tim, { computerName: "MacBook Pro", kind: "waiting-computer", lastSeenAt: ago(190) }),
      )}
      {card("Queued · agent busy — others", base(leo, { ahead: 2, kind: "queued" }))}
      {card("Queued · agent busy — owner", base(tim, { ahead: 2, kind: "queued" }))}
      {card("Working — others", working(priya, 4))}
      {card("Working — owner (click to see step kinds)", working(tim, 5))}
      {card(
        "Needs its owner — others",
        base({ ...tim, you: false }, { ask: null, kind: "needs-owner", steps: 3 }),
      )}
      {card(
        "Needs you — owner",
        base(tim, { ask: "Sign in to Stripe to issue the refund", kind: "needs-owner", steps: 3 }),
      )}
      {card("Failed — others", base({ ...tim, you: false }, { cause: null, kind: "failed" }))}
      {card(
        "Failed — owner",
        base(tim, {
          cause: "Claude Code hit its usage limit. Others see “Tim’s agent couldn’t finish”.",
          kind: "failed",
        }),
      )}
      {card("Stopped", base(maya, { at: ago(20), by: "Maya", kind: "stopped", steps: 2 }))}
      {card("Can’t post here any more", base(leo, { kind: "cannot-post" }))}
      <div className="visual-card-cell visual-wide">
        <p className="visual-label">Done — the reply replaces the card</p>
        <div className="tlist__row">
          {/* The reply row: the same component every message uses. */}
          <ReplySample />
        </div>
      </div>
    </div>
  );
}

function ReplySample() {
  return (
    <MessageList
      firstUnreadId={null}
      hasOlder
      items={[
        {
          kind: "message",
          message: {
            ...message(
              "done",
              priya,
              3,
              "This week: 14 refund requests.\n\n- **Damaged in transit** (8): 4402, 4411, 4415…\n- **Wrong size** (4): 4398, 4409…\n- **Changed mind** (2): 4417, 4420",
            ),
            author: { kind: "agent", owner: priya },
            work: { durationMs: 180_000, openable: false, steps: 7 },
          },
        },
      ]}
      label="Reply"
    />
  );
}

function ComposerGallery() {
  return (
    <div className="visual-gallery visual-gallery--composers">
      <div className="visual-composer-cell" data-cell="at">
        <p className="visual-label">Typing @ — My agent first</p>
        {composerFor({ kind: "ready" }, "Message #support")}
      </div>
      <div className="visual-composer-cell" data-cell="maya">
        <p className="visual-label">Typing @maya — someone else’s agent is a reference</p>
        {composerFor({ kind: "ready" }, "Message #support")}
      </div>
      <div className="visual-composer-cell">
        <p className="visual-label">To my agent on, with files (⌘⇧↵ does the same)</p>
        {composerFor({ kind: "ready" }, "Reply…", {
          agentStartsOn: true,
          onRemoveFile: noop,
          staged: [
            {
              id: "s1",
              mediaType: "application/pdf",
              name: "returns-policy-2026.pdf",
              progress: 0.45,
              sizeBytes: 1_200_000,
              status: "uploading",
            },
            {
              id: "s2",
              mediaType: "image/jpeg",
              name: "IMG_4411_lid.jpg",
              previewUrl: photo("#3c4a63", "#7d5a4c"),
              sizeBytes: 2_100_000,
              status: "ready",
            },
          ],
        })}
      </div>
      <div className="visual-composer-cell">
        <p className="visual-label">People-only channel — agents can’t be asked here</p>
        {composerFor({ kind: "people-only" }, "Message #leadership")}
      </div>
      <div className="visual-composer-cell">
        <p className="visual-label">Not connected: asking offers “Connect your Opensteer”</p>
        <div className="visual-popover-sample">
          <AgentUnavailable kind="not-linked" onConnect={noop} />
        </div>
      </div>
      <div className="visual-composer-cell">
        <p className="visual-label">One-time hint after joining</p>
        <AskAgentHint folderLabel="Agent home" onDismiss={noop} />
        {composerFor({ kind: "ready" }, "Message #general", { typing: [leo, maya] })}
      </div>
    </div>
  );
}

function SearchSample() {
  const [query, setQuery] = useState("store credit");
  const [filters, setFilters] = useState<SearchFilters>({
    authorId: null,
    channelId: "support",
    hasFile: false,
    inThreads: false,
  });
  return (
    <Frame>
      <TeamSearch
        channels={[
          { id: "general", kind: "public", name: "general" },
          { id: "support", kind: "public", name: "support" },
          { id: "leadership", kind: "private", name: "leadership" },
          { id: "dm-maya", kind: "dm", name: "Maya Chen" },
        ]}
        filters={filters}
        header={
          <AreaHeader
            mark={
              <span
                className="team-tile team-tile--20"
                style={{ "--team-tile-tint": acme.color } as React.CSSProperties}
              >
                A
              </span>
            }
            title="Search Acme"
          />
        }
        onFilters={setFilters}
        onOpenResult={noop}
        onQuery={setQuery}
        people={[tim, ...people]}
        query={query}
        results={[
          {
            channel: { id: "support", kind: "public", name: "support" },
            message: message("r1", tim, 41, "@tim-agent do store credit instead", {
              mentions: [mention.myAgent],
            }),
            threadOf: "Customer on 4411 says the lid…",
          },
          {
            channel: { id: "support", kind: "public", name: "support" },
            message: message(
              "r2",
              leo,
              83,
              "Heads up: Shopify’s refund API is flaky this morning. If a refund fails, use store credit and note it on the order.",
            ),
            threadOf: null,
          },
          {
            channel: { id: "support", kind: "public", name: "support" },
            message: {
              ...message(
                "r3",
                priya,
                60 * 24 * 14,
                "Basic-tier damage claims since September: 6, all closed with store credit.",
              ),
              author: { kind: "agent", owner: priya },
            },
            threadOf: null,
          },
        ]}
      />
    </Frame>
  );
}

function Index() {
  return (
    <main className="visual-index">
      <h1>Tasks and teams</h1>
      <ul>
        {Object.keys(screens).map((key) => (
          <li key={key}>
            <a href={`#${key}`}>{key}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}

function Harness() {
  const [key, setKey] = useState(() => location.hash.slice(1));
  window.onhashchange = () => setKey(location.hash.slice(1));
  const screen = screens[key];
  return (
    <MemoryRouter>
      <ToastProvider>{screen ? screen() : <Index />}</ToastProvider>
    </MemoryRouter>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
