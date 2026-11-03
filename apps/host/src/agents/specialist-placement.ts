import { DelegationModelChoiceSchema } from "@opensteer/core";
import { OpensteerError, type HarnessId, type SpecialistRegistration } from "@opensteer/core";
import {
  delegationPlacement,
  type DelegationPlacementRequest,
  type DelegationPlacement,
} from "./delegation-placement.js";
import type { OpensteerStore } from "@opensteer/database";

/** Select the default account before inspecting models; a different account is not consent. */
export async function specialistPlacement(
  store: Pick<OpensteerStore, "getHarnessCatalog" | "getHarnessInstance" | "listHarnessInstances">,
  request: Pick<DelegationPlacementRequest, "environment" | "parent"> & {
    specialist: Pick<SpecialistRegistration, "models" | "fallback">;
    canRun: (engine: HarnessId) => boolean;
  },
): Promise<DelegationPlacement> {
  const reasons: string[] = [];
  const accounts = (
    await store.listHarnessInstances({ environmentIds: [request.environment.id] })
  ).filter((a) => a.enabled);
  for (const candidate of request.specialist.models) {
    try {
      const matching = accounts.filter((a) => a.driverKind === candidate.engine);
      const defaults = matching.filter((a) => a.isDefault);
      const account =
        defaults.length === 1 ? defaults[0] : matching.length === 1 ? matching[0] : undefined;
      if (!account)
        throw new Error(matching.length ? "ambiguous default account" : "engine unavailable");
      if (!request.canRun(account.driverKind))
        throw new Error("engine not runnable on this computer");
      const catalog = await store.getHarnessCatalog(request.environment.id, account.id);
      if (catalog?.status !== "ready")
        throw new Error(`catalog ${catalog?.status ?? "unreported"}`);
      const models = catalog.models.filter(
        (m) => m.modelId === candidate.model || `${m.providerId}/${m.modelId}` === candidate.model,
      );
      if (models.length !== 1)
        throw new Error(models.length ? "ambiguous model" : "model unavailable");
      const model = models[0]!;
      return await delegationPlacement(store, {
        ...request,
        existingThread: null,
        harnessInstanceId: account.id,
        model: DelegationModelChoiceSchema.parse({
          modelId: model.modelId,
          providerId: model.providerId,
          ...(candidate.options ? { options: candidate.options } : {}),
        }),
      });
    } catch (error) {
      reasons.push(
        `${candidate.engine}/${candidate.model}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (request.specialist.fallback === "caller")
    return delegationPlacement(store, { ...request, existingThread: null });
  throw new OpensteerError({
    code: "bad_request",
    message: `No specialist model can run: ${reasons.join("; ")}`,
  });
}
