import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { createPersonalRunFixturePort } from "@opensteer/database/test-support/personal-run";
import { expect, it } from "vitest";
import {
  startPrivateMachineHost,
  type PrivateMachineHost,
} from "../runtime/private-machine-host.test-support.js";

it("counts a computer's placed tasks in each machines.list read and keeps the count off the machine resource", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    const list = async () => {
      const result = await host!.api["machines.list"]({});
      if (!result.ok) throw new Error(result.error.message);
      return result.data.machines;
    };
    const placed = async () => (await list()).reduce((sum, m) => sum + m.pinnedThreads, 0);
    const revision = () =>
      host!.store.database
        .selectFrom("clientSyncState")
        .select("resourceRevisions")
        .executeTakeFirstOrThrow()
        .then(({ resourceRevisions }) => resourceRevisions.machine);
    const before = await placed();
    const machineRevision = await revision();
    await createPersonalRunFixturePort(host.store).createTask({
      ownerId: host.ownerId,
      suffix: "placed-count",
    });
    // No machine announcement, and the next read counts the new task anyway.
    expect(await revision()).toBe(machineRevision);
    expect(await placed()).toBe(before + 1);
    const detail = await host.api["resources.detail.get"]({ kind: "machine" });
    if (!detail.ok) throw new Error(detail.error.message);
    const { data } = detail.data;
    if (data.kind !== "machine") throw new Error("Expected the machine detail");
    expect(data.machines.length).toBeGreaterThan(0);
    for (const machine of data.machines) expect(machine).not.toHaveProperty("pinnedThreads");
  } finally {
    await host?.close();
    await database.drop();
  }
});
