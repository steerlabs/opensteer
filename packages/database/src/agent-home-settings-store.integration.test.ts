import { createId } from "@opensteer/core";
import { RunnerSettingsReportSchema, TaskRuntimeFenceSchema } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";
import { readAgentHomeSettings, reportAgentHomeSettings } from "./agent-home-settings-store.js";

it("fences settings.json reports to the hosting Runner and keeps the last valid settings", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const personal = await seedPersonalFixture(database, "/tmp/settings-home");
    expect(await readAgentHomeSettings(database, personal.userId)).toEqual({
      settings: {},
      file: { status: "missing" },
    });
    const fence = TaskRuntimeFenceSchema.parse({
      runnerId: personal.runnerId,
      environmentId: personal.environmentId,
      bindingGeneration: 1,
      connectionGeneration: 1,
      bootId: `rbt_${randomUUID()}`,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
    });
    const settings = { backgroundModels: { naming: [{ engine: "codex" }] } };
    const report = RunnerSettingsReportSchema.parse({
      ...fence,
      type: "runner.settings.report",
      readSequence: 1,
      readAt: new Date().toISOString(),
      result: { status: "valid", settings },
    });
    expect(await reportAgentHomeSettings(database, fence, report)).toBe(true);
    expect(await reportAgentHomeSettings(database, fence, report)).toBe(false);
    expect(await readAgentHomeSettings(database, personal.userId)).toEqual({
      settings,
      file: { status: "valid" },
    });
    const otherRunner = { ...fence, runnerId: createId("runner") };
    expect(
      await reportAgentHomeSettings(database, otherRunner, {
        ...report,
        ...otherRunner,
        readSequence: 2,
        result: { status: "missing" },
      }),
    ).toBe(false);
    expect(
      await reportAgentHomeSettings(
        database,
        { ...fence, bootId: TaskRuntimeFenceSchema.shape.bootId.parse(`rbt_${randomUUID()}`) },
        { ...report, readSequence: 2, result: { status: "missing" } },
      ),
    ).toBe(false);
    const error = {
      path: "/tmp/settings-home/settings.json",
      at: "backgroundModels.light.0.engine",
      message: "Unknown engine",
    };
    expect(
      await reportAgentHomeSettings(database, fence, {
        ...report,
        readSequence: 2,
        result: { status: "invalid", error },
      }),
    ).toBe(true);
    expect(await readAgentHomeSettings(database, personal.userId)).toEqual({
      settings,
      file: { status: "invalid", error },
    });
    expect(
      await reportAgentHomeSettings(database, fence, {
        ...report,
        readSequence: 3,
        result: { status: "missing" },
      }),
    ).toBe(true);
    expect(await readAgentHomeSettings(database, personal.userId)).toEqual({
      settings: {},
      file: { status: "missing" },
    });
    await database
      .updateTable("runners")
      .set({ connectionGeneration: 2 })
      .where("id", "=", personal.runnerId)
      .execute();
    expect(await reportAgentHomeSettings(database, fence, { ...report, readSequence: 4 })).toBe(
      false,
    );
    expect((await readAgentHomeSettings(database, createId("user"))).file.status).toBe("missing");
  } finally {
    await database.destroy();
    await clone.drop();
  }
});
