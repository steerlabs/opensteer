import { createId, emptyExecutionPreferences } from "@opensteer/core";
import {
  HostBootstrapEnvironmentSchema,
  MachineSummarySchema,
  environmentInventoryEntry,
  machineInventoryEntry,
} from "@opensteer/protocol";
import type { DesktopDeploymentSummary } from "@opensteer/protocol/desktop";
import { PersonalNetworkShellSnapshotSchema } from "@opensteer/protocol/personal-sync";
import {
  PersonalResourceDetailSchema,
  type PersonalResourceKind,
} from "@opensteer/protocol/resources";

/** The one moment every preview record claims, so nothing in it reads as live. */
export const previewDate = "2026-08-12T19:00:00.000Z";

/** No tabs: the place previewed is the whole page. */
const previewTabs = { tabs: [], layout: { revision: 0, items: [] }, complete: true };

export function previewPersonalHost(
  selected: DesktopDeploymentSummary,
  ids: {
    readonly environmentId: ReturnType<typeof createId<"environment">>;
    readonly runnerId: ReturnType<typeof createId<"runner">>;
    readonly userId: ReturnType<typeof createId<"user">>;
    readonly sessionId: ReturnType<typeof createId<"authSession">>;
  },
) {
  const settings = {
    ownerId: ids.userId,
    agentHome: { computerId: ids.runnerId, path: "/Users/preview/Opensteer" },
    voiceThreadId: null,
  };
  const environment = HostBootstrapEnvironmentSchema.parse({
    capabilities: ["filesystem", "host-apps", "network-egress"],
    connected: true,
    harnessAuthenticationAllowed: true,
    harnessCatalogs: [],
    harnessDrivers: [],
    providerStateModes: ["ambient", "isolated"],
    id: ids.environmentId,
    kind: "main",
    name: "This Computer",
    runnerId: ids.runnerId,
    status: "connected",
    can: { executeTasks: true },
  });
  const machine = MachineSummarySchema.parse({
    access: null,
    allowedModules: ["agents", "browser", "shell"],
    detail: null,
    enrollmentId: "ren_preview-runner",
    expiresAt: null,
    fullDiskAccess: false,
    id: ids.runnerId,
    lastSeenAt: previewDate,
    modules: { agents: { checkedAt: previewDate, detail: null, readiness: "ready" } },
    name: "Preview MacBook",
    ownership: "deployment",
    revocable: false,
    status: "online",
  });
  const identity = {
    deployment: { kind: "personal", name: selected.name },
    emailDeliveryAvailable: true,
    exposure: "loopback",
    localPasswordEnabled: false,
    machineOwner: true,
    oidcProviders: [],
    passkeysEnabled: false,
    portalOrigin: null,
    publicOrigin: selected.canonicalOrigin,
    setupState: "complete",
    signupPolicy: "closed",
  };
  const details = {
    settings: { settings, quietTaskDays: 7, executionPreferences: emptyExecutionPreferences },
    identity: { identity },
    "owner-profile": { ownerProfile: null },
    // Summaries, as the real Host lists them; each one whole is its detail read.
    environment: { environments: [environmentInventoryEntry(environment)] },
    machine: { machines: [machineInventoryEntry(machine)] },
    harness: { harnesses: [] },
    "harness-catalog": {
      environments: [{ id: environment.id, harnessCatalogs: environment.harnessCatalogs }],
    },
    tab: { tabs: previewTabs },
    "tab-layout": { tabs: previewTabs },
    "browser-profile": { profiles: [] },
    "browser-placement": { placements: [] },
    "browser-home": { homes: [] },
    "browser-availability": { available: false },
    plugin: {},
    "plugin-scheduled-runs": {},
    "plugin-workflow-runs": {},
    "plugin-webhooks": {},
    "plugin-webhook-sources": {},
    "plugin-schedules": {},
    "plugin-engine": { engine: { status: "idle" } },
    "team-replies": {},
  } satisfies Record<PersonalResourceKind, object>;
  const shell = PersonalNetworkShellSnapshotSchema.parse({
    deploymentId: selected.id,
    viewerId: ids.userId,
    epoch: "f45d9148-ec73-4106-91f7-3e73bdb7941d",
    session: {
      sessionId: ids.sessionId,
      sessionSurface: "canonical",
      can: {
        createTasks: true,
        useVoice: true,
        manageComputers: true,
        managePrivateResources: true,
      },
      user: {
        disabledAt: null,
        displayName: "Preview User",
        email: "preview@opensteer.invalid",
        emailVerified: true,
        id: ids.userId,
        image: null,
      },
    },
    tasks: [],
    activeTaskIds: [],
    activeNextBefore: null,
    recentTaskIds: [],
    nextBefore: null,
    taskCounts: { active: 0, open: 0 },
    visits: [],
    attention: [],
    attentionHasMore: false,
    counts: {
      pendingRequestCount: 0,
      pendingRequestsRevision: "0",
      needsYouCount: 0,
      unreadTaskCount: 0,
    },
  });
  return {
    shell,
    environmentDetail: (environmentId: string) =>
      environmentId === environment.id ? { revision: "0", environment } : null,
    machineDetail: (machineId: string) =>
      machineId === machine.id ? { revision: "0", machine } : null,
    resource: (kind: PersonalResourceKind) =>
      PersonalResourceDetailSchema.parse({
        revision: "0",
        data: { kind, ...details[kind] },
        next: null,
      }),
  };
}
