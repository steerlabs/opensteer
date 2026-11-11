import {
  OpensteerError,
  type EnvironmentId,
  type HarnessId,
  type Thread,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import {
  OrchestratorCapabilitiesInputSchema,
  type OrchestratorCapabilitiesInput,
} from "@opensteer/agent-tools/tools";
import { EngineDiscoverySchema, type EngineDiscovery } from "@opensteer/agent-tools/outputs";
import { delegationEngines } from "./delegation-placement.js";

export type EnvironmentDiscoveryStore = Pick<
  OpensteerStore,
  "listAgentHarnessInstancesForUser" | "listHarnessCatalogs"
>;

export async function environmentDiscovery(options: {
  readonly store: EnvironmentDiscoveryStore;
  readonly userId: UserId;
  readonly parent?: Thread;
  readonly environmentId?: EnvironmentId;
  readonly input: OrchestratorCapabilitiesInput;
  readonly connected: (id: EnvironmentId) => boolean;
  readonly canRun: (id: EnvironmentId, driverKind: HarnessId) => boolean;
}): Promise<EngineDiscovery> {
  const { store, userId, parent, connected, canRun } = options;
  const { query, harnessInstanceId, cursor, harnessCursor } = options.input;
  const input = OrchestratorCapabilitiesInputSchema.parse({
    query,
    harnessInstanceId,
    cursor,
    harnessCursor,
  });
  const rows = await store.listAgentHarnessInstancesForUser(userId, {
    includeDisabled: true,
    ...(options.environmentId ? { environmentId: options.environmentId } : {}),
    ...(input.harnessInstanceId ? { id: input.harnessInstanceId, limit: 1 } : { limit: 65 }),
    ...(input.harnessCursor ? { afterId: input.harnessCursor } : {}),
  });
  if (input.harnessInstanceId && !rows.length)
    throw new OpensteerError({
      code: "forbidden",
      message: "AI engine profile is unavailable in your environments",
    });
  const harnesses = rows.slice(0, 64);
  return EngineDiscoverySchema.parse({
    ...(parent
      ? {
          delegationDefault: {
            environmentId: parent.environmentId,
            harnessInstanceId: parent.harnessInstanceId,
            model: {
              modelId: parent.modelSelection.modelId,
              providerId: parent.modelSelection.providerId,
              options: parent.modelSelection.options,
            },
          },
        }
      : {}),
    harnesses: await delegationEngines(store, harnesses, { input, connected, canRun }),
    ...(rows.length > 64 ? { harnessesNextCursor: harnesses[63]!.id } : {}),
  });
}
