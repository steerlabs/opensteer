import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, HarnessIdSchema, ModelSelectionSchema } from "@opensteer/core";
import { createDatabase } from "@opensteer/database/connection";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { expect, it } from "vitest";
import { FolderAdmissionService } from "./folder-admission-service.js";

it("admits only hosting-computer folders, defaults to agent home and never substitutes a missing task folder", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "opensteer-folder-admission-")));
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const personal = await seedPersonalFixture(database, directory);
    const chosen = join(directory, "chosen");
    await mkdir(chosen);
    await symlink(chosen, join(directory, "alias"));
    const folders = new FolderAdmissionService({
      hostingComputerId: personal.runnerId,
      ownerId: personal.userId,
      environmentId: personal.environmentId,
      agentHome: personal.agentHome,
      assertOwner: async (ownerId) => {
        const row = await database
          .selectFrom("personalSettings")
          .select("ownerId")
          .where("ownerId", "=", ownerId)
          .executeTakeFirstOrThrow();
        expect(row.ownerId).toBe(personal.userId);
      },
    });
    expect(await folders.resolve(personal.userId)).toEqual({
      folder: personal.agentHome,
      environmentId: personal.environmentId,
    });
    const remote = createId("runner");
    expect(folders.can(remote)).toEqual({ executeTasks: false });
    await expect(folders.admit({ computerId: remote, path: chosen })).rejects.toThrow(
      "hosting computer",
    );
    const admitted = await folders.admit({
      computerId: personal.runnerId,
      path: join(directory, "alias"),
    });
    expect(admitted).toEqual({ computerId: personal.runnerId, path: chosen });
    const threadId = createId("thread"),
      harnessInstanceId = createId("harnessInstance");
    const { id: principalId } = await database
      .selectFrom("principals")
      .select("id")
      .where("userId", "=", personal.userId)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("harnessInstances")
      .values({
        id: harnessInstanceId,
        environmentId: personal.environmentId,
        driverKind: HarnessIdSchema.parse("native"),
        name: "Fixture",
        config: {},
        runtimeRevision: 1,
        stateKind: "ambient",
        enabled: true,
        isDefault: true,
        sourceId: "native",
        removedAt: null,
      })
      .execute();
    await database
      .insertInto("threads")
      .values({
        id: threadId,
        lineageRootThreadId: threadId,
        parentThreadId: null,
        purpose: "task",
        folderComputerId: admitted.computerId,
        folderPath: admitted.path,
        teamId: null,
        channelId: null,
        threadRootId: null,
        listed: true,
        title: "Chosen folder",
        icon: null,
        iconSource: "chosen",
        color: "blue",
        environmentId: personal.environmentId,
        harnessInstanceId,
        modelSelection: ModelSelectionSchema.parse({
          providerId: "openai",
          modelId: "fixture",
          options: {},
        }),
        status: "idle",
        createdBy: personal.userId,
        createdByPrincipalId: principalId,
      })
      .execute();
    await expect(
      database
        .updateTable("threads")
        .set({ folderPath: directory })
        .where("id", "=", threadId)
        .execute(),
    ).rejects.toThrow("never change");
    await rm(chosen, { recursive: true });
    await expect(folders.assertAvailable(admitted)).rejects.toThrow("missing or unavailable");
    expect(
      await database
        .selectFrom("threads")
        .select("folderPath")
        .where("id", "=", threadId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ folderPath: chosen });
  } finally {
    await database.destroy();
    await clone.drop();
    await rm(directory, { recursive: true, force: true });
  }
});
