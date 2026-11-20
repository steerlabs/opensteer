import {
  BrowserProfileIdSchema,
  UserIdSchema,
  type AgentGrant,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { AgentConnection, AgentConnectionConsent } from "@opensteer/protocol";

/**
 * Connected agents a preview opens on (`?mock-agents`): one per state the list and an
 * agent's page show, and a consent waiting at `/mcp-authorization?request=` the scene's
 * `requestId`. `?mock-agents=expired` holds no consent, so its page says it expired.
 */
export const mockConnectedAgentScenes = ["seeded", "expired"] as const;
export type MockConnectedAgentScene = (typeof mockConnectedAgentScenes)[number];

export const mockConsentRequestId = "mockconsentrequest0000000000000000000000000";
const mockUserId = UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001");
const shoppingProfile = BrowserProfileIdSchema.parse("bpr_00000000-0000-4000-8000-000000000003");
const day = 24 * 60 * 60_000;

function agent(input: {
  readonly n: number;
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

export function mockConnectedAgents(
  scene: MockConnectedAgentScene,
  now = new Date(),
): {
  readonly connections: readonly AgentConnection[];
  readonly connectionConsent?: AgentConnectionConsent;
} {
  const connections = [
    agent({
      n: 1,
      label: "Grok",
      origin: "https://grok.com",
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
  ];
  if (scene === "expired") return { connections };
  return {
    connections,
    connectionConsent: {
      requestId: mockConsentRequestId,
      clientName: "Grok",
      redirectUri: "https://grok.com/oauth/callback",
      resource: "http://127.0.0.1:4315/internal/v1/mcp",
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    },
  };
}
