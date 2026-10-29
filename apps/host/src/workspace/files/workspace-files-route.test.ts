import { generateKeyPairSync } from "node:crypto";
import { createId, type Workspace, type WorkspaceMembershipId } from "@opensteer/core";
import type {
  WorkspaceFilesAdmission,
  WorkspaceMembershipChangeListener,
  WorkspaceMembershipRecord,
} from "@opensteer/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signHostDiscovery } from "../../identity/host-keys.js";
import {
  hostServerTestDependencies,
  type HostServerTestOverrides,
} from "../../server/host-server-test-harness.js";
import { createHostServer as createProductionHostServer } from "../../server.js";
import { WorkspaceFilesService } from "./workspace-files-service.js";

const discoveryKeys = generateKeyPairSync("ed25519");

function createHostServer(dependencies: HostServerTestOverrides) {
  return createProductionHostServer(hostServerTestDependencies(dependencies));
}

afterEach(() => vi.restoreAllMocks());

describe("Workspace Files route streaming authorization", () => {
  it.each(["local-directory", "portablefs"] as const)(
    "terminates an active HTTP %s download as soon as membership is revoked",
    async (backingKind) => {
      const workspace = readyWorkspace(backingKind);
      const membership = membershipRepository(workspace);
      let upstreamCancelled = false;
      let upstreamPulls = 0;
      const download = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                upstreamCancelled = true;
              },
              pull(controller) {
                upstreamPulls += 1;
                if (upstreamPulls === 1) {
                  controller.enqueue(new Uint8Array(1_024));
                  return;
                }
                return new Promise<void>(() => undefined);
              },
            }),
            { headers: { "content-length": "2048", "content-type": "application/octet-stream" } },
          ),
      );
      const files = new WorkspaceFilesService({
        ...(backingKind === "local-directory"
          ? { local: { download } as never }
          : { portableFs: { download } as never }),
        memberships: membership.repository,
      });
      const app = await createHostServer({
        requestResponseVault: {} as never,
        agentControl: {} as never,
        agentTools: {} as never,
        authenticator: { authenticateUser: async () => membership.userId } as never,
        browser: {} as never,
        commands: {} as never,
        credentials: {} as never,
        discovery: discoveryFor(backingKind),
        egress: {} as never,
        files,
        harnessAuthenticationCoordinator: {} as never,
        // A PortableFS shape is only ever assembled with its own services.
        ...(backingKind === "portablefs"
          ? {
              portablefs: {
                mountExchange: {} as never,
                workspaceActivity: { note: () => undefined },
                workspaceWake: { wake: async () => undefined },
              },
            }
          : {}),
        realtime: {} as never,
        runnerAuthenticator: {} as never,
        runners: {} as never,
        securityEffects: {} as never,
        store: membership.repository as never,
        workspaces: {} as never,
      } satisfies HostServerTestOverrides);
      try {
        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        const response = await fetch(
          `${origin}/v1/workspaces/${workspace.id}/files/download?file=file_key`,
        );
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        await expect(reader.read()).resolves.toMatchObject({ done: false });
        await vi.waitFor(() => expect(upstreamPulls).toBeGreaterThanOrEqual(2));

        membership.change({ generation: 2, state: "revoked" });

        await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
        await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
      } finally {
        files.close();
        await app.close();
      }
    },
  );
});

function discoveryFor(defaultWorkspaceBacking: "local-directory" | "portablefs") {
  return signHostDiscovery(discoveryKeys, {
    canonicalOrigin: "https://files-route.opensteer.test",
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKey: {
      algorithm: "Ed25519",
    },
    deploymentShape: { defaultWorkspaceBacking, kind: "server" },
  });
}

function membershipRepository(workspace: Workspace) {
  const userId = workspace.createdBy;
  let membership: WorkspaceMembershipRecord = {
    generation: 1,
    id: createId("workspaceMembership") as WorkspaceMembershipId,
    invitedBy: null,
    joinedAt: new Date(),
    role: "collaborator",
    state: "active",
    userId,
    workspaceId: workspace.id,
  };
  const admission: WorkspaceFilesAdmission = {
    membershipGeneration: 1,
    userId,
    workspace,
  };
  const listeners = new Set<WorkspaceMembershipChangeListener>();
  const repository = {
    async admitWorkspaceFiles(
      requestedWorkspaceId: Workspace["id"],
      requestedUserId: typeof userId,
    ) {
      if (
        requestedWorkspaceId !== workspace.id ||
        requestedUserId !== userId ||
        membership.state !== "active"
      ) {
        return null;
      }
      return admission;
    },
    onWorkspaceMembershipChanged(listener: WorkspaceMembershipChangeListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async workspaceMembershipForUser(
      requestedWorkspaceId: Workspace["id"],
      requestedUserId: typeof userId,
    ) {
      return requestedWorkspaceId === workspace.id && requestedUserId === userId
        ? membership
        : null;
    },
  };
  return {
    change(value: Pick<WorkspaceMembershipRecord, "generation" | "state">) {
      membership = { ...membership, ...value };
      for (const listener of listeners) listener(membership);
    },
    repository,
    userId,
  };
}

function readyWorkspace(backingKind: "local-directory" | "portablefs"): Workspace {
  const now = new Date().toISOString();
  const owner = createId("user");
  return {
    backing:
      backingKind === "local-directory"
        ? {
            bindingId: createId("workspaceBinding"),
            generation: 1,
            kind: "local-directory",
            ownerEnvironmentId: createId("environment"),
            storageAuthorityId: createId("storageAuthority"),
          }
        : {
            generation: 1,
            kind: "portablefs",
            serviceId: "files-route-test",
            volumeId: "volume_files_route_test",
          },
    capacityPolicy:
      backingKind === "local-directory"
        ? { kind: "host-filesystem" }
        : { blockHardLimitBytes: 1_000_000, inodeHardLimit: 10_000, kind: "hard-quota" },
    createdAt: now,
    createdBy: owner,
    homeThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "specialized",
    name: "Files route",
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}
