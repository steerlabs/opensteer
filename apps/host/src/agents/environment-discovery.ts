import {
  OpensteerError,
  type EnvironmentId,
  type HarnessId,
  type Thread,
  type UserId,
  type WorkspaceBackingKind,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import {
  EnvironmentListInputSchema,
  EnvironmentDiscoverySchema,
  type EnvironmentListInput,
  type EnvironmentDiscovery,
} from "@opensteer/protocol";
import { delegationEngines } from "./delegation-placement.js";

export type EnvironmentDiscoveryStore = Pick<
  OpensteerStore,
  "listAgentHarnessInstancesForUser" | "listEnvironmentsForUser" | "listHarnessCatalogs"
>;

export async function environmentDiscovery(options: {
  readonly store: EnvironmentDiscoveryStore;
  readonly userId: UserId;
  readonly parent: Thread;
  readonly input: EnvironmentListInput;
  readonly connected: (id: EnvironmentId) => boolean;
  readonly canRun: (id: EnvironmentId, driverKind: HarnessId) => boolean;
  readonly workspaceBackings: (id: EnvironmentId) => readonly WorkspaceBackingKind[];
}): Promise<EnvironmentDiscovery> {
  const { store, userId, parent, connected, canRun, workspaceBackings } = options;
  const { query, harnessInstanceId, cursor, environmentCursor, harnessCursor } = options.input;
  const input = EnvironmentListInputSchema.parse({
    query,
    harnessInstanceId,
    cursor,
    environmentCursor,
    harnessCursor,
  });
  const rows = await store.listAgentHarnessInstancesForUser(userId, {
    includeDisabled: true,
    ...(input.harnessInstanceId ? { id: input.harnessInstanceId, limit: 1 } : { limit: 65 }),
    ...(input.harnessCursor ? { afterId: input.harnessCursor } : {}),
  });
  if (input.harnessInstanceId && !rows.length)
    throw new OpensteerError({
      code: "forbidden",
      message: "AI engine profile is unavailable in your environments",
    });
  const harnesses = rows.slice(0, 64);
  const environmentRows = await store.listEnvironmentsForUser(
    userId,
    65,
    input.harnessInstanceId
      ? { id: harnesses[0]!.environmentId }
      : input.environmentCursor
        ? { afterId: input.environmentCursor }
        : {},
  );
  if (input.harnessInstanceId && !environmentRows.length) {
    throw new OpensteerError({
      code: "forbidden",
      message: "AI engine profile is unavailable in your environments",
    });
  }
  const environments = environmentRows.slice(0, 64);
  return EnvironmentDiscoverySchema.parse({
    delegationDefault: {
      environmentId: parent.environmentId,
      harnessInstanceId: parent.harnessInstanceId,
      model: {
        modelId: parent.modelSelection.modelId,
        providerId: parent.modelSelection.providerId,
        options: parent.modelSelection.options,
      },
    },
    environments: environments.map(({ id, kind, name }) => ({
      id,
      kind,
      name,
      connected: connected(id),
      workspaceBackings: workspaceBackings(id),
      compatibleHarnessInstanceIds: harnesses
        .filter(
          (harness) =>
            harness.environmentId === id && harness.enabled && canRun(id, harness.driverKind),
        )
        .map(({ id }) => id),
    })),
    ...(environmentRows.length > 64 ? { environmentsNextCursor: environments[63]!.id } : {}),
    harnesses: await delegationEngines(store, harnesses, { input, connected, canRun }),
    ...(rows.length > 64 ? { harnessesNextCursor: harnesses[63]!.id } : {}),
  });
}
