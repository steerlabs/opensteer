import { createId } from "@opensteer/core";
import { RunnerSkillMetadataReportSchema, TaskRuntimeFenceSchema } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";
import {
  agentHomeSkillInventory,
  reportAgentHomeSkills,
} from "./agent-home-skill-inventory-store.js";

it("fences Agent home skills to the current hosting Runner and retains the last successful scan", async () => {
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
      scanSequence: 1,
      scannedAt: new Date().toISOString(),
      result: {
        status: "complete",
        warnings: [],
        skills: [{ fullName: "release", description: "Release", digest: "a".repeat(64) }],
      },
    });
    expect(await reportAgentHomeSkills(database, fence, report)).toBe(true);
    expect(await reportAgentHomeSkills(database, fence, report)).toBe(false);
    expect(await agentHomeSkillInventory(database, personal.userId)).toMatchObject({
      stale: false,
      scanStatus: "complete",
      skills: [{ fullName: "release" }],
    });
    await expect(agentHomeSkillInventory(database, createId("user"))).rejects.toThrow();
    expect(
      await reportAgentHomeSkills(
        database,
        {
          ...fence,
          bootId: TaskRuntimeFenceSchema.parse({ ...fence, bootId: `rbt_${randomUUID()}` }).bootId,
        },
        { ...report, scanSequence: 2 },
      ),
    ).toBe(false);
    const otherRunner = { ...fence, runnerId: createId("runner") };
    expect(
      await reportAgentHomeSkills(database, otherRunner, {
        ...report,
        ...otherRunner,
        scanSequence: 2,
      }),
    ).toBe(false);
    expect(
      await reportAgentHomeSkills(database, fence, {
        ...report,
        scanSequence: 2,
        result: { status: "failed", reason: "unreadable" },
      }),
    ).toBe(true);
    expect(await agentHomeSkillInventory(database, personal.userId)).toMatchObject({
      stale: true,
      scanStatus: "failed",
      skills: [{ fullName: "release" }],
    });
    await database
      .updateTable("runners")
      .set({ connectionGeneration: 2 })
      .where("id", "=", personal.runnerId)
      .execute();
    expect(await reportAgentHomeSkills(database, fence, { ...report, scanSequence: 3 })).toBe(
      false,
    );
    expect((await agentHomeSkillInventory(database, personal.userId))?.stale).toBe(true);
  } finally {
    await database.destroy();
    await clone.drop();
  }
});
