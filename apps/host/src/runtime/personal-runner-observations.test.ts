import { createId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import type { RunnerIdentity } from "@opensteer/orchestration";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import type { Kysely } from "kysely";
import { expect, test, vi } from "vitest";
import { PersonalResourceObservations } from "./personal-resource-observations.js";
import { PersonalRunnerObservations } from "./personal-runner-observations.js";

vi.mock("@opensteer/database/personal-mutation", () => ({ commitPersonalMutation: vi.fn() }));

test("publishes a PATH engine version reported after attachment", async () => {
  const runnerId = createId("runner");
  const driver = { driverKind: "codex", readiness: "runtime-check" };
  const attached = {
    runnerId,
    connectionId: "connection",
    connectionGeneration: 1,
    modules: { agents: { harnessDrivers: [driver] } },
  } as unknown as RunnerIdentity;
  const installation = { version: "1.2.3", scope: "ambient", update: "manual" };
  let current = attached;
  let revision = 0;
  const resources = new PersonalResourceObservations();
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: async () => ({ revokedAt: null }),
  };
  const database = { selectFrom: () => query } as unknown as Kysely<DatabaseSchema>;

  vi.mocked(commitPersonalMutation).mockImplementation(async (_database, action) => {
    const observations: (() => void)[] = [];
    const kinds = new Set<PersonalResourceKind>();
    const sequence = String(++revision);
    const mutation = {
      sequence,
      observation: (observe: () => void) => observations.push(observe),
      bumpResource: (kind: PersonalResourceKind) => kinds.add(kind),
    };
    const result = await action(
      database as Parameters<typeof action>[0],
      mutation as unknown as Parameters<typeof action>[1],
    );
    for (const observe of observations) observe();
    resources.committed(kinds, sequence);
    return result;
  });
  const runners = new PersonalRunnerObservations(
    database,
    resources,
    () => current,
    () => undefined,
  );
  await runners.publish(attached, true);
  expect(runners.readRunner(runnerId, "1", "1")?.identity.modules.agents?.harnessDrivers).toEqual([
    driver,
  ]);

  current = {
    ...attached,
    modules: { agents: { harnessDrivers: [{ ...driver, installation }] } },
  } as unknown as RunnerIdentity;
  await runners.onHarnessInstallation(current);
  expect(resources.isCurrent("harness-catalog", "1")).toBe(false);
  expect(runners.readRunner(runnerId, "2", "1")?.identity.modules.agents?.harnessDrivers).toEqual([
    { ...driver, installation },
  ]);
});
