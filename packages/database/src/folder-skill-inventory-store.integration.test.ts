import { createId } from "@opensteer/core";
import { RunnerSkillMetadataReportSchema, TaskRuntimeFenceSchema } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";
import { listPersonalSkillInventory, reportFolderSkills } from "./folder-skill-inventory-store.js";

it("fences folder metadata to the current hosting computer and retains the last successful scan", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const personal = await seedPersonalFixture(database, "/tmp/skills-home");
    await database
      .updateTable("runners")
      .set({ lastSeenAt: new Date() })
      .where("id", "=", personal.runnerId)
      .execute();
    const fence = TaskRuntimeFenceSchema.parse({
      runnerId: personal.runnerId,
      environmentId: personal.environmentId,
      bindingGeneration: 1,
      connectionGeneration: 1,
      bootId: `rbt_${randomUUID()}`,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
    });
    const report = RunnerSkillMetadataReportSchema.parse({
      ...fence,
      type: "runner.skills.report",
      binding: personal.agentHome,
      scanSequence: 1,
      scannedAt: new Date().toISOString(),
      result: {
        status: "complete",
        warnings: [],
        skills: [{ fullName: "release", description: "Release", digest: "a".repeat(64) }],
      },
    });
    expect(await reportFolderSkills(database, fence, report)).toBe(true);
    expect(await reportFolderSkills(database, fence, report)).toBe(false);
    expect((await listPersonalSkillInventory(database, personal.userId))[0]).toMatchObject({
      folder: personal.agentHome,
      stale: false,
      scanStatus: "complete",
      skills: [{ fullName: "release" }],
    });
    await expect(listPersonalSkillInventory(database, createId("user"))).rejects.toThrow();
    expect(
      await reportFolderSkills(
        database,
        {
          ...fence,
          bootId: TaskRuntimeFenceSchema.parse({ ...fence, bootId: `rbt_${randomUUID()}` }).bootId,
        },
        { ...report, scanSequence: 2 },
      ),
    ).toBe(false);
    expect(
      await reportFolderSkills(database, fence, {
        ...report,
        binding: { ...report.binding, computerId: createId("runner") },
        scanSequence: 2,
      }),
    ).toBe(false);
    expect(
      await reportFolderSkills(database, fence, {
        ...report,
        scanSequence: 2,
        result: { status: "failed", reason: "unreadable" },
      }),
    ).toBe(true);
    expect((await listPersonalSkillInventory(database, personal.userId))[0]).toMatchObject({
      stale: true,
      scanStatus: "failed",
      skills: [{ fullName: "release" }],
    });
    await database
      .updateTable("runners")
      .set({ connectionGeneration: 2 })
      .where("id", "=", personal.runnerId)
      .execute();
    expect(await reportFolderSkills(database, fence, { ...report, scanSequence: 3 })).toBe(false);
    expect((await listPersonalSkillInventory(database, personal.userId))[0]?.stale).toBe(true);
  } finally {
    await database.destroy();
    await clone.drop();
  }
});
