import { createId } from "@opensteer/core";
import { RunnerConnectionFenceSchema, RunnerSettingsReportSchema } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";
import { readAgentHomeSettings, reportAgentHomeSettings } from "./agent-home-settings-store.js";

it("fences settings.json reports to the hosting Runner, keeps the last valid settings and names the owner only on a change", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const personal = await seedPersonalFixture(database, "/tmp/settings-home");
    expect(await readAgentHomeSettings(database, personal.userId)).toEqual({
      settings: {},
      file: { status: "missing" },
    });
    const fence = {
      ...RunnerConnectionFenceSchema.parse({
        runnerId: personal.runnerId,
        connectionGeneration: 1,
        bootId: `rbt_${randomUUID()}`,
        connectionId: `rcn_${randomUUID()}`,
        connectionLeaseId: `rls_${randomUUID()}`,
      }),
      environmentId: personal.environmentId,
    };
    const settings = { backgroundModels: { naming: [{ engine: "codex" }] } };
    const report = RunnerSettingsReportSchema.parse({
      ...fence,
      type: "runner.settings.report",
      readSequence: 1,
      readAt: new Date().toISOString(),
      result: { status: "valid", settings },
    });
    expect(await reportAgentHomeSettings(database, fence, report)).toBe(personal.userId);
    expect(await reportAgentHomeSettings(database, fence, report)).toBeNull();
    expect(
      await reportAgentHomeSettings(database, fence, { ...report, readSequence: 2 }),
    ).toBeNull();
    expect(await readAgentHomeSettings(database, personal.userId)).toEqual({
      settings,
      file: { status: "valid" },
    });
    const otherRunner = { ...fence, runnerId: createId("runner") };
    expect(
      await reportAgentHomeSettings(database, otherRunner, {
        ...report,
        ...otherRunner,
        readSequence: 3,
        result: { status: "missing" },
      }),
    ).toBeNull();
    expect(
      await reportAgentHomeSettings(
        database,
        { ...fence, bootId: RunnerConnectionFenceSchema.shape.bootId.parse(`rbt_${randomUUID()}`) },
        { ...report, readSequence: 3, result: { status: "missing" } },
      ),
    ).toBeNull();
    const error = {
      path: "/tmp/settings-home/settings.json",
      at: "backgroundModels.light.0.engine",
      message: "Unknown engine",
    };
    expect(
      await reportAgentHomeSettings(database, fence, {
        ...report,
        readSequence: 3,
        result: { status: "invalid", error },
      }),
    ).toBe(personal.userId);
    expect(
      await reportAgentHomeSettings(database, fence, {
        ...report,
        readSequence: 4,
        result: { status: "invalid", error },
      }),
    ).toBeNull();
    expect(await readAgentHomeSettings(database, personal.userId)).toEqual({
      settings,
      file: { status: "invalid", error },
    });
    expect(
      await reportAgentHomeSettings(database, fence, {
        ...report,
        readSequence: 5,
        result: { status: "missing" },
      }),
    ).toBe(personal.userId);
    expect(await readAgentHomeSettings(database, personal.userId)).toEqual({
      settings: {},
      file: { status: "missing" },
    });
    await database
      .updateTable("runners")
      .set({ connectionGeneration: 2 })
      .where("id", "=", personal.runnerId)
      .execute();
    expect(
      await reportAgentHomeSettings(database, fence, { ...report, readSequence: 6 }),
    ).toBeNull();
    expect((await readAgentHomeSettings(database, createId("user"))).file.status).toBe("missing");
  } finally {
    await database.destroy();
    await clone.drop();
  }
});
