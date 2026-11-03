import { createTestWorkspace } from "../packages/database/src/workspace-fixture.test-support.js";
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createId, type Workspace } from "../packages/core/src/index.js";
import { LocalWorkspaceAuthority } from "../packages/workspace-local/src/index.js";
import { localWorkspaceBindingId } from "../packages/workspace/src/local-binding.js";
import {
  WorkspaceAuthorityUnreachableError,
  type WorkspaceBackingLifecycleDriver,
} from "../packages/workspace/src/index.js";
import { workspaceLocalOperationId } from "../packages/protocol/src/index.js";
import { expect } from "vitest";
import {
  describeStore,
  enrollTestRunner,
} from "../packages/database/src/store.integration.test-support.js";
import { WorkspaceService } from "../apps/host/src/workspace/workspace-service.js";

describeStore("Project creation on Main storage", (it) => {
  for (const namespace of ["single-owner", "owner-scoped"] as const) {
    it(`nests Projects on Main's authority in ${namespace} storage and refuses offline creation`, async ({
      storeFixture,
    }) => {
      const { store } = storeFixture;
      const owner = await store.createUser("Project owner");
      const environmentId = createId("environment");
      await enrollTestRunner(store, {
        createdBy: owner,
        environmentId,
        name: "Main computer",
        runnerId: createId("runner"),
        tokenSuffix: namespace,
      });
      const root = await mkdtemp(path.join(os.tmpdir(), "opensteer-project-create-"));
      try {
        const authority = new LocalWorkspaceAuthority({
          namespace:
            namespace === "single-owner"
              ? { kind: namespace, ownerEnvironmentId: environmentId }
              : { kind: namespace },
          registryFilePath: path.join(root, "private", "registry.json"),
          visibleRootPath: path.join(root, "workspaces"),
        });
        const storageAuthorityId = await authority.storageAuthorityId();
        let connected = true;
        const binding = (workspace: Workspace) => {
          if (
            workspace.backing.kind !== "local-directory" ||
            workspace.backing.storageAuthorityId === null
          )
            throw new Error("Expected local storage");
          return {
            ...workspace.backing,
            storageAuthorityId: workspace.backing.storageAuthorityId,
            workspaceId: workspace.id,
          };
        };
        const driver: WorkspaceBackingLifecycleDriver<"local-directory"> = {
          kind: "local-directory",
          relocate: async (workspace, adopt = false) =>
            authority.relocate(binding(workspace), workspace.slug!, adopt, workspace.createdBy),
          initialBacking: (input) => ({
            kind: "local-directory",
            generation: 1,
            storageAuthorityId,
            ownerEnvironmentId: input.ownerEnvironmentId,
            bindingId: localWorkspaceBindingId({
              ...input,
              ownerEnvironmentId: input.ownerEnvironmentId,
              idempotencyKey: workspaceLocalOperationId({
                generation: 1,
                operation: "provision",
                workspaceId: input.workspaceId,
              }),
            }),
          }),
          provision: async ({ workspace }) => {
            await authority.provision({
              binding: binding(workspace),
              fingerprint: {
                createdBy: workspace.createdBy,
                workspaceKind: workspace.kind,
                ...(workspace.slug ? { slug: workspace.slug } : {}),
              },
              idempotencyKey: workspaceLocalOperationId({
                generation: workspace.backing.generation,
                operation: "provision",
                workspaceId: workspace.id,
              }),
            });
            return { backing: workspace.backing, status: "ready" };
          },
          inspect: async (workspace) => {
            if (!connected) throw new WorkspaceAuthorityUnreachableError("Computer offline");
            expect(await authority.inspect(binding(workspace))).toEqual({ status: "ready" });
            return { status: "ready", issue: null };
          },
          destroy: async () => undefined,
          preflight: async () => ({ available: true, detail: "Local disk" }),
          issueFromError: () => ({
            code: "local-authority-unavailable",
            message: "Computer offline",
            occurredAt: new Date().toISOString(),
            retryable: true,
          }),
        };
        const service = new WorkspaceService({
          store,
          drivers: { local: driver },
          shape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
          resolveOwnerEnvironmentId: async () => environmentId,
        });
        const main = await service.ensureMainWorkspace(owner);
        // The placement resolver may change; Projects must still follow the durable Main binding.
        const projects = new WorkspaceService({
          store,
          drivers: { local: driver },
          shape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
          resolveOwnerEnvironmentId: async () => createId("environment"),
        });
        const first = await projects.create({
          createdBy: owner,
          idempotencyKey: "first",
          name: "Research",
        });
        const second = await projects.create({
          createdBy: owner,
          idempotencyKey: "second",
          name: "RESEARCH",
        });
        const mainPath = (await authority.resolveReadAuthority(binding(main))).root;
        expect(first.slug).toBe("research");
        expect(second.slug).toBe("research-2");
        for (const project of [first, second]) {
          expect(project.backing).toMatchObject({
            ownerEnvironmentId: environmentId,
            storageAuthorityId,
          });
          expect((await authority.resolveReadAuthority(binding(project))).root).toBe(
            path.join(mainPath, "Projects", project.slug!),
          );
        }
        const legacyId = createId("workspace");
        const legacy = await createTestWorkspace(store, {
          id: legacyId,
          name: "Converted",
          kind: "project",
          createdBy: owner,
          idempotencyKey: "legacy",
          status: "ready",

          backing: {
            kind: "local-directory",
            generation: 1,
            bindingId: createId("workspaceBinding"),
            ownerEnvironmentId: environmentId,
            storageAuthorityId: createId("storageAuthority"),
          },
        });
        await expect(projects.ensureExecutionReady(legacy)).rejects.toThrow(/Move this Project/);
        expect((await store.getWorkspace(legacy.id))?.storageIssue?.code).toBe(
          "relocation-required",
        );
        await expect(projects.adoptRelocated(legacy.id, createId("user"))).rejects.toThrow(
          /not found/,
        );
        await expect(projects.adoptRelocated(legacy.id, owner)).rejects.toThrow();
        const target = path.join(mainPath, "Projects", legacy.slug!);
        const source = path.join(root, "moved-source");
        await mkdir(source);
        await writeFile(path.join(source, "keep.txt"), "saved");
        await symlink(source, target);
        await expect(projects.adoptRelocated(legacy.id, owner)).rejects.toThrow();
        await rm(target);
        await mkdir(target);
        await writeFile(
          path.join(target, "keep.txt"),
          await readFile(path.join(source, "keep.txt")),
        );
        const adopted = await projects.adoptRelocated(legacy.id, owner);
        expect(adopted).toMatchObject({
          status: "ready",
          storageIssue: null,
          backing: {
            kind: "local-directory",
            bindingId: binding(legacy).bindingId,
            storageAuthorityId,
          },
        });
        expect((await authority.resolveReadAuthority(binding(adopted))).root).toBe(target);
        expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("saved");
        connected = false;
        await expect(
          projects.create({ createdBy: owner, idempotencyKey: "offline", name: "Offline" }),
        ).rejects.toThrow(/Connect the computer holding Main/);
        expect(
          (await store.listWorkspaces()).filter((workspace) => workspace.name === "Offline"),
        ).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
