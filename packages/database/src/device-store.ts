import {
  OpensteerError,
  RunnerIdSchema,
  type AuthSessionId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import {
  deviceAccess,
  type DeviceSessionBindingProof,
  type RunnerLeaveRequest,
  type MachineAccessPolicy,
  type RunnerModuleName,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import {
  verifyDeviceLeaveSignature,
  verifyDeviceSessionBindingSignature,
} from "@opensteer/runner-auth";
import { type Kysely, sql } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { personalDeploymentOwner } from "./machine-store.js";
import { machineOwnershipIn } from "./machine-ownership.js";
import { revokeRunner } from "./runner-store.js";
import type { ChannelLinks } from "./store-primitives.js";

export async function bindDeviceSession(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly machineId: RunnerId;
    readonly sessionId: AuthSessionId;
    readonly userId: UserId;
    readonly proof: DeviceSessionBindingProof;
  },
): Promise<void> {
  await withPersonalTransaction(database, async (transaction) => {
    const runner = await transaction
      .selectFrom("runners")
      .select(["publicKeyPem", "revokedAt"])
      .where("id", "=", input.machineId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const session = await transaction
      .selectFrom("authSessions")
      .select(["deviceId", "expiresAt", "absoluteExpiresAt", "userId"])
      .where("id", "=", input.sessionId)
      .forUpdate()
      .executeTakeFirst();
    const ownership = await machineOwnershipIn(transaction, input.machineId);
    const deployment = await transaction
      .selectFrom("deployments")
      .select("id")
      .where("singletonKey", "=", "primary")
      .executeTakeFirstOrThrow();
    if (
      !runner ||
      runner.revokedAt ||
      !session ||
      session.userId !== input.userId ||
      session.expiresAt.getTime() <= Date.now() ||
      session.absoluteExpiresAt.getTime() <= Date.now() ||
      ownership?.effectiveOwner !== input.userId ||
      (session.deviceId !== null && session.deviceId !== input.machineId) ||
      !verifyDeviceSessionBindingSignature(runner.publicKeyPem, {
        deploymentId: deployment.id,
        runnerId: input.machineId,
        sessionId: input.sessionId,
        ...input.proof,
      })
    ) {
      throw new OpensteerError({ code: "forbidden", message: "Device session binding refused" });
    }
    await transaction
      .updateTable("authSessions")
      .set({ deviceId: input.machineId })
      .where("id", "=", input.sessionId)
      .execute();
  });
}

export async function revokeDeviceSession(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: {
    readonly sessionId: AuthSessionId;
    readonly userId: UserId;
  },
) {
  return withPersonalTransaction(database, async (transaction) => {
    const session = await transaction
      .selectFrom("authSessions")
      .select("deviceId")
      .where("id", "=", input.sessionId)
      .where("userId", "=", input.userId)
      .forUpdate()
      .executeTakeFirst();
    if (!session) return { runnerId: null, removed: null, endedSessionIds: [input.sessionId] };
    const runner = session.deviceId
      ? await transaction
          .selectFrom("runners")
          .select(["id", "kind", "ownerKind"])
          .where("id", "=", session.deviceId)
          .executeTakeFirst()
      : undefined;
    if (runner && !(runner.kind === "main" && runner.ownerKind === "deployment")) {
      const removed = await revokeRunner(transaction, links, runner.id, input.userId);
      return { runnerId: runner.id, removed, endedSessionIds: removed.endedSessionIds };
    }
    await transaction.deleteFrom("authSessions").where("id", "=", input.sessionId).execute();
    return { runnerId: null, removed: null, endedSessionIds: [input.sessionId] };
  });
}

export async function leaveDevice(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: RunnerLeaveRequest,
) {
  const runnerId = RunnerIdSchema.parse(input.runnerId);
  return withPersonalTransaction(database, async (transaction) => {
    const deployment = await transaction
      .selectFrom("deployments")
      .select("id")
      .where("singletonKey", "=", "primary")
      .executeTakeFirstOrThrow();
    if (deployment.id !== input.deploymentId)
      throw new OpensteerError({ code: "forbidden", message: "Device leave refused" });
    const runner = await transaction
      .selectFrom("runners")
      .select(["publicKeyPem", "ownerUserId", "revokedAt"])
      .where("id", "=", runnerId)
      .executeTakeFirst();
    if (runner) {
      if (!verifyDeviceLeaveSignature(runner.publicKeyPem, input))
        throw new OpensteerError({ code: "forbidden", message: "Device leave refused" });
      const owner = await machineOwnershipIn(transaction, runnerId);
      const ownerId =
        owner?.effectiveOwner ?? runner.ownerUserId ?? (await personalDeploymentOwner(transaction));
      if (!ownerId)
        throw new OpensteerError({ code: "forbidden", message: "Device leave refused" });
      const removed = await revokeRunner(transaction, links, runnerId, ownerId, {
        allowDeployment: true,
      });
      return { runnerId: runnerId, removed };
    }
    const pending = await transaction
      .selectFrom("runnerEnrollments")
      .select(["id", "tokenHash", "preparedIdentity"])
      .where(sql<boolean>`prepared_identity ->> 'runnerId' = ${input.runnerId}`)
      .execute();
    const own = pending.filter(
      (row) =>
        row.preparedIdentity &&
        verifyDeviceLeaveSignature(row.preparedIdentity.publicKeyPem, input),
    );
    if (!own.length)
      throw new OpensteerError({ code: "forbidden", message: "Device leave refused" });
    for (const enrollment of own) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${enrollment.tokenHash}, 0))`.execute(
        transaction,
      );
      await transaction
        .updateTable("runnerEnrollments")
        .set({ expiresAt: new Date(0) })
        .where("id", "=", enrollment.id)
        .where("consumedAt", "is", null)
        .execute();
    }
    return { runnerId: runnerId, removed: null };
  });
}

export type DeviceAccessState = "enabled" | "disabled" | "unsupported";
export function deviceAccessStates(
  policy: MachineAccessPolicy,
  modules: readonly RunnerModuleName[],
  descriptors: RunnerDescriptor["modules"],
  home: boolean,
) {
  const access = deviceAccess(policy);
  const state = (supported: boolean, enabled: boolean): DeviceAccessState =>
    !supported ? "unsupported" : enabled ? "enabled" : "disabled";
  return {
    browser: state(
      modules.includes("browser") && descriptors.browser !== undefined,
      access.browser,
    ),
    apps: state(
      modules.includes("integrations") && descriptors.integrations !== undefined,
      access.apps,
    ),
    files: home
      ? ("enabled" as const)
      : state(modules.includes("shell") && descriptors.shell !== undefined, access.files),
  };
}
export async function listOwnedDevices(database: Kysely<DatabaseSchema>, userId: UserId) {
  if ((await personalDeploymentOwner(database)) !== userId) return [];
  const rows = await database
    .selectFrom("runners")
    .select([
      "id",
      "name",
      "kind",
      "ownerKind",
      "accessPolicy",
      "allowedModules",
      "moduleDescriptors",
    ])
    .where("revokedAt", "is", null)
    .where("kind", "!=", "managed")
    .where((eb) =>
      eb.or([
        eb.and([eb("ownerKind", "=", "user"), eb("ownerUserId", "=", userId)]),
        eb.and([eb("kind", "=", "main"), eb("ownerKind", "=", "deployment")]),
      ]),
    )
    .orderBy("name")
    .orderBy("id")
    .execute();
  return rows.map((row) => ({
    machineId: row.id,
    name: row.name,
    access: deviceAccessStates(
      row.accessPolicy,
      row.allowedModules,
      row.moduleDescriptors,
      row.kind === "main" && row.ownerKind === "deployment",
    ),
  }));
}
