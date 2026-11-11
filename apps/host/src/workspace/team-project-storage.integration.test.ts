import { createProjectIdentityFixture } from "@opensteer/database/test-support/project";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createId, type Workspace } from "@opensteer/core";
import { RunnerConnectionFenceSchema } from "@opensteer/protocol";
import { OpensteerStore, mutateAccess } from "@opensteer/database";
import { describeStore } from "@opensteer/database/test-support/store";
import type { RunnerIdentity } from "@opensteer/orchestration";
import { LocalWorkspaceAuthority } from "@opensteer/workspace-local";
import { expect } from "vitest";
import { RunnerLocalWorkspaceDriver } from "./runner-local-workspace-driver.js";
import { WorkspaceService } from "./workspace-service.js";

describeStore("team Project storage", (it) => {
  for (const namespace of ["single-owner", "owner-scoped"] as const)
    it(`preserves model-1 server paths and legacy messages for ${namespace}`, async ({
      storeFixture: f,
    }) => {
      const run = await f.createRunFixture(`legacy-${namespace}`, null, "project");
      const root = await mkdtemp(join(tmpdir(), "legacy-host-storage-"));
      try {
        const authority = new LocalWorkspaceAuthority({
          namespace:
            namespace === "single-owner"
              ? { kind: namespace, ownerEnvironmentId: run.environmentId }
              : { kind: namespace },
          registryFilePath: join(root, "registry.json"),
          visibleRootPath: join(root, "files"),
        });
        const storageAuthorityId = await authority.storageAuthorityId();
        const identity = {
          fence: {},
          modules: { agents: { localStorage: { storageAuthorityId } } },
        } as unknown as RunnerIdentity;
        const driver = new RunnerLocalWorkspaceDriver({
          database: f.database,
          runners: {
            identityForEnvironment: () => identity,
            requestWorkspaceLocal: async (_environment, request) => {
              if (request.type !== "host.workspace.local.provision")
                throw new Error("Model 1 must send the legacy provisioning message");
              const path = await authority.provision({
                binding: request.binding,
                fingerprint: request.fingerprint,
                idempotencyKey: request.operationId,
              });
              return {
                ...request,
                fence: { ...identity.fence, environmentId: run.environmentId, storageAuthorityId },
                path,
                type: "runner.workspace.local.provisioned",
              };
            },
          },
        });
        for (const kind of ["main", "project"] as const) {
          const id = createId("workspace");
          const backing = driver.initialBacking({
            backingKind: "local-directory",
            createdBy: run.userId,
            ownerEnvironmentId: run.environmentId,
            idempotencyKey: "provision",
            kind,
            name: kind,
            workspaceId: id,
          });
          const workspace = {
            ...run.workspace,
            id,
            kind,
            backing,
            slug: kind === "project" ? "support" : null,
          } as Workspace & { backing: typeof backing };
          await driver.provision({ workspace, idempotencyKey: "provision" });
          const segments = [
            ...(namespace === "owner-scoped" ? [run.userId] : []),
            "main",
            ...(kind === "project" ? ["Projects", "support"] : []),
          ];
          expect(
            (await authority.inventory()).bindings.find((row) => row.workspaceId === id)?.path,
          ).toBe(join(root, "files", ...segments));
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

  it("commits the Project, manage grant, principal and provisioning intent before filesystem work, with no Main", async ({
    storeFixture: f,
  }) => {
    const run = await createProjectIdentityFixture(f, "team-storage");
    const root = await mkdtemp(join(tmpdir(), "team-host-storage-"));
    try {
      const userId = await f.store.createUser("Project creator without Main");
      await f.database
        .updateTable("users")
        .set({ admittedAt: new Date(), instanceRole: "administrator" })
        .where("id", "=", userId)
        .execute();
      const authority = new LocalWorkspaceAuthority({
        namespace: { kind: "owner-scoped" },
        registryFilePath: join(root, "registry.json"),
        visibleRootPath: join(root, "files"),
      });
      authority.selectProjectStorage(run.environmentId);
      const storageAuthorityId = await authority.storageAuthorityId();
      const id = createId("workspace");
      const binding = {
        kind: "local-directory" as const,
        bindingId: createId("workspaceBinding"),
        generation: 1,
        ownerEnvironmentId: run.environmentId,
        storageAuthorityId,
      };
      const identity = {
        fence: RunnerConnectionFenceSchema.parse({
          runnerId: run.runnerId,
          bootId: `rbt_${randomUUID()}`,
          connectionGeneration: 1,
          connectionId: `rcn_${randomUUID()}`,
          connectionLeaseId: `rls_${randomUUID()}`,
        }),
        runnerId: run.runnerId,
        capabilities: ["project-authority-v1"],
        deploymentAuthority: { kind: "server", model: 2 },
        modules: { agents: { localStorage: { storageAuthorityId } } },
      } as unknown as RunnerIdentity;
      let online = false;
      const driver = new RunnerLocalWorkspaceDriver({
        database: f.database,
        runners: {
          identityForEnvironment: () => (online ? identity : undefined),
          requestWorkspaceLocal: async (_environment, request) => {
            const echo = {
              binding: request.binding,
              requestId: request.requestId,
              operationId: request.operationId,
              fence: { ...identity.fence, environmentId: run.environmentId, storageAuthorityId },
            };
            if (request.type === "host.workspace.project.provision") {
              const path = await authority.provisionProject(request.binding, request.operationId);
              return { ...echo, type: "runner.workspace.local.provisioned", path };
            }
            if (request.type === "host.workspace.local.destroy") {
              const receipt = await authority.destroy(request.binding);
              return {
                ...echo,
                type: "runner.workspace.local.destroyed",
                receipt: { destroyedAt: receipt.destroyedAt, outcome: receipt.outcome },
              };
            }
            throw new Error(`Unexpected storage request ${request.type}`);
          },
        },
      });
      await mutateAccess(f.database, {
        actor: { userId },
        expectedRevision: 1,
        commandIdentity: createId("command"),
        changes: [
          {
            kind: "create-project",
            workspaceId: id,
            entryId: randomUUID(),
            name: "Support",
            color: "blue",
            backing: binding,
          },
        ],
      });
      expect(await f.store.findMainWorkspaceForOwner(userId)).toBeUndefined();
      expect(
        await f.database
          .selectFrom("principals")
          .select("id")
          .where("workspaceId", "=", id)
          .execute(),
      ).toHaveLength(1);
      expect(
        await f.database
          .selectFrom("workspaceMemberships")
          .select("role")
          .where("workspaceId", "=", id)
          .executeTakeFirst(),
      ).toMatchObject({ role: "owner" });
      const service = new WorkspaceService({
        store: new OpensteerStore(f.database),
        drivers: { local: driver },
        shape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
        resolveOwnerEnvironmentId: async () => {
          throw new Error("A team Project cannot resolve a person's computer");
        },
      });
      const workspace = await f.store.getWorkspace(id);
      if (!workspace) throw new Error("Project intent was not persisted");
      expect(workspace.status).toBe("provisioning");
      expect(workspace.homeThreadId).toBeNull();
      expect((await service.provision(workspace)).status).toBe("unavailable");
      online = true;
      const recovered = await service.provision(workspace);
      expect(recovered.storageIssue).toBeNull();
      expect(recovered.status).toBe("ready");
      expect((await f.store.getWorkspace(id))?.homeThreadId).toBeNull();
      expect((await authority.inventory()).bindings[0]?.path).toBe(
        join(`${root}/files-team`, "projects", id),
      );
      expect((await service.provision(workspace)).status).toBe("ready");
      expect(await f.store.findMainWorkspaceForOwner(userId)).toBeUndefined();
      await expect(
        f.store.requestWorkspaceDeletion({
          requestedBy: userId,
          workspaceId: id,
          purgeAfter: new Date(Date.now() + 60000),
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await mutateAccess(f.database, {
        actor: { userId },
        expectedRevision: 2,
        commandIdentity: createId("command"),
        changes: [
          { kind: "delete-project", workspaceId: id, purgeAfter: new Date(Date.now() + 60000) },
        ],
      });
      await driver.destroy({ workspace: { ...workspace, backing: binding } });
      expect((await f.store.markWorkspaceDeleted({ workspaceId: id })).status).toBe("deleted");
      expect(
        await f.database
          .selectFrom("principals")
          .select("id")
          .where("workspaceId", "=", id)
          .execute(),
      ).toHaveLength(1);
      expect((await authority.inventory()).bindings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
