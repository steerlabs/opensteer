import { DelegationModelChoiceSchema } from "@opensteer/core";
import { OpensteerError, type HarnessId, type SpecialistRegistration } from "@opensteer/core";
import {
  delegationPlacement,
  type DelegationPlacementRequest,
  type DelegationPlacement,
} from "./delegation-placement.js";
import { SpecialistStore, type OpensteerStore } from "@opensteer/database";

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

export async function resolveDelegationSpecialist(
  store: OpensteerStore,
  userId: import("@opensteer/core").UserId,
  workspaceId: import("@opensteer/core").WorkspaceId,
  selector: string | undefined,
  existingThread: import("@opensteer/core").Thread | null,
) {
  const registrations =
    selector || existingThread?.specialistId
      ? await new SpecialistStore(store.database).list(workspaceId, userId)
      : [];
  const specialist = existingThread?.specialistId
    ? registrations.find((r) => r.id === existingThread.specialistId)
    : (registrations.find((r) => r.id === selector) ??
      registrations.find((r) => r.plugin === selector && r.ownerUserId === userId) ??
      registrations.find((r) => r.plugin === selector));
  if ((selector || existingThread?.specialistId) && !specialist)
    throw badRequest("Specialist is not registered in this Workspace");
  if (existingThread && selector && selector !== specialist?.id && selector !== specialist?.plugin)
    throw badRequest("An existing Thread keeps its specialist binding");
  if (specialist && specialist.ownerUserId !== userId)
    throw forbidden(
      `${specialist.plugin} uses ${specialist.ownerName ?? specialist.ownerUserId}'s accounts; add it for yourself to use your own`,
    );
  if (specialist?.status === "pending")
    throw badRequest(
      `Specialist is pending: ${specialist.access
        .filter((a) => a.state !== "bound")
        .map((a) => `${a.type}: ${a.state} (${a.reason})`)
        .join("; ")}`,
    );
  if (specialist)
    await new SpecialistStore(store.database).assertRunnable(specialist.id, workspaceId, userId);
  return specialist;
}

function badRequest(message: string) {
  return new OpensteerError({ code: "bad_request", message });
}
function forbidden(message: string) {
  return new OpensteerError({ code: "forbidden", message });
}
