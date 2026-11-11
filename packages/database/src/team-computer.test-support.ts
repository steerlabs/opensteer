import { createHash } from "node:crypto";
import { teamComputerModules } from "./team-computer.js";
import { enrollTestRunner, testRunnerDescriptor } from "./store.integration.test-support.js";
import type { OpensteerStore } from "./store.js";
import type { EnvironmentId, RunnerId, UserId } from "@opensteer/core";
import { createId } from "@opensteer/core";
import { jsonValue } from "./store-primitives.js";

export async function enrollTestTeamComputer(
  store: OpensteerStore,
  input: {
    readonly userId: UserId;
    readonly environmentId: EnvironmentId;
    readonly runnerId: RunnerId;
    readonly tokenSuffix: string;
  },
) {
  const descriptor = testRunnerDescriptor({
    environmentId: input.environmentId,
    runnerId: input.runnerId,
    name: "Team computer",
    runnerKind: "main",
  });
  await enrollTestRunner(store, {
    ...input,
    createdBy: input.userId,
    name: descriptor.name,
    allowedModules: teamComputerModules,
    device: { platform: "linux", form: "server" },
    capabilities: ["filesystem", "project-authority-v1"],
    modules: {
      agents: descriptor.modules.agents,
      shell: {
        platform: "linux",
        fullDiskAccess: false,
        hostPublicKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
      },
    },
  });
}

/** A forged stored identity exercises refusal without enrolling a forbidden device. */
export async function seedMemberComputer(
  store: OpensteerStore,
  source: {
    readonly runnerId: RunnerId;
    readonly environmentId: EnvironmentId;
    readonly userId: UserId;
  },
) {
  const database = store.database;
  const runner = await database
    .selectFrom("runners")
    .selectAll()
    .where("id", "=", source.runnerId)
    .executeTakeFirstOrThrow();
  const runnerId = createId("runner");
  const environmentId = createId("environment");
  await database
    .insertInto("runners")
    .values({
      ...runner,
      id: runnerId,
      kind: "managed",
      name: "Foreign member computer",
      ownerKind: "deployment",
      ownerUserId: source.userId,
      publicKeyFingerprint: `sha256:${createHash("sha256").update(runnerId).digest("base64url")}`,
      enrollmentTokenHash: `sha256:${createHash("sha256").update(runnerId).digest("base64url")}`,
      capabilities: jsonValue(runner.capabilities),
      allowedModules: jsonValue(runner.allowedModules),
      moduleDescriptors: jsonValue(runner.moduleDescriptors),
      accessPolicy: jsonValue(runner.accessPolicy),
      device: jsonValue(runner.device),
    })
    .execute();
  const environment = await database
    .selectFrom("executionEnvironments")
    .selectAll()
    .where("id", "=", source.environmentId)
    .executeTakeFirstOrThrow();
  await database
    .insertInto("executionEnvironments")
    .values({
      ...environment,
      id: environmentId,
      kind: "managed",
      runnerId,
      capabilities: jsonValue(environment.capabilities),
    })
    .execute();
  return { runnerId, environmentId };
}
