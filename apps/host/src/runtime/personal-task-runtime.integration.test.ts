import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPassService } from "../agents/memory-pass-service.js";
import { TimeZoneSchema } from "@opensteer/core";
import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { startPersonalRuntime } from "./personal-startup.test-support.js";

it("executes a private task through the real Host and Runner with a fake Codex engine", async () => {
  const database = await cloneTestDatabase("host");
  const home = await mkdtemp(join(tmpdir(), "personal-fake-engine-home-"));
  let runtime: Awaited<ReturnType<typeof startPersonalRuntime>> | undefined;
  try {
    const owned = await ownTestDatabaseProducer(database.url, async () => {
      const runtime = await startPersonalRuntime({
        databaseUrl: database.url,
        engineArguments: ["--scenario=reasoning"],
        agentHome: { computerId: createId("runner"), path: home },
      });
      return { runtime, close: () => runtime.close() };
    });
    runtime = owned.runtime;
    const catalog = await runtime.host.store.getHarnessCatalog(
      runtime.environmentId,
      runtime.harnessInstanceId,
    );
    const model = catalog?.models[0];
    if (!model)
      throw new Error(
        `Fake engine published no model: ${catalog?.status} ${catalog?.detail ?? ""}`,
      );
    const created = await runtime.api["commands.dispatch"]({
      type: "thread.create",
      idempotencyKey: crypto.randomUUID(),
      environmentId: runtime.environmentId,
      harnessInstanceId: runtime.harnessInstanceId,
      modelSelection: { providerId: model.providerId, modelId: model.modelId, options: {} },
      title: "Personal cold start proof",
    });
    if (!created.ok) throw new Error(`Task admission failed: ${created.error.message}`);
    if (created.data.type !== "thread.create") throw new Error("Wrong task command receipt");
    const sent = await runtime.api["commands.dispatch"]({
      type: "thread.sendMessage",
      threadId: created.data.thread.id,
      idempotencyKey: crypto.randomUUID(),
      delivery: "queue",
      content: [{ type: "text", text: "Say Done." }],
    });
    if (!sent.ok || sent.data.type !== "thread.sendMessage")
      throw new Error("Task input was not admitted");
    const turn = await runtime.waitForInput(sent.data.message.id, AbortSignal.timeout(15000));
    expect(
      turn.events.some((event) => event.type === "run.completed"),
      JSON.stringify(turn.events),
    ).toBe(true);
    expect(turn.assistantText).toContain("Done.");
    const settings = await runtime.host.store.database
      .selectFrom("personalSettings")
      .select("ownerId")
      .executeTakeFirstOrThrow();
    await runtime.host.store.notificationState.setTimeZone({
      userId: settings.ownerId,
      timeZone: TimeZoneSchema.parse("America/New_York"),
    });
    const memory = new MemoryPassService({
      store: runtime.host.store,
      runners: {
        isAvailable: () => false,
        canRunHarness: () => false,
        harnessAccessModes: () => undefined,
      },
      readAgentInstructions: async () => null,
      onEvent: () => {},
      onChanged: () => {},
    });
    await memory.ensureForPersonal();
    expect(
      (
        await runtime.host.store.database
          .selectFrom("triggers")
          .select("systemRole")
          .where("systemRole", "is not", null)
          .execute()
      )
        .map((row) => row.systemRole)
        .sort(),
    ).toEqual(["memory-light", "memory-nightly"]);
  } finally {
    await runtime?.close();
    await database.drop();
    await rm(home, { recursive: true, force: true });
  }
});
