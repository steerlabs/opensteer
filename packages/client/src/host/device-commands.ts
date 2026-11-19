import { z } from "zod";
import {
  DeviceMachineAccessUpdateCommandSchema,
  IphoneScreenAttachCommandSchema,
  hostApi,
  type MachineAccessPolicy,
} from "@opensteer/protocol";

export type IphoneScreenAttachInput = Omit<
  z.input<typeof IphoneScreenAttachCommandSchema>,
  "type" | "idempotencyKey"
> & { readonly idempotencyKey?: string };

export const clientCommandSchema = hostApi["commands.dispatch"].payload;
export type ClientCommandInput = z.input<typeof clientCommandSchema>;

export type MachineAccessUpdateInput = {
  readonly expectedRevision: number;
  readonly policy: MachineAccessPolicy;
  readonly requestReview?: { readonly requestId: string; readonly revision: string };
} & (
  | { readonly deviceId: string; readonly runnerId?: never }
  | { readonly runnerId: string; readonly deviceId?: never }
);

export function deviceAccessCommand(input: MachineAccessUpdateInput, idempotencyKey: string) {
  const id = input.deviceId ?? input.runnerId;
  return DeviceMachineAccessUpdateCommandSchema.parse({
    type: "machine.access.update",
    deviceId: id,
    policy: input.policy,
    ...(input.requestReview ? { requestReview: input.requestReview } : {}),
    expectedRevision: input.expectedRevision,
    idempotencyKey,
  });
}
