import { expect } from "vitest";
import { checkAccess, mutateAccess } from "./access-store.js";
import { ensureDeployment } from "./deployment-store.js";
import { createId } from "@opensteer/core";
import { describeStore } from "./store.integration.test-support.js";
import { createProjectIdentityFixture } from "./project-work.test-support.js";

describeStore("stored Project authority boundary", (it) => {
  for (const model of [1, 2] as const) {
    it(`fences Project self-use by independently stored model ${model} and live Project`, async ({
      storeFixture,
    }) => {
      const fixture = await createProjectIdentityFixture(storeFixture, `authority-${model}`, model);
      const input = {
        principal: { kind: "project" as const, workspaceId: fixture.workspace.id },
        callerKind: "agent" as const,
        target: { kind: "project" as const, workspaceId: fixture.workspace.id },
        action: "use" as const,
      };
      expect(await checkAccess(storeFixture.database, input)).toEqual({ allowed: model === 2 });
      if (model === 1) {
        await expect(
          mutateAccess(storeFixture.database, {
            actor: { userId: fixture.userId },
            expectedRevision: 1,
            commandIdentity: createId("command"),
            changes: [{ kind: "create-group", id: "forbidden", name: "Forbidden" }],
          }),
        ).rejects.toMatchObject({ code: "forbidden" });
      }
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
          deletionRequestedBy: fixture.userId,
          purgeAfter: new Date("2099-01-01"),
        })
        .where("id", "=", fixture.workspace.id)
        .execute();
      expect(await checkAccess(storeFixture.database, input)).toEqual({ allowed: false });
    });
  }
  for (const kind of ["personal", "server"] as const) {
    it(`refuses cold ${kind} model 2 at startup without mutating stored authority`, async ({
      storeFixture,
    }) => {
      const input = {
        canonicalOrigin:
          kind === "personal" ? "http://127.0.0.1:4310" : "https://server.test.invalid",
        hostInstanceId: createId("hostInstance"),
        deploymentShape: { kind, defaultWorkspaceBacking: "local-directory" as const },
      };
      await storeFixture.database
        .insertInto("deployments")
        .values({
          id: createId("deployment"),
          singletonKey: "primary",
          activeHostInstanceId: input.hostInstanceId,
          authorityModelVersion: 2,
          deploymentShape: input.deploymentShape,
          canonicalOrigin: input.canonicalOrigin,
          lifecycle: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .execute();
      const before = await storeFixture.database.selectFrom("deployments").selectAll().execute();
      await expect(ensureDeployment(storeFixture.database, input)).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringMatching(/unsupported.*authority|authority.*unsupported/i),
      });
      expect(await storeFixture.database.selectFrom("deployments").selectAll().execute()).toEqual(
        before,
      );
    });
  }
});
