import { expect } from "vitest";
import { createId } from "@opensteer/core";
import { describeStore } from "./store.integration.test-support.js";
import { prepareProjectAdmission } from "./project-work.test-support.js";
import { deleteTeamProject, prepareTeamComputerReplacement } from "./team-project-store.js";

for (const operation of ["delete", "replace"] as const)
  describeStore(`team ${operation} without a cancellation adapter`, (it) => {
    it("refuses queued work without a Run before changing Project or computer state", async ({
      storeFixture,
    }) => {
      const { database, store, project, prepared, origin } =
        await prepareProjectAdmission(storeFixture);
      const admitted = await store.admitProjectWork({
        threadId: prepared.thread.id,
        origin,
        source: { kind: "human" },
        content: [{ type: "text", text: "Pending work" }],
        policy: "queue",
        idempotencyKey: "orphan-for-revocation",
      });
      if (!admitted.runId) throw new Error("The fixture did not admit a Run");
      await database
        .updateTable("threadInputs")
        .set({ runId: null })
        .where("messageId", "=", admitted.input.messageId)
        .execute();
      await database.deleteFrom("commands").where("runId", "=", admitted.runId).execute();
      await database.deleteFrom("runs").where("id", "=", admitted.runId).execute();
      const actor = { userId: project.userId, authorityGeneration: 1 };
      const action =
        operation === "delete"
          ? deleteTeamProject(database, actor, {
              workspaceId: project.workspace.id,
              commandId: createId("command"),
              expectedRevision: 1,
              retentionMilliseconds: 0,
            })
          : prepareTeamComputerReplacement(database, actor, {
              expectedComputerId: project.runnerId,
              commandId: createId("command"),
              expectedRevision: 1,
            });
      await expect(action).rejects.toMatchObject({
        code: "workspace_unavailable",
        reason: "team-not-implemented",
      });
      expect((await storeFixture.store.getWorkspace(project.workspace.id))?.status).toBe("ready");
      expect(
        await database
          .selectFrom("runners")
          .select("revokedAt")
          .where("id", "=", project.runnerId)
          .executeTakeFirst(),
      ).toEqual({ revokedAt: null });
    });
  });
