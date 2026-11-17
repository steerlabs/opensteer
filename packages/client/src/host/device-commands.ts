import { RunnerIdSchema } from "@opensteer/core";
import { DeviceSetComputerAppConnectionSchema } from "@opensteer/integration-core";
import { z } from "zod";
import {
  DeviceMachineAccessUpdateCommandSchema,
  IphoneScreenAttachCommandSchema,
  hostApi,
  type HostApiCommandInput,
  type MachineAccessPolicy,
} from "@opensteer/protocol";

export type IphoneScreenAttachInput = Omit<
  z.input<typeof IphoneScreenAttachCommandSchema>,
  "type" | "idempotencyKey"
> & { readonly idempotencyKey?: string };

export const deviceDriversCapability = "device-drivers-v1";
export const deviceDriversApiVersion = 61;
export const deviceSetupCommandSchema = z.strictObject({
  type: z.literal("integration.computer.setup.set"),
  idempotencyKey: z.string().min(1).max(255),
  input: DeviceSetComputerAppConnectionSchema,
});
export const clientCommandSchema = z.union([
  DeviceMachineAccessUpdateCommandSchema,
  deviceSetupCommandSchema,
  hostApi["commands.dispatch"].payload,
]);
export type ClientCommandInput = z.input<typeof clientCommandSchema>;

export type MachineAccessUpdateInput = {
  readonly expectedRevision: number;
  readonly policy: MachineAccessPolicy;
} & (
  | { readonly deviceId: string; readonly runnerId?: never }
  | { readonly runnerId: string; readonly deviceId?: never }
);

/** The frozen Device command is additive while the public RPC union retains its v60 input. */
export function deviceAccessCommand(
  input: MachineAccessUpdateInput,
  idempotencyKey: string,
  current: boolean,
): HostApiCommandInput | z.output<typeof DeviceMachineAccessUpdateCommandSchema> {
  const id = input.deviceId ?? input.runnerId;
  if (!current && !RunnerIdSchema.safeParse(id).success)
    throw new Error("Update this Opensteer to manage screen Devices.");
  if (!current)
    return hostApi["commands.dispatch"].payload.parse({
      type: "machine.access.update",
      runnerId: id,
      policy: input.policy,
      expectedRevision: input.expectedRevision,
      idempotencyKey,
    });
  return DeviceMachineAccessUpdateCommandSchema.parse({
    type: "machine.access.update",
    deviceId: id,
    policy: input.policy,
    expectedRevision: input.expectedRevision,
    idempotencyKey,
  });
}
