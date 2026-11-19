import { utf8ByteLength } from "@opensteer/core";
import { environmentInventoryEntryMaxBytes } from "@opensteer/protocol";
import { personalInventoryBound } from "@opensteer/protocol/resources";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { expect, it } from "vitest";
import type { HostServerDependencies } from "../server.js";
import {
  startPrivateMachineHost,
  type PrivateMachineHost,
} from "../runtime/private-machine-host.test-support.js";
import { PersonalResources } from "./personal-resources.js";

/** As many engines as a Runner may report, every field at its limit. */
const drivers = Array.from({ length: 100 }, (_, index) => ({
  driverKind: `engine-${index}-${"k".repeat(80)}`,
  installation: {
    detail: "i".repeat(2_000),
    latestVersion: "l".repeat(120),
    manualCommand: "c".repeat(500),
    scope: "all" as const,
    update: "available" as const,
    version: "v".repeat(120),
  },
  readiness: "unavailable" as const,
  reason: "r".repeat(500),
}));

it("lists the environment without its engines and serves them whole on their own", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    const resources = new PersonalResources(
      {
        store: host.store,
        resourceRevisions: { get: () => "1" },
        runners: {
          identityForEnvironment: () => ({
            capabilities: new Set<string>(),
            modules: { agents: { harnessDrivers: drivers, providerStateModes: [] } },
          }),
        },
        execution: { canExecute: () => true },
      } as unknown as HostServerDependencies,
      async () => [],
    );
    const session = { user: { id: host.ownerId } } as Parameters<PersonalResources["detail"]>[0];
    const page = await resources.detail(session, { kind: "environment" });
    if (page.data.kind !== "environment") throw new Error("Expected environments");
    expect(page.next).toBeNull();
    expect(utf8ByteLength(JSON.stringify(page.data))).toBeLessThanOrEqual(
      personalInventoryBound("environment"),
    );
    const [entry] = page.data.environments;
    expect(entry).toMatchObject({ sections: { harnessDrivers: 100 } });
    expect(entry).not.toHaveProperty("harnessDrivers");
    expect(utf8ByteLength(JSON.stringify(entry))).toBeLessThanOrEqual(
      environmentInventoryEntryMaxBytes,
    );
    // The environment's own read carries every engine whole.
    const { environment } = await resources.environmentDetail(session, entry!.id);
    expect(environment.harnessDrivers).toHaveLength(100);
    expect(environment.harnessDrivers.map(({ driverKind }) => driverKind)).toEqual(
      drivers.map(({ driverKind }) => driverKind),
    );
    await expect(resources.environmentDetail(session, "env_missing")).rejects.toThrow();
  } finally {
    await host?.close();
    await database.drop();
  }
});
