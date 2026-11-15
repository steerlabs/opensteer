import {
  HarnessInstanceIdSchema,
  OpensteerError,
  type EnvironmentId,
  type HarnessId,
  type Thread,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { AiAccountListInput } from "@opensteer/agent-tools/tools";
import type { AiAccountListOutput } from "@opensteer/agent-tools/outputs";
import { harnessView } from "../administration/authority.js";
import { delegationEngines } from "../agents/delegation-placement.js";
import { computerIds } from "./computer-ids.js";

const accountPage = 64;

export async function aiAccountDiscovery(options: {
  readonly store: Pick<
    OpensteerStore,
    "listAgentHarnessInstancesForUser" | "listHarnessCatalogs" | "listEnvironmentsForUser"
  >;
  readonly userId: UserId;
  readonly parent?: Thread;
  readonly environmentId?: EnvironmentId;
  readonly input: AiAccountListInput;
  readonly connected: (id: EnvironmentId) => boolean;
  readonly canRun: (id: EnvironmentId, driverKind: HarnessId) => boolean;
}): Promise<Pick<AiAccountListOutput, "accounts" | "nextCursor" | "delegationDefault">> {
  const { store, userId, parent, input } = options;
  const after = input.aiAccountId ? undefined : input.cursor;
  const afterId = after === undefined ? undefined : HarnessInstanceIdSchema.safeParse(after).data;
  if (after !== undefined && !afterId)
    throw new OpensteerError({
      code: "bad_request",
      message:
        "cursor is not from this list. Start again without it, or pass aiAccountId to page through one account's models.",
    });
  const rows = await store.listAgentHarnessInstancesForUser(userId, {
    includeDisabled: true,
    ...(options.environmentId ? { environmentId: options.environmentId } : {}),
    ...(input.aiAccountId ? { id: input.aiAccountId, limit: 1 } : { limit: accountPage + 1 }),
    ...(afterId ? { afterId } : {}),
  });
  if (input.aiAccountId && !rows.length)
    throw new OpensteerError({ code: "forbidden", message: "That AI account is unavailable" });
  const harnesses = rows.slice(0, accountPage);
  const [engines, computers] = await Promise.all([
    delegationEngines(store, harnesses, {
      input,
      connected: options.connected,
      canRun: options.canRun,
    }),
    computerIds(store, userId),
  ]);
  const nextCursor = input.aiAccountId
    ? engines[0]?.modelsNextCursor
    : rows.length > accountPage
      ? harnesses.at(-1)!.id
      : undefined;
  return {
    accounts: engines.map(({ environmentId, id, driverKind, modelsNextCursor: _, ...engine }) => {
      const record = harnesses.find((harness) => harness.id === id)!;
      const { modelSettings } = harnessView(record);
      return {
        aiAccountId: id,
        computerId: computers.computerId(environmentId),
        engine: driverKind,
        isDefault: record.isDefault,
        ...engine,
        models: [...engine.models],
        ...(modelSettings ? { modelLimits: modelSettings } : {}),
      };
    }),
    ...(nextCursor ? { nextCursor } : {}),
    ...(parent
      ? {
          delegationDefault: {
            aiAccountId: parent.harnessInstanceId,
            model: {
              modelId: parent.modelSelection.modelId,
              providerId: parent.modelSelection.providerId,
              options: parent.modelSelection.options,
            },
          },
        }
      : {}),
  };
}
