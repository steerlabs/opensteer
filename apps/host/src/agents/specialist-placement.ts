import {
  expandModelWants,
  OpensteerError,
  type EnvironmentId,
  type ModelWant,
  type SpecialistManifest,
  type Thread,
  type ThreadAccessMode,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { SpecialistStore, type OpensteerStore } from "@opensteer/database";
import {
  resolveAutomaticModels,
  workspaceExecution,
  type AutomaticModelDependencies,
} from "./automatic-models.js";
import type { DelegationPlacement } from "./delegation-placement.js";

/**
 * A new specialist Thread's account and model, chosen once before admission
 * from the persisted manifest: exact entries as written, `{ role }` entries
 * expanded in place from the caller's own automatic models. A manifest names
 * no account; only the caller's authorized accounts on the Workspace's
 * computer qualify. `fallback: "caller"` ends the list with the caller's model.
 */
export async function specialistPlacement(
  dependencies: AutomaticModelDependencies & {
    readonly runners: Pick<RunnerRegistry, "canRunHarness" | "harnessAccessModes">;
  },
  request: {
    readonly userId: UserId;
    readonly environmentId: EnvironmentId;
    readonly accessMode: ThreadAccessMode;
    readonly specialist: Pick<SpecialistManifest, "models" | "fallback">;
    /** The calling Run's Thread; a connected agent has none. */
    readonly caller?: Thread | undefined;
  },
): Promise<DelegationPlacement> {
  const { candidates, skipped } = await resolveAutomaticModels(dependencies, {
    userId: request.userId,
    wants: (config) => expandModelWants(request.specialist.models, config),
    original: request.specialist.fallback === "caller" ? request.caller : undefined,
    canRun: workspaceExecution(dependencies.runners, request),
  });
  const chosen = candidates[0];
  if (chosen)
    return {
      harnessInstanceId: chosen.harnessInstanceId,
      harnessRevision: chosen.harnessRevision,
      modelSelection: chosen.storedModelSelection,
    };
  const reasons = [
    ...new Set(
      skipped.map(
        (skip) =>
          `${wantLabel(skip.want)}: ${skip.reason}${skip.detail ? ` (${skip.detail})` : ""}`,
      ),
    ),
  ];
  throw new OpensteerError({
    code: "bad_request",
    message: `No specialist model can run: ${reasons.join("; ") || "no account here offers its models"}`,
  });
}

function wantLabel(want: ModelWant | null) {
  if (!want) return "caller's model";
  if ("model" in want) return `${want.engine}/${want.model}`;
  if (!("kind" in want)) return `${want.engine} small model`;
  return want.kind === "model"
    ? `${want.driverKind}/${want.providerId}/${want.modelId}`
    : `${want.driverKind} small model`;
}

export async function resolveDelegationSpecialist(
  store: OpensteerStore,
  userId: UserId,
  workspaceId: WorkspaceId,
  selector: string | undefined,
  existingThread: Thread | null,
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
