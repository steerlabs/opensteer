import { createId, emptyExecutionPreferences } from "@opensteer/core";
import type { DesktopDeploymentSummary } from "@opensteer/protocol/desktop";
import { PersonalNetworkShellSnapshotSchema } from "@opensteer/protocol/personal-sync";
import {
  personalResourceKinds,
  PersonalResourceDetailSchema,
  PersonalResourceRevisionsSchema,
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
  const environment = {
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
  };
  const machine = {
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
    pinnedThreads: 1,
    revocable: false,
    status: "online",
  };
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
  const previews = {
    environment: [{ id: environment.id, label: environment.name, status: environment.status }],
    machine: [{ id: machine.id, label: machine.name, status: machine.status }],
  };
  function summary(kind: PersonalResourceKind) {
    return {
      kind,
      revision: "0",
      view: {
        entries: kind === "environment" || kind === "machine" ? previews[kind] : [],
        complete: true,
        hasMore: false,
      },
    };
  }
  const details = {
    settings: { settings, quietTaskDays: 7, executionPreferences: emptyExecutionPreferences },
    identity: { identity },
    "owner-profile": { ownerProfile: null },
    environment: { environments: [environment] },
    machine: { machines: [machine] },
    harness: { harnesses: [] },
    "harness-catalog": { environments: [environment] },
    "harness-auth": { environments: [environment] },
    "agent-home-settings": { settings },
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
    recentTaskIds: [],
    visits: [],
    attention: [],
    counts: { pendingRequestCount: 0, needsYouCount: 0, unreadTaskCount: 0 },
    resourceRevisions: PersonalResourceRevisionsSchema.parse(
      Object.fromEntries(personalResourceKinds.map((kind) => [kind, "0"])),
    ),
    resources: [summary("machine"), summary("environment")],
  });
  return {
    shell,
    summary,
    resource: (kind: PersonalResourceKind) =>
      PersonalResourceDetailSchema.parse({
        revision: "0",
        data: { kind, ...details[kind] },
        next: null,
      }),
  };
}
