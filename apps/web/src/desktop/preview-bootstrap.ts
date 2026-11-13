import { createId, emptyExecutionPreferences, SequenceSchema } from "@opensteer/core";
import type { DesktopDeploymentSummary } from "@opensteer/protocol/desktop";

/** The one moment every preview record claims, so nothing in it reads as live. */
export const previewDate = "2026-08-12T19:00:00.000Z";

const previewBrowser = {
  available: false,
  groups: { rows: [], complete: true },
  placements: [],
  profiles: [],
  tabs: [],
};

/**
 * A complete, valid bootstrap for one selected place, with nothing in it but
 * the place itself. The Electron place-list smoke serves it too, so the real
 * app shell renders around a place without a Host behind it.
 */
export function previewBootstrap(
  selected: DesktopDeploymentSummary,
  ids: {
    readonly environmentId: ReturnType<typeof createId<"environment">>;
    readonly runnerId: ReturnType<typeof createId<"runner">>;
    readonly userId: ReturnType<typeof createId<"user">>;
  },
) {
  return {
    deploymentId: selected.id,
    sessionId: createId("authSession"),
    personalSettings: {
      ownerId: ids.userId,
      agentHome: { computerId: ids.runnerId, path: "/Users/preview/Opensteer" },
      voiceThreadId: null,
    },
    can: { createTasks: true, useVoice: true, manageComputers: true, managePrivateResources: true },
    appTabs: [],
    browser: previewBrowser,
    latestPlaces: [],
    environments: [
      {
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
      },
    ],
    executionPreferences: emptyExecutionPreferences,
    quietTaskDays: 7,
    harnesses: [],
    identityConfig: {
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
    },
    machines: [
      {
        access: null,
        allowedModules: ["agents", "browser", "shell"],
        detail: null,
        enrollmentId: "ren_preview-runner",
        expiresAt: null,
        // The same answer this preview's `checkFullDiskAccess` gives.
        fullDiskAccess: false,
        id: ids.runnerId,
        lastSeenAt: previewDate,
        modules: { agents: { checkedAt: previewDate, detail: null, readiness: "ready" } },
        name: "Preview MacBook",
        ownership: "deployment",
        pinnedThreads: 1,
        revocable: false,
        status: "online",
      },
    ],
    sessionSurface: "canonical",
    user: {
      disabledAt: null,
      displayName: "Preview User",
      email: "preview@opensteer.invalid",
      emailVerified: true,
      id: ids.userId,
      image: null,
    },
  };
}

/** An empty personal stream snapshot: no tasks, nothing waiting. */
export function previewDeploymentSnapshot(deploymentId: string) {
  const window = { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
  const page = { asOfSequence: SequenceSchema.parse("0"), tasks: [], window };
  return {
    tasks: { recent: page, active: page, done: page },
    needsYou: { count: 0, entries: [], window },
    resources: { appTabs: [], browser: previewBrowser },
    messages: [],
    messageWindows: [],
    pendingRequests: [],
    pendingRequestWindow: window,
    runQueue: [],
    sequence: "0",
    serializedBytes: 2,
    threadWindow: window,
    threads: [],
    deploymentId,
  };
}
