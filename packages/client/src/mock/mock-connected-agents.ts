import {
  chatGrantShape,
  BrowserProfileIdSchema,
  BrowserSourceIdSchema,
  RunIdSchema,
  UserIdSchema,
  type AgentGrant,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { AgentConnectionIdentityAtConsent } from "@opensteer/control-plane-protocol";
import type { ChromeTabGrantCatalog } from "../host/connected-agent-options.js";
import type {
  AgentConnection,
  AgentConnectionConsent,
  AgentConnectionIdentityPresentation,
} from "@opensteer/protocol";
import { channelProviderCatalog, type ChannelDashboard } from "@opensteer/channel-core";

/**
 * Connected agents a preview opens on (`?mock-agents`): one per state the list and an
 * agent's page show, and a consent waiting at `/mcp-authorization?request=` the scene's
 * `requestId`. `?mock-agents=expired` holds no consent, so its page says it expired. The
 * other scenes change only who asks and which Chrome can share tabs: `verified` (a verified
 * platform, no Chrome paired), `pair` (a verified pairing, two Chromes), `repair` (a Chrome
 * that must be paired again), `local` (an app on this computer), `long` (long names) and
 * `changed` (verified when read, no longer by the time the person allows it). `chats` adds
 * chats in each state a person can see (live, paused by the person on Slack and on iMessage,
 * paused because its account needs attention, ended), with the Messaging accounts they speak
 * through; `chats-empty` has those accounts and no chat yet; `chats-unreadable` is `chats` on a
 * Home whose Messaging accounts and connected agents can't be read, as when it is unreachable.
 */
export const mockConnectedAgentScenes = [
  "seeded",
  "expired",
  "verified",
  "pair",
  "repair",
  "local",
  "long",
  "changed",
  "chats",
  "chats-empty",
  "chats-unreadable",
] as const;
export type MockConnectedAgentScene = (typeof mockConnectedAgentScenes)[number];

export const mockConsentRequestId = "mockconsentrequest0000000000000000000000000";
const mockUserId = UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001");
const shoppingProfile = BrowserProfileIdSchema.parse("bpr_00000000-0000-4000-8000-000000000003");
const day = 24 * 60 * 60_000;

const warning = "Only allow this if you started it yourself.";
const recordedAt = "2026-11-03T10:00:00.000Z";

/** What a Home records and says about who asked, as its consent read and list carry it. */
type MockIdentity = {
  readonly identityAtConsent: AgentConnectionIdentityAtConsent;
  readonly identity: AgentConnectionIdentityPresentation;
};
function verifiedPlatform(id: string, name: string, origin: string): MockIdentity {
  return {
    identityAtConsent: {
      kind: "platform",
      platformOrigin: origin,
      platformDirectoryId: id,
      platformName: name,
      directoryRevision: 3,
      recordedAt,
    },
    identity: {
      evidenceKind: "platform",
      verified: true,
      selfAsserted: false,
      heading: name,
      detail: origin,
      origins: [{ role: "platform", label: name, origin }],
      warning,
    },
  };
}
function selfNamed(
  clientName: string,
  redirectOrigin: string | null,
  isLoopback: boolean,
): MockIdentity {
  return {
    identityAtConsent: {
      kind: "unverified",
      redirectOrigin,
      isLoopback,
      clientName,
      directoryRevision: 3,
      recordedAt,
    },
    identity: {
      evidenceKind: "unverified",
      verified: false,
      selfAsserted: true,
      heading: clientName,
      detail: isLoopback || !redirectOrigin ? "an app on this computer" : redirectOrigin,
      origins:
        isLoopback || !redirectOrigin
          ? []
          : [{ role: "redirect", label: clientName, origin: redirectOrigin }],
      warning,
    },
  };
}
const verifiedAgentPay: MockIdentity = {
  identityAtConsent: {
    kind: "platform",
    platformOrigin: "https://agentpay.example",
    platformDirectoryId: "agentpay",
    platformName: "AgentPay",
    directoryRevision: 3,
    recordedAt,
  },
  identity: {
    evidenceKind: "platform",
    verified: true,
    selfAsserted: false,
    heading: "AgentPay",
    detail: "https://agentpay.example",
    origins: [{ role: "platform", label: "AgentPay", origin: "https://agentpay.example" }],
    warning,
  },
};

function agent(input: {
  readonly n: number;
  /** What the Home said about who asked; none for an older Home. */
  readonly who?: MockIdentity;
  readonly label: string;
  readonly clientName?: string;
  readonly origin: string;
  readonly accessMode: ThreadAccessMode;
  readonly grant: AgentGrant;
  readonly state?: AgentConnection["state"];
  readonly uncertain?: boolean;
  readonly lastUsedMinutes?: number;
  readonly now: Date;
}): AgentConnection {
  const now = input.now.getTime();
  return {
    id: `mcn_00000000-0000-4000-8000-00000000000${input.n}`,
    userId: mockUserId,
    label: input.label,
    clientName: input.clientName ?? input.label,
    accessMode: input.accessMode,
    grant: input.grant,
    grantRevision: 1,
    consentVersion: 2,
    client: { fingerprint: null, redirectOrigin: input.origin },
    ...input.who,
    state: input.state ?? "active",
    lastActionUncertain: input.uncertain ?? false,
    revokedAt:
      input.state === "stopping" || input.state === "stopped"
        ? new Date(now - 40 * 60_000).toISOString()
        : null,
    createdAt: new Date(now - 17 * day).toISOString(),
    lastUsedAt:
      input.lastUsedMinutes === undefined
        ? null
        : new Date(now - input.lastUsedMinutes * 60_000).toISOString(),
    expiresAt: new Date(now + (input.state === "expired" ? -2 : 13) * day).toISOString(),
  };
}

/** Who a mock agent is, as a Home records and presents it, for fixtures elsewhere. */
export const mockAgentIdentity = { verifiedPlatform, selfNamed } as const;

const slackAccount = "cha_00000000-0000-4000-8000-0000000000c1";
const slackChannel = "con_00000000-0000-4000-8000-0000000000c1";
const messagesAccount = "cha_00000000-0000-4000-8000-0000000000c2";
const messagesChannel = "con_00000000-0000-4000-8000-0000000000c2";
const pagerAccount = "cha_00000000-0000-4000-8000-0000000000c3";
const pagerChannel = "con_00000000-0000-4000-8000-0000000000c3";

/** The Messaging accounts the mock chats speak through, as `channels.get` lists them. */
function mockChannels(now: Date): ChannelDashboard {
  const at = new Date(now.getTime() - 20 * day).toISOString();
  const channel = (
    id: string,
    provider: "slack" | "imessage",
    displayName: string,
    status: "connected" | "paused" | "needs-attention",
    statusDetail: string | null = null,
  ) => ({
    capabilities: [],
    connectionMethod: provider === "imessage" ? ("computer" as const) : ("api-key" as const),
    createdAt: at,
    displayName,
    externalIdentityId: null,
    externalTenantId: null,
    id: id as never,
    ownerUserId: mockUserId,
    provider,
    status,
    statusDetail,
    statusReason: status === "needs-attention" ? ("credentials" as const) : null,
    transportKind: provider === "imessage" ? ("computer" as const) : ("socket" as const),
    updatedAt: at,
  });
  const account = (
    id: string,
    connectionId: string,
    provider: "slack" | "imessage",
    displayName: string,
    status: "connected" | "paused" | "needs-attention",
  ) => ({
    connectionId: connectionId as never,
    createdAt: at,
    displayName,
    externalAccountId: `T-${id.slice(-2)}`,
    handle: null,
    id: id as never,
    metadata: {},
    provider,
    routingMode: "dedicated" as const,
    status,
    updatedAt: at,
  });
  return {
    accounts: [
      account(slackAccount, slackChannel, "slack", "Workshop", "connected"),
      account(messagesAccount, messagesChannel, "imessage", "tim@example.com", "paused"),
      account(pagerAccount, pagerChannel, "slack", "On-call", "needs-attention"),
    ],
    connections: [
      // Each account is its connection's, as on a Home: the provider names the same tenant.
      {
        ...channel(slackChannel, "slack", "Workshop", "connected"),
        externalTenantId: `T-${slackAccount.slice(-2)}`,
      },
      channel(messagesChannel, "imessage", "Messages on Studio Mac", "paused"),
      {
        ...channel(
          pagerChannel,
          "slack",
          "On-call",
          "needs-attention",
          "Slack says the token was revoked.",
        ),
        externalTenantId: `T-${pagerAccount.slice(-2)}`,
      },
    ],
    deliveriesNeedingAttention: 0,
    me: [
      { accountId: slackAccount as never, displayName: "Tim", externalUserId: "U-TIM" },
      {
        accountId: messagesAccount as never,
        displayName: "+1 415 555 0100",
        externalUserId: "+14155550100",
      },
    ],
    providers: [...channelProviderCatalog],
  };
}

/** A chat's grant shape as the Home sends it (core's one rule). */
export function wireGrantShape(senders: "owner" | "anyone") {
  const shape = chatGrantShape(senders);
  return { ...shape, resources: [...shape.resources] };
}

/** Chats in each state a person can see, each a connection with a grant like any agent. */
function mockChats(now: Date): readonly AgentConnection[] {
  const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };
  const chat = (input: {
    readonly n: number;
    readonly label: string;
    readonly provider: string;
    readonly accountId: string;
    readonly accountName: string;
    readonly accountHandle?: string;
    readonly channelConnectionId: string;
    readonly conversation?: { readonly id: string; readonly name: string };
    readonly senders: "owner" | "anyone";
    readonly me?: { readonly displayName: string; readonly externalUserId: string } | null;
    readonly state: NonNullable<AgentConnection["state"]>;
    readonly bridge?: Partial<NonNullable<AgentConnection["bridge"]>>;
  }): AgentConnection => ({
    ...agent({
      n: input.n,
      label: input.label,
      origin: "",
      accessMode: "approval-required",
      grant: tasksOnly,
      state: input.state,
      lastUsedMinutes: 25,
      now,
    }),
    id: `mcn_00000000-0000-4000-8000-0000000000c${input.n}`,
    clientName: input.provider,
    client: { fingerprint: null, redirectOrigin: null },
    expiresAt: null,
    bridge: {
      accountId: input.accountId,
      provider: input.provider,
      conversationId: input.conversation?.id ?? null,
      senders: input.senders,
      grantShape: wireGrantShape(input.senders),
      accountName: input.accountName,
      ...(input.accountHandle ? { accountHandle: input.accountHandle } : {}),
      conversationName: input.conversation?.name ?? null,
      channelConnectionId: input.channelConnectionId,
      me: input.me ?? null,
      unknownReplies: 0,
      tasks: [],
      ...input.bridge,
    },
  });
  const tim = { displayName: "Tim", externalUserId: "U-TIM" };
  return [
    chat({
      n: 1,
      label: "Slack",
      provider: "Slack",
      accountId: slackAccount,
      accountName: "Workshop",
      channelConnectionId: slackChannel,
      senders: "owner",
      me: tim,
      state: "active",
      bridge: {
        tasks: [
          {
            id: "thr_00000000-0000-4000-8000-0000000000c1",
            title: "Summarize my week",
            running: true,
            runId: RunIdSchema.parse("run_00000000-0000-4000-8000-0000000000c1"),
          },
          {
            id: "thr_00000000-0000-4000-8000-0000000000c2",
            title: "Book the dentist",
            running: false,
            runId: null,
          },
        ],
      },
    }),
    chat({
      n: 2,
      label: "Slack · #team",
      provider: "Slack",
      accountId: slackAccount,
      accountName: "Workshop",
      channelConnectionId: slackChannel,
      conversation: { id: "C-TEAM", name: "#team" },
      senders: "anyone",
      // The Home sends who is you on the account, whoever may speak in the chat.
      me: tim,
      // Its account, Workshop, is connected: so is the chat.
      state: "active",
    }),
    chat({
      n: 3,
      label: "iMessage",
      provider: "iMessage",
      accountId: messagesAccount,
      accountName: "tim@example.com",
      accountHandle: "tim@example.com",
      channelConnectionId: messagesChannel,
      senders: "owner",
      me: { displayName: "+1 415 555 0100", externalUserId: "+14155550100" },
      state: "paused",
      bridge: { pausedBy: "you", pauseDetail: null, pausedMessages: "kept" },
    }),
    chat({
      n: 4,
      label: "Slack · On-call",
      provider: "Slack",
      accountId: pagerAccount,
      accountName: "On-call",
      channelConnectionId: pagerChannel,
      senders: "owner",
      // Nobody is linked as you on On-call yet, as its Messaging account says.
      me: null,
      state: "paused",
      bridge: {
        pausedBy: "needs-attention",
        pauseDetail: "Slack says the token was revoked.",
        pausedMessages: "lost",
        unknownReplies: 1,
      },
    }),
    chat({
      n: 5,
      label: "Slack · #standup",
      provider: "Slack",
      accountId: slackAccount,
      accountName: "Workshop",
      channelConnectionId: slackChannel,
      conversation: { id: "C-STANDUP", name: "#standup" },
      senders: "anyone",
      state: "stopped",
      bridge: { endedBy: "you" },
    }),
  ];
}

