import { z } from "zod";
import { OpensteerError, type RunnerId, type UserId } from "@opensteer/core";
import {
  machineIsManagedBy,
  type HarnessInstanceRecord,
  type OpensteerStore,
} from "@opensteer/database";
import { HarnessModelSettingsMapSchema } from "@opensteer/protocol";
export function harnessView(harness: HarnessInstanceRecord) {
  const modelConfig = z
    .object({ models: HarnessModelSettingsMapSchema.optional() })
    .safeParse(harness.config);
  return {
    ...(modelConfig.success && modelConfig.data.models
      ? { modelSettings: modelConfig.data.models }
      : {}),
    config: harness.config,
    driverKind: harness.driverKind,
    enabled: harness.enabled,
    environmentId: harness.environmentId,
    id: harness.id,
    isDefault: harness.isDefault,
    name: harness.name,
    runtimeRevision: harness.runtimeRevision,
    sourceId: harness.sourceId,
    stateKind: harness.stateKind,
  };
}

export async function requireMachineAccessManagement(
  store: OpensteerStore,
  actor: { readonly userId: UserId },
  runnerId: RunnerId,
): Promise<void> {
  const ownership = await store.effectiveMachineOwner(runnerId);
  if (!ownership)
    throw new OpensteerError({ code: "not_found", message: "Active Runner not found" });
  if (machineIsManagedBy(ownership, actor.userId)) {
    return;
  }
  throw new OpensteerError({
    code: "forbidden",
    message: "Only this computer's owner can change how other computers reach it",
  });
}
