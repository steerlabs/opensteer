import { expect } from "vitest";
import { sql } from "kysely";
import { checkAccess, mutateAccess } from "./access-store.js";
import { ensureDeployment } from "./deployment-store.js";
import { createId } from "@opensteer/core";
import { describeStore } from "./store.integration.test-support.js";

describeStore("stored Project authority boundary", (it) => {
  it("fences Project self-use by the stored model and live Project without changing human authority", async ({
    storeFixture,
  }) => {
    const run = await storeFixture.createRunFixture("authority", null, "project");
    const input = {
      principal: { kind: "project" as const, workspaceId: run.workspace.id },
      callerKind: "agent" as const,
      target: { kind: "project" as const, workspaceId: run.workspace.id },
      action: "use" as const,
    };
    expect(await checkAccess(storeFixture.database, input)).toEqual({ allowed: false });
    await expect(
      mutateAccess(storeFixture.database, {
        actor: { userId: run.userId },
        expectedRevision: 1,
        commandIdentity: createId("command"),
        changes: [{ kind: "create-group", id: "forbidden", name: "Forbidden" }],
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await storeFixture.database
      .updateTable("deployments")
      .set({ authorityModelVersion: 2 })
      .execute();
    expect(await checkAccess(storeFixture.database, input)).toEqual({ allowed: true });
    expect(
      await checkAccess(storeFixture.database, {
        ...input,
        target: { kind: "project", workspaceId: createId("workspace") },
      }),
    ).toEqual({ allowed: false });
    await storeFixture.database
      .updateTable("workspaces")
      .set({
        status: "deleting",
        deletionRequestedAt: new Date(),
        deletionRequestedBy: run.userId,
        purgeAfter: new Date("2099-01-01"),
      })
      .where("id", "=", run.workspace.id)
      .execute();
    expect(await checkAccess(storeFixture.database, input)).toEqual({ allowed: false });
  });

  it("refuses model 2 at the fenced cold startup read, including inconsistent Personal data", async ({
    storeFixture,
  }) => {
    await storeFixture.createRunFixture("startup", null, "project");
    const row = await storeFixture.database
      .selectFrom("deployments")
      .selectAll()
      .executeTakeFirstOrThrow();
    const input = {
      canonicalOrigin: row.canonicalOrigin,
      hostInstanceId: row.activeHostInstanceId,
      deploymentShape: row.deploymentShape,
    };
    expect((await ensureDeployment(storeFixture.database, input)).id).toBe(row.id);
    await storeFixture.database
      .updateTable("deployments")
      .set({ authorityModelVersion: 2 })
      .execute();
    await expect(ensureDeployment(storeFixture.database, input)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/unsupported.*authority|authority.*unsupported/i),
    });
    await storeFixture.database
      .updateTable("deployments")
      .set({
        deploymentShape: sql`'{"kind":"personal","defaultWorkspaceBacking":"local-directory"}'::jsonb`,
      })
      .execute();
    await expect(
      ensureDeployment(storeFixture.database, {
        ...input,
        deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/unsupported.*authority|authority.*unsupported/i),
    });
  });
});
