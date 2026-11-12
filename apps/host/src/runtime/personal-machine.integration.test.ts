import { expect, it } from "vitest";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { startPersonalMachineHost } from "./personal-machine.test-support.js";

it("issues only reachable-computer grants beside the hosting Personal Runner", async () => {
  const database = await cloneTestDatabase("host");
  let host: Awaited<ReturnType<typeof startPersonalMachineHost>> | undefined;
  try {
    const owned = await ownTestDatabaseProducer(database.url, async () => {
      const host = await startPersonalMachineHost({
        databaseUrl: database.url,
        remoteAccess: true,
      });
      return { host, close: () => host.close() };
    });
    host = owned.host;
    const requested = await host.api["commands.dispatch"]({
      type: "runner.enrollment.createLocal",
      allowedModules: ["shell"],
      idempotencyKey: "reachable",
      name: "Reachable computer",
    });
    expect(requested.ok, JSON.stringify(requested)).toBe(true);
    const enrollment = await host.store.database
      .selectFrom("runnerEnrollments")
      .select("allowedModules")
      .where("idempotencyKey", "=", "reachable")
      .executeTakeFirstOrThrow();
    expect(enrollment.allowedModules).toEqual(["browser", "integrations", "messaging", "shell"]);
    const execution = await host.api["commands.dispatch"]({
      type: "runner.enrollment.createLocal",
      allowedModules: ["agents"],
      idempotencyKey: "execution-denied",
      name: "Another execution computer",
    });
    expect(execution).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(
      await host.store.database
        .selectFrom("runners")
        .select("id")
        .where("id", "=", host.hostingComputerId)
        .executeTakeFirst(),
    ).toBeDefined();
  } finally {
    await host?.close();
    await database.drop();
  }
});
