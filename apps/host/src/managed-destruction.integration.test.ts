import { createId } from "@opensteer/core";
import { createDatabase, migrateToLatest, OpensteerStore } from "@opensteer/database";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { destroyPersistedManagedDeploymentData } from "./managed-destruction.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("managed deployment data destruction persistence", () => {
  const database = createDatabase({
    applicationName: "opensteer-managed-destruction-integration-test",
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 1,
  });
  const store = new OpensteerStore(database);

  beforeAll(async () => {
    await migrateToLatest(database);
    await sql`truncate table deployments, users restart identity cascade`.execute(database);
  });

  afterAll(async () => database.destroy());

  it("reads every persisted workspace and leaves its row intact after volume destruction", async () => {
    const deploymentId = createId("deployment");
    await store.ensureDeployment({
      canonicalOrigin: "https://managed-destruction.opensteer.test",
      deploymentId,
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      hostInstanceId: createId("hostInstance"),
    });
    const userId = await store.createUser("Managed owner");
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "managed",
        volumeId: `pending_${createId("workspace")}`,
      },
      capacityPolicy: { blockHardLimitBytes: 1024, inodeHardLimit: 10, kind: "hard-quota" },
      createdBy: userId,
      idempotencyKey: "managed-destruction-integration",
      name: "Managed workspace",
      status: "provisioning",
    });
    const destroy = vi.fn(async () => undefined);

    await expect(
      destroyPersistedManagedDeploymentData({
        driver: { destroy },
        expectedDeploymentId: deploymentId,
        store,
      }),
    ).resolves.toEqual({ destroyedPortableFsWorkspaces: 1, outstandingLocalWorkspaces: [] });
    expect(destroy).toHaveBeenCalledWith({ workspace });
    await expect(store.listWorkspaces()).resolves.toEqual([workspace]);
  });
});
