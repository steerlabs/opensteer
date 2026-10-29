import { createId, type Workspace } from "@opensteer/core";
import { createDatabase, migrateToLatest, OpensteerStore } from "@opensteer/database";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFilesService } from "./workspace-files-service.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Workspace Files membership generation", () => {
  const database = createDatabase({
    applicationName: "opensteer-files-membership-integration-test",
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 2,
  });
  const store = new OpensteerStore(database);

  beforeAll(async () => migrateToLatest(database));

  beforeEach(async () => {
    await sql`truncate table deployments, users restart identity cascade`.execute(database);
  });

  afterAll(async () => database.destroy());

  it.each(["local-directory", "portablefs"] as const)(
    "stops an in-flight %s download when the admitted member is revoked",
    async (backingKind) => {
      await store.ensureDeployment({
        canonicalOrigin: "https://files-membership.opensteer.test",
        hostInstanceId: createId("hostInstance"),
        deploymentShape: {
          defaultWorkspaceBacking: backingKind,
          kind: "server" as const,
        },
      });
      const ownerId = await store.createUser("Owner");
      const collaboratorId = await store.createUser("Collaborator");
      // A local directory belongs to a real machine: the Workspace row's owning
      // environment is a foreign key, not a label.
      const ownerEnvironmentId = await store.createEnvironment({
        kind: "local",
        name: "Files membership laptop",
      });
      const workspace = await store.createWorkspace({
        backing:
          backingKind === "local-directory"
            ? {
                bindingId: createId("workspaceBinding"),
                generation: 1,
                kind: "local-directory",
                ownerEnvironmentId,
                storageAuthorityId: createId("storageAuthority"),
              }
            : {
                generation: 1,
                kind: "portablefs",
                serviceId: "files-membership-test",
                volumeId: `volume_${createId("workspace")}`,
              },
        capacityPolicy:
          backingKind === "local-directory"
            ? { kind: "host-filesystem" }
            : {
                blockHardLimitBytes: 10_000_000,
                inodeHardLimit: 10_000,
                kind: "hard-quota",
              },
        createdBy: ownerId,
        idempotencyKey: `files-membership-${backingKind}`,
        kind: "specialized",
        name: "Shared files",
        status: "ready",
      });
      const invitation = await store.createWorkspaceInvitation({
        createdBy: ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: `files-membership-invite-${backingKind}`,
        intendedEmail: null,
        requestFingerprint: `sha256:files-membership-${backingKind}`,
        role: "collaborator",
        selector: `files-membership-${backingKind}-selector`,
        tokenHash: `sha256:files-membership-${backingKind}-verifier`,
        type: "link",
        workspaceId: workspace.id,
      });
      await store.acceptWorkspaceInvitation({
        selector: invitation.selector,
        tokenHash: `sha256:files-membership-${backingKind}-verifier`,
        userEmail: `${collaboratorId}@test.invalid`,
        userEmailVerified: true,
        userId: collaboratorId,
      });
      const admission = await store.admitWorkspaceFiles(workspace.id, collaboratorId);
      expect(admission).toMatchObject({ membershipGeneration: 1, userId: collaboratorId });

      let upstreamCancelled = false;
      const download = vi.fn(
        async (_workspace: Workspace, _fileKey: string, signal: AbortSignal) => {
          expect(signal.aborted).toBe(false);
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                upstreamCancelled = true;
              },
              start(controller) {
                controller.enqueue(new Uint8Array(2 * 64 * 1_024));
              },
            }),
            { headers: { "content-length": String(2 * 64 * 1_024) } },
          );
        },
      );
      const files = new WorkspaceFilesService({
        ...(backingKind === "local-directory"
          ? { local: { download } as never }
          : { portableFs: { download } as never }),
        memberships: store,
      });
      try {
        const response = await files.download(admission!, "file_key");
        const reader = response.body!.getReader();
        await expect(reader.read()).resolves.toMatchObject({
          done: false,
          value: expect.objectContaining({ byteLength: 64 * 1_024 }),
        });

        const revoked = await store.changeWorkspaceMembership({
          actorId: ownerId,
          state: "revoked",
          targetUserId: collaboratorId,
          workspaceId: workspace.id,
        });
        expect(revoked.membership).toMatchObject({ generation: 2, state: "revoked" });
        await expect(reader.read()).rejects.toMatchObject({ code: "not_found" });
        expect(upstreamCancelled).toBe(true);
        await expect(store.admitWorkspaceFiles(workspace.id, collaboratorId)).resolves.toBeNull();
      } finally {
        files.close();
      }
    },
  );
});
