import { createId, emptyExecutionPreferences } from "@opensteer/core";
import type { DesktopDeploymentSummary } from "@opensteer/protocol/desktop";

/** The one moment every preview record claims, so nothing in it reads as live. */
export const previewDate = "2026-08-12T19:00:00.000Z";

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
    readonly workspaceId: ReturnType<typeof createId<"workspace">>;
  },
) {
  const workspace = previewWorkspace(selected, ids.workspaceId, ids.environmentId);
  return {
    deploymentId: selected.id,
    notificationPreferences: [{ workspaceId: workspace.id, muted: false, revision: "0" }],
    browser: {
      profileGrants: [],
      available: false,
      placements: [],
      profiles: [],
      sessions: [],
    },
    deploymentShape: {
      defaultWorkspaceBacking: selected.kind === "personal" ? "local-directory" : "portablefs",
      kind: selected.kind === "personal" ? "personal" : "server",
    },
    environments: [
      {
        capabilities: ["filesystem", "host-apps", "network-egress"],
        connected: true,
        harnessAuthenticationAllowed: true,
        harnessCatalogs: [],
        harnessDrivers: [],
        providerStateModes: selected.kind === "personal" ? ["ambient", "isolated"] : ["isolated"],
        id: ids.environmentId,
        kind: "main",
        name: "This Computer",
        runnerId: ids.runnerId,
        status: "connected",
        workspaceBackings: ["local-directory"],
      },
    ],
    harnesses: [],
    homeWorkspace: workspace,
    identityConfig: {
      deployment: {
        cloud: false,
        kind: selected.kind === "self-hosted" ? "self-hosted" : "personal",
        name: selected.name,
      },
      emailDeliveryAvailable: true,
      exposure: selected.kind === "personal" ? "loopback" : "networked",
      localPasswordEnabled: false,
      machineOwner: selected.kind === "personal",
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
        localWorkspaces: 1,
        modules: { agents: { checkedAt: previewDate, detail: null, readiness: "ready" } },
        name: "Preview MacBook",
        ownership: "deployment",
        pinnedThreads: 1,
        revocable: false,
        status: "online",
        unlinkedLocalFolders: 0,
      },
    ],
    user: {
      disabledAt: null,
      displayName: "Preview User",
      email: "preview@opensteer.invalid",
      emailVerified: true,
      id: ids.userId,
      image: null,
      instanceRole: "administrator",
    },
    executionPreferences: emptyExecutionPreferences,
    workspaceSharingAvailable: false,
    workspaces: [workspace],
    workspaceWindow: {
      byteCount: 2,
      hasMore: false,
      itemCount: 1,
      nextBefore: null,
      totalItems: 1,
    },
  };
}

export function previewWorkspace(
  selected: DesktopDeploymentSummary,
  workspaceId: ReturnType<typeof createId<"workspace">>,
  environmentId: ReturnType<typeof createId<"environment">>,
) {
  const local = selected.kind === "personal" && selected.onThisComputer;
  return {
    capacity: { kind: local ? ("host-filesystem" as const) : ("managed-quota" as const) },
    createdAt: previewDate,
    id: workspaceId,
    homeThreadId: createId("thread"),
    icon: null,
    kind: "main" as const,
    location: local
      ? { environmentId, kind: "machine" as const, name: "This Computer" }
      : { kind: "shared-storage" as const },
    name: "Main",
    status: "ready" as const,
    storageIssue: null,
    updatedAt: previewDate,
  };
}
