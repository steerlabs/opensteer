import {
  createId,
  DeviceIdSchema,
  deploymentPolicy,
  OpensteerError,
  type AuthSessionId,
  type DeviceId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import { machineAccessPolicyDefault } from "@opensteer/protocol";
import { type Kysely, type Transaction } from "kysely";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { deviceOwnershipIn, machineOwnershipIn } from "./machine-ownership.js";
import { getSelfDeviceId } from "./device-inventory-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { jsonValue } from "./store-primitives.js";
import { requestSettlementActor } from "./request-settlement.js";
import type { DatabaseSchema } from "./schema.js";

export interface IphoneScreenActor {
  readonly userId: UserId;
  readonly sessionId: AuthSessionId;
  readonly idempotencyKey: string;
}
export interface AttachIphoneScreenInput extends IphoneScreenActor {
  readonly driverRunnerId: RunnerId;
  readonly driverConnectionGeneration: number;
  /** Supplied by the Host only after the authenticated integrations welcome negotiated version 1. */
  readonly negotiatedScreenDrivers: 1;
  readonly target:
    | { readonly kind: "new"; readonly name: string }
    | {
        readonly kind: "existing";
        readonly deviceId: DeviceId;
        readonly expectedGeneration: number;
      };
}
export interface DetachIphoneScreenInput extends IphoneScreenActor {
  readonly deviceId: DeviceId;
  readonly expectedGeneration: number;
}
export interface IphoneScreenBindingResult {
  readonly deviceId: DeviceId;
  readonly generation: number;
}
const refused = () =>
  new OpensteerError({ code: "forbidden", message: "iPhone screen driver operation refused" });
const conflict = () =>
  new OpensteerError({
    code: "conflict",
    message: "The screen driver changed. Refresh this device.",
  });
async function requirePerson(transaction: Transaction<DatabaseSchema>, input: IphoneScreenActor) {
  const deployment = await transaction
    .selectFrom("deployments")
    .select(["id", "deploymentShape"])
    .where("singletonKey", "=", "primary")
    .executeTakeFirstOrThrow();
  const session = await transaction
    .selectFrom("authSessions")
    .innerJoin("users", "users.id", "authSessions.userId")
    .select(["authSessions.userId", "expiresAt", "absoluteExpiresAt", "users.disabledAt"])
    .where("authSessions.id", "=", input.sessionId)
    .executeTakeFirst();
  if (
    !deploymentPolicy(deployment.deploymentShape).services.personal ||
    !session ||
    session.userId !== input.userId ||
    session.disabledAt !== null ||
    session.expiresAt <= new Date() ||
    session.absoluteExpiresAt <= new Date()
  )
    throw refused();
  return deployment.id;
}
function command(
  input: IphoneScreenActor,
  type: string,
  request: Readonly<Record<string, unknown>>,
): AdministrationCommandIdentity {
  return {
    requestedBy: input.userId,
    idempotencyKey: input.idempotencyKey,
    type,
    request,
    authoritySource: { kind: "user-session", userId: input.userId },
  };
}
async function requireScreenPhone(
  transaction: Transaction<DatabaseSchema>,
  deviceId: DeviceId,
  userId: UserId,
  deploymentId: import("@opensteer/core").DeploymentId,
) {
  const device = await transaction
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", deviceId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (
    !device ||
    device.deploymentId !== deploymentId ||
    device.removedAt ||
    device.kind !== "phone" ||
    device.platform !== "ios" ||
    (await deviceOwnershipIn(transaction, deviceId))?.effectiveOwner !== userId
  )
    throw refused();
  // Even a detached self slot identifies an app-enrolled phone, never a screen-only target.
  const self = await transaction
    .selectFrom("deviceDrivers")
    .select("deviceId")
    .where("deviceId", "=", deviceId)
    .where("role", "=", "self")
    .executeTakeFirst();
  if (self) throw refused();
  return device;
}
export async function attachIphoneScreen(
  database: Kysely<DatabaseSchema>,
  input: AttachIphoneScreenInput,
): Promise<IphoneScreenBindingResult> {
  const target =
    input.target.kind === "new"
      ? { ...input.target, name: input.target.name.trim() }
      : input.target;
  if (target.kind === "new" && (!target.name || target.name.length > 120))
    throw new OpensteerError({ code: "bad_request", message: "Device name is invalid" });
  return withPersonalTransaction(database, async (transaction) => {
    const deploymentId = await requirePerson(transaction, input);
    const result = await administrationCommand(
      transaction,
      command(input, "iphone.screen.attach", { driverRunnerId: input.driverRunnerId, target }),
      async () => {
        const old =
          target.kind === "existing"
            ? await transaction
                .selectFrom("deviceDrivers")
                .select("runnerId")
                .where("deviceId", "=", target.deviceId)
                .where("role", "=", "screen")
                .executeTakeFirst()
            : undefined;
        const runners = await transaction
          .selectFrom("runners")
          .selectAll()
          .where(
            "id",
            "in",
            [...new Set([input.driverRunnerId, ...(old ? [old.runnerId] : [])])].sort(),
          )
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        const runner = runners.find((r) => r.id === input.driverRunnerId);
        const selfId = await getSelfDeviceId(transaction, input.driverRunnerId);
        if (
          !runner ||
          runner.revokedAt ||
          !selfId ||
          runner.device?.platform !== "macos" ||
          !runner.allowedModules.includes("integrations") ||
          runner.moduleDescriptors.integrations?.platform !== "darwin" ||
          runner.moduleDescriptors.integrations.screenDrivers !== 1 ||
          input.negotiatedScreenDrivers !== 1 ||
          Number(runner.connectionGeneration) !== input.driverConnectionGeneration
        )
          throw refused();
        const deviceId =
          target.kind === "existing" ? target.deviceId : DeviceIdSchema.parse(createId("device"));
        // Lock the driver's self Device and target together, before any binding slot.
        const devices = await transaction
          .selectFrom("devices")
          .selectAll()
          .where("id", "in", [...new Set([selfId, deviceId])].sort())
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        const self = devices.find((device) => device.id === selfId);
        if (
          !self ||
          self.removedAt ||
          self.deploymentId !== deploymentId ||
          (await deviceOwnershipIn(transaction, selfId))?.effectiveOwner !== input.userId ||
          (await machineOwnershipIn(transaction, input.driverRunnerId))?.effectiveOwner !==
            input.userId
        )
          throw refused();
        if (target.kind === "new")
          await transaction
            .insertInto("devices")
            .values({
              id: deviceId,
              deploymentId,
              ownerKind: "user",
              ownerUserId: input.userId,
              name: target.name,
              kind: "phone",
              platform: "ios",
              form: "phone",
              accessPolicy: jsonValue({
                ...machineAccessPolicyDefault,
                browser: false,
                apps: false,
                reach: "nobody",
              }),
              accessPolicyRevision: 1,
              removedAt: null,
            })
            .execute();
        else await requireScreenPhone(transaction, deviceId, input.userId, deploymentId);
        const slots = await transaction
          .selectFrom("deviceDrivers")
          .selectAll()
          .where("deviceId", "in", [...new Set([selfId, deviceId])].sort())
          .orderBy("deviceId")
          .orderBy("role")
          .forNoKeyUpdate()
          .execute();
        const selfSlot = slots.find((slot) => slot.deviceId === selfId && slot.role === "self");
        if (!selfSlot || selfSlot.detachedAt || selfSlot.runnerId !== input.driverRunnerId)
          throw refused();
        const binding = slots.find((slot) => slot.deviceId === deviceId && slot.role === "screen");
        if (
          target.kind === "existing" &&
          (!binding ||
            Number(binding.generation) !== target.expectedGeneration ||
            (old && binding.runnerId !== old.runnerId))
        )
          throw conflict();
        const generation = Number(binding?.generation ?? 0) + 1;
        await transaction
          .insertInto("deviceDrivers")
          .values({
            deviceId,
            role: "screen",
            runnerId: input.driverRunnerId,
            generation,
            detachedAt: null,
          })
          .onConflict((c) =>
            c.columns(["deviceId", "role"]).doUpdateSet({
              runnerId: input.driverRunnerId,
              generation,
              detachedAt: null,
              updatedAt: new Date(),
            }),
          )
          .execute();
        await audit(transaction, input, "device.screen.attached", deviceId, generation);
        return { deviceId, generation };
      },
    );
    await requestSettlementActor(transaction, input.userId, input.sessionId);
    return result;
  });
}
export async function detachIphoneScreen(
  database: Kysely<DatabaseSchema>,
  input: DetachIphoneScreenInput,
): Promise<IphoneScreenBindingResult> {
  return withPersonalTransaction(database, async (transaction) => {
    const deploymentId = await requirePerson(transaction, input);
    const result = await administrationCommand(
      transaction,
      command(input, "iphone.screen.detach", {
        deviceId: input.deviceId,
        expectedGeneration: input.expectedGeneration,
      }),
      async () => {
        await requireScreenPhone(transaction, input.deviceId, input.userId, deploymentId);
        const binding = await transaction
          .selectFrom("deviceDrivers")
          .selectAll()
          .where("deviceId", "=", input.deviceId)
          .where("role", "=", "screen")
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!binding || Number(binding.generation) !== input.expectedGeneration) throw conflict();
        const generation = Number(binding.generation) + 1;
        await transaction
          .updateTable("deviceDrivers")
          .set({ generation, detachedAt: new Date(), updatedAt: new Date() })
          .where("deviceId", "=", input.deviceId)
          .where("role", "=", "screen")
          .execute();
        await audit(transaction, input, "device.screen.detached", input.deviceId, generation);
        return { deviceId: input.deviceId, generation };
      },
    );
    await requestSettlementActor(transaction, input.userId, input.sessionId);
    return result;
  });
}
async function audit(
  transaction: Transaction<DatabaseSchema>,
  input: IphoneScreenActor,
  action: string,
  deviceId: DeviceId,
  generation: number,
) {
  await transaction
    .insertInto("securityAudit")
    .values({
      id: createId("securityAudit"),
      action,
      actorSessionId: input.sessionId,
      actorUserId: input.userId,
      metadata: jsonValue({ generation }),
      requestId: input.idempotencyKey,
      targetId: deviceId,
      targetType: "device",
    })
    .execute();
}
