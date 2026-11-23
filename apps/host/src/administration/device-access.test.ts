import { createId, type DeviceId, type RunnerId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { DeviceAccessRefusal, requireRunnerDeviceAccess } from "./device-access.js";

function fakeDatabase(row: { id: DeviceId; accessPolicy: unknown; name: string } | undefined): {
  database: Kysely<DatabaseSchema>;
  executeTakeFirst: ReturnType<typeof vi.fn>;
} {
  const executeTakeFirst = vi.fn(async () => row);
  const query = {
    innerJoin: () => query,
    select: () => query,
    where: () => query,
    executeTakeFirst,
  };
  return {
    database: { selectFrom: () => query } as unknown as Kysely<DatabaseSchema>,
    executeTakeFirst,
  };
}

describe("requireRunnerDeviceAccess", () => {
  const runnerId = createId("runner") as RunnerId;
  const deviceId = createId("device") as DeviceId;

  it("checks the active self device and capability in one query", async () => {
    const { database, executeTakeFirst } = fakeDatabase({
      id: deviceId,
      accessPolicy: { browser: true, apps: true, files: true },
      name: "Work Mac",
    });

    await expect(
      requireRunnerDeviceAccess(database, runnerId, "browser", true),
    ).resolves.toBeUndefined();
    expect(executeTakeFirst).toHaveBeenCalledTimes(1);
  });

  it("throws not_found when the runner has no active self device", async () => {
    const { database } = fakeDatabase(undefined);
    await expect(
      requireRunnerDeviceAccess(database, runnerId, "browser", true),
    ).rejects.toMatchObject({ code: "not_found", message: "Active self Device not found" });
  });

  it("refuses stopped, asleep, offline, and disabled-capability devices with matching reasons", async () => {
    const { database: enabled } = fakeDatabase({
      id: deviceId,
      accessPolicy: { browser: true, apps: true, files: true },
      name: "Work Mac",
    });
    await expect(
      requireRunnerDeviceAccess(enabled, runnerId, "browser", true, { stopped: true }),
    ).rejects.toMatchObject({ reason: "device-stopped", machineId: deviceId });
    await expect(
      requireRunnerDeviceAccess(enabled, runnerId, "browser", false, { asleep: true }),
    ).rejects.toMatchObject({ reason: "device-asleep", machineId: deviceId });
    await expect(
      requireRunnerDeviceAccess(enabled, runnerId, "browser", false),
    ).rejects.toMatchObject({ reason: "device-offline", machineId: deviceId });

    const { database: browserOff } = fakeDatabase({
      id: deviceId,
      accessPolicy: { browser: false, apps: true, files: true },
      name: "Work Mac",
    });
    await expect(
      requireRunnerDeviceAccess(browserOff, runnerId, "browser", true),
    ).rejects.toBeInstanceOf(DeviceAccessRefusal);
    await expect(
      requireRunnerDeviceAccess(browserOff, runnerId, "browser", true),
    ).rejects.toMatchObject({ reason: "device-access-off", machineId: deviceId });
  });
});