/** On-call's token was revoked: its provider no longer accepts what it holds. */
const mockChannelTokens = { [pagerChannel]: { botToken: "", appToken: "" } };

export function mockConnectedAgents(
  scene: MockConnectedAgentScene,
  now = new Date(),
): {
  readonly connections: readonly AgentConnection[];
  /** The Messaging accounts behind the scene's chats. */
  readonly channels?: ChannelDashboard;
  /** The tokens the scene's messaging connections hold, as their provider reads them. */
  readonly channelTokens?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly connectionConsent?: AgentConnectionConsent;
  readonly chromeTabs?: ChromeTabGrantCatalog;
  readonly connectionConsentChange?: AgentConnectionConsent;
  /** The scene's Messaging accounts and connected agents can't be read. */
  readonly unreadable?: boolean;
} {
  const connections = [
    agent({
      n: 1,
      label: "Grok",
      origin: "https://grok.com",
      who: selfNamed("Grok", "https://grok.com", false),
      accessMode: "approval-required",
      grant: {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: shoppingProfile }],
      },
      lastUsedMinutes: 120,
      now,
    }),
    agent({
      n: 2,
      label: "Claude",
      origin: "https://claude.ai",
      who: verifiedPlatform("claude", "Claude", "https://claude.ai"),
      accessMode: "full-access",
      grant: { scope: "everything" },
      lastUsedMinutes: 3 * 24 * 60,
      now,
    }),
    agent({
      n: 3,
      label: "Trip planner",
      clientName: "TravelBot Agent",
      origin: "https://trips.example",
      who: selfNamed("TravelBot Agent", "https://trips.example", false),
      accessMode: "auto",
      grant: { scope: "selected", tasks: true, resources: [] },
      now,
    }),
    agent({
      n: 4,
      label: "Shop helper",
      origin: "https://shophelper.example",
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: false, resources: [] },
      state: "stopping",
      uncertain: true,
      now,
    }),
    agent({
      n: 5,
      label: "Old notes agent",
      origin: "https://notes.example",
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: false, resources: [] },
      state: "stopped",
      now,
    }),
    agent({
      n: 6,
      label: "Errand",
      origin: "https://agentpay.example",
      who: verifiedAgentPay,
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: false, resources: [] },
      lastUsedMinutes: 90,
      now,
    }),
    agent({
      n: 7,
      label: "Claude Code",
      origin: "http://127.0.0.1:53682",
      who: selfNamed("Claude Code", "http://127.0.0.1:53682", true),
      accessMode: "auto",
      grant: { scope: "selected", tasks: true, resources: [] },
      lastUsedMinutes: 30,
      now,
    }),
    agent({
      n: 8,
      label: "ChatGPT",
      origin: "https://chatgpt.com",
      who: verifiedPlatform("chatgpt", "ChatGPT", "https://chatgpt.com"),
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: false, resources: [] },
      lastUsedMinutes: 5 * 24 * 60,
      now,
    }),
  ];
  if (scene === "expired") return { connections };
  // Chats are listed beside an ordinary connected agent, as on a real Home.
  if (scene === "chats")
    return {
      connections: [connections[1]!, ...mockChats(now)],
      channels: mockChannels(now),
      channelTokens: mockChannelTokens,
    };
  if (scene === "chats-empty") return { connections: [], channels: mockChannels(now) };
  if (scene === "chats-unreadable")
    return {
      connections: [connections[1]!, ...mockChats(now)],
      channels: mockChannels(now),
      channelTokens: mockChannelTokens,
      unreadable: true,
    };
  const chrome = (computerName: string, n: number, paired = true) => ({
    sourceId: BrowserSourceIdSchema.parse(`bsr_00000000-0000-4000-8000-00000000000${n}`),
    computerName,
    paired,
  });
  const chromeTabs: ChromeTabGrantCatalog =
    scene === "verified"
      ? { chromeTabs: [] }
      : scene === "pair"
        ? { chromeTabs: [chrome("Studio Mac", 1), chrome("MacBook Air", 2)] }
        : scene === "repair"
          ? { chromeTabs: [chrome("Studio Mac", 1, false)], chromeTabsNeedPairing: true }
          : scene === "long"
            ? { chromeTabs: [chrome("Alexandra’s MacBook Pro (16-inch, 2024, Work)", 1)] }
            : { chromeTabs: [chrome("Studio Mac", 1)] };
  const longName = "Personal Shopping Concierge for Weekly Groceries and Household Errands";
  const who =
    scene === "verified" || scene === "changed"
      ? {
          clientName: "Claude",
          redirect: "https://claude.ai/api/mcp/auth_callback",
          ...verifiedPlatform("claude", "Claude", "https://claude.ai"),
        }
      : scene === "pair"
        ? {
            clientName: "Errand",
            redirect: "https://agentpay.example/oauth/callback",
            ...verifiedAgentPay,
          }
        : scene === "local"
          ? {
              clientName: "Claude Code",
              redirect: "http://127.0.0.1:53682/callback",
              ...selfNamed("Claude Code", "http://127.0.0.1:53682", true),
            }
          : scene === "long"
            ? {
                clientName: longName,
                redirect: "https://concierge-shopping-assistant.example/oauth/callback",
                ...selfNamed(longName, "https://concierge-shopping-assistant.example", false),
              }
            : {
                clientName: "Grok",
                redirect: "https://grok.com/oauth/callback",
                ...selfNamed("Grok", "https://grok.com", false),
              };
  const consent: AgentConnectionConsent = {
    requestId: mockConsentRequestId,
    clientName: who.clientName,
    redirectUri: who.redirect,
    identityAtConsent: who.identityAtConsent,
    identity: who.identity,
    ...chromeTabs,
    resource: "http://127.0.0.1:4315/internal/v1/mcp",
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  };
  if (scene === "changed") {
    const after = selfNamed("Claude", "https://claude.ai", false);
    return {
      connections,
      chromeTabs,
      connectionConsent: { ...consent, verificationSnapshot: "a".repeat(64) },
      connectionConsentChange: {
        ...consent,
        ...after,
        verificationSnapshot: "b".repeat(64),
      },
    };
  }
  return { connections, chromeTabs, connectionConsent: consent };
}
