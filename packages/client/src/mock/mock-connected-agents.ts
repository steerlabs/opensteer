import {
  BrowserProfileIdSchema,
  BrowserSourceIdSchema,
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

/**
 * Connected agents a preview opens on (`?mock-agents`): one per state the list and an
 * agent's page show, and a consent waiting at `/mcp-authorization?request=` the scene's
 * `requestId`. `?mock-agents=expired` holds no consent, so its page says it expired. The
 * other scenes change only who asks and which Chrome can share tabs: `verified` (a verified
 * platform, no Chrome paired), `pair` (a verified pairing, two Chromes), `repair` (a Chrome
 * that must be paired again), `local` (an app on this computer), `long` (long names) and
 * `changed` (verified when read, no longer by the time the person allows it).
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
] as const;
export type MockConnectedAgentScene = (typeof mockConnectedAgentScenes)[number];

export const mockConsentRequestId = "mockconsentrequest0000000000000000000000000";
const mockUserId = UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001");
const shoppingProfile = BrowserProfileIdSchema.parse("bpr_00000000-0000-4000-8000-000000000003");
const day = 24 * 60 * 60_000;

const warning = "Only approve if you started this yourself.";
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
const errandViaAgentPay: MockIdentity = {
  identityAtConsent: {
    kind: "platform-and-embedder",
    platformOrigin: "https://agentpay.example",
    platformDirectoryId: "agentpay",
    platformName: "AgentPay",
    embedderOrigin: "https://errand.example",
    embedderDirectoryId: "errand",
    embedderName: "Errand",
    keyThumbprint: "a".repeat(43),
    directoryRevision: 3,
    recordedAt,
  },
  identity: {
    evidenceKind: "platform-and-embedder",
    verified: true,
    selfAsserted: false,
    heading: "Errand via AgentPay",
    detail: "Errand asked for this. AgentPay will hold the access.",
    origins: [
      { role: "embedder", label: "Errand", origin: "https://errand.example" },
      { role: "platform", label: "AgentPay", origin: "https://agentpay.example" },
    ],
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

export function mockConnectedAgents(
  scene: MockConnectedAgentScene,
  now = new Date(),
): {
  readonly connections: readonly AgentConnection[];
  readonly connectionConsent?: AgentConnectionConsent;
  readonly chromeTabs?: ChromeTabGrantCatalog;
  readonly connectionConsentChange?: AgentConnectionConsent;
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
      who: errandViaAgentPay,
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
            ...errandViaAgentPay,
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
