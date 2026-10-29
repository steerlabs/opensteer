import {
  OpensteerError,
  HarnessInstanceIdSchema,
  type DelegationModelChoice,
  type EnvironmentId,
  type HarnessId,
  type HarnessInstanceId,
  type ModelSelection,
  type Thread,
} from "@opensteer/core";
import type { HarnessInstanceRecord, OpensteerStore } from "@opensteer/database";
import { isRetryableHarnessCatalogStatus } from "@opensteer/harness";
import {
  agentHarnessModelsShown,
  agentInspectionModelsShown,
  EnvironmentListInputSchema,
  type AgentHarnessSummary,
  type EnvironmentHarnessSummary,
  type EnvironmentListInput,
  type AgentModelSummary,
  type HarnessInstanceCatalog,
  type HarnessModelDescriptor,
} from "@opensteer/protocol";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  matchModelSelection,
  modelOptionUnavailableMessage,
  storedModelSelection,
} from "./model-selection.js";

export interface DelegationPlacement {
  readonly harnessInstanceId: HarnessInstanceId;
  readonly modelSelection: ModelSelection;
}

export interface DelegationPlacementRequest {
  readonly environment: { readonly id: EnvironmentId; readonly name: string };
  /** A reused Thread keeps the engine and model its own work runs on. */
  readonly existingThread: Thread | null;
  readonly harnessInstanceId?: HarnessInstanceId | undefined;
  readonly model?: DelegationModelChoice | undefined;
  /** The Thread, or a Trigger's anchor Thread, the work is delegated from. */
  readonly parent: Thread;
}

export async function delegationHarnessPage(
  store: Pick<OpensteerStore, "listAgentHarnessInstancesForUser">,
  userId: Parameters<OpensteerStore["listAgentHarnessInstancesForUser"]>[0],
  input: {
    readonly harnessCursor?: HarnessInstanceId | undefined;
    readonly modelPage?:
      | { readonly harnessInstanceId: HarnessInstanceId; readonly cursor?: string | undefined }
      | undefined;
  },
): Promise<{
  readonly harnesses: readonly HarnessInstanceRecord[];
  readonly nextCursor?: HarnessInstanceId;
}> {
  if (input.modelPage) {
    const [harness] = await store.listAgentHarnessInstancesForUser(userId, {
      id: input.modelPage.harnessInstanceId,
      limit: 1,
    });
    if (!harness) {
      throw badRequest("AI engine profile is unavailable in your environments");
    }
    return { harnesses: [harness] };
  }
  const rows = await store.listAgentHarnessInstancesForUser(userId, {
    ...(input.harnessCursor ? { afterId: input.harnessCursor } : {}),
    limit: 65,
  });
  const last = rows[63];
  return {
    harnesses: rows.slice(0, 64),
    ...(rows.length > 64 && last ? { nextCursor: last.id } : {}),
  };
}

type PlacementStore = Pick<
  OpensteerStore,
  "getHarnessCatalog" | "getHarnessInstance" | "listHarnessInstances"
>;

/** Enough of a catalog to choose from, without handing an agent thousands of names. */
const offeredModelsShown = 40;

/**
 * Where delegated work runs.
 *
 * New work carries the delegating Thread's engine and model unless the caller
 * names an engine profile or a model. A named choice is admitted exactly as a
 * person's own choice is, against the live catalog of the account that will
 * run it, and a refusal lists what that account offers. Nothing is switched
 * silently: an engine that does not offer the carried or named model fails
 * the delegation by name.
 *
 * Without a named engine profile, the delegating Thread's engine and source
 * are a requirement: an account of the same engine on another source is
 * billed by somebody else and signs in as somebody else. Among the accounts
 * that qualify, the delegating Thread's own comes first — work continues where
 * it began — then the one the pair answers with when nobody names an account.
 * Only a tie neither settles asks the caller to choose one by id, so creation
 * order never becomes hidden product policy.
 *
 * Agents, Triggers and watches share this rule: the answer does not depend on
 * which capability profile asked.
 */
export async function delegationPlacement(
  store: PlacementStore,
  request: DelegationPlacementRequest,
): Promise<DelegationPlacement> {
  const { environment, existingThread, parent } = request;
  if (existingThread) {
    return {
      harnessInstanceId: existingThread.harnessInstanceId,
      modelSelection: existingThread.modelSelection,
    };
  }
  if (
    request.harnessInstanceId === undefined &&
    request.model === undefined &&
    environment.id === parent.environmentId
  ) {
    return { harnessInstanceId: parent.harnessInstanceId, modelSelection: parent.modelSelection };
  }
  const parentHarness = await store.getHarnessInstance(parent.harnessInstanceId);
  if (!parentHarness) throw badRequest("This Thread's AI engine no longer exists");
  // A named model is admitted as the caller wrote it. The delegating Thread's
  // own selection may carry options its engine has since stopped listing.
  const wanted: Wanted = request.model
    ? { selection: { ...request.model }, unlisted: "refuse" }
    : { selection: parent.modelSelection, unlisted: "carry" };
  const enabled = (await store.listHarnessInstances({ environmentIds: [environment.id] })).filter(
    (candidate) => candidate.enabled,
  );
  const candidates = request.harnessInstanceId
    ? enabled.filter((candidate) => candidate.id === request.harnessInstanceId)
    : enabled.filter(
        (candidate) =>
          candidate.driverKind === parentHarness.driverKind &&
          candidate.sourceId === parentHarness.sourceId,
      );
  if (candidates.length === 0) {
    throw badRequest(
      request.harnessInstanceId
        ? `${request.harnessInstanceId} is not an enabled AI engine on ${environment.name}. environment_list names the engines each environment can run.`
        : `${environment.name} has no enabled ${parentHarness.driverKind} AI engine on ${parentHarness.sourceId}. Name another engine with harnessInstanceId; environment_list names the engines each environment can run.`,
    );
  }
  const inspected = await Promise.all(
    candidates.map(async (harness) => ({
      catalog: await store.getHarnessCatalog(environment.id, harness.id),
      harness,
    })),
  );
  const eligible = inspected.flatMap(({ catalog, harness }) => {
    const match =
      catalog?.status === "ready"
        ? matchModelSelection(catalog.models, wanted.selection, wanted.unlisted)
        : undefined;
    return match?.kind === "offered" ? [{ catalog, harness, model: match.model }] : [];
  });
  if (request.harnessInstanceId) {
    const named = inspected[0]!;
    const admitted = eligible[0];
    if (!admitted) throw placementFailure(environment, wanted, named.harness.name, named.catalog);
    return placement(wanted, admitted);
  }
  // This source names an arbitrary endpoint, so another account with the same
  // source/model does not establish the same destination or data boundary.
  if (
    parentHarness.sourceId === "openai-compatible" &&
    !eligible.some(({ harness }) => harness.id === parentHarness.id)
  ) {
    const choices = inspected.map(({ harness }) => `${harness.name} (${harness.id})`).join(", ");
    throw badRequest(
      `Choose the model server account on ${environment.name} explicitly with harnessInstanceId: ${choices}.`,
    );
  }
  const preferred =
    eligible.find(({ harness }) => harness.id === parentHarness.id) ??
    eligible.find(({ harness }) => harness.isDefault);
  if (preferred) return placement(wanted, preferred);
  if (eligible.length === 1) return placement(wanted, eligible[0]!);
  if (eligible.length > 1) {
    const choices = eligible.map(({ harness }) => `${harness.name} (${harness.id})`).join(", ");
    throw badRequest(
      `${environment.name} has multiple ${parentHarness.driverKind} AI engines that offer ${modelName(wanted)}: ${choices}. Retry with harnessInstanceId.`,
    );
  }
  if (inspected.length === 1) {
    const candidate = inspected[0]!;
    throw placementFailure(environment, wanted, candidate.harness.name, candidate.catalog);
  }
  const offered = inspected
    .map(({ catalog, harness }) => `${harness.name}: ${catalogDescription(catalog, wanted)}`)
    .join("; ");
  throw badRequest(
    `${environment.name} has no ready ${parentHarness.driverKind} AI engine that offers ${modelName(wanted)}; it offers ${offered}`,
  );
}

/**
 * The engine profiles an agent may name for new delegated work, each with the
 * models its latest catalog offers. Each profile shows a bounded share and one
 * inspection a bounded total, and says how many more it has, so the largest
 * reply fits the agent's tool budget.
 */
type DelegationEngine = Pick<
  HarnessInstanceRecord,
  "driverKind" | "enabled" | "environmentId" | "id" | "name" | "runtimeRevision"
>;
type DelegationModelPage = {
  readonly harnessInstanceId: HarnessInstanceId;
  readonly cursor?: string | undefined;
};
type EngineCatalogStore = Pick<OpensteerStore, "listHarnessCatalogs">;
interface EngineDiscovery {
  readonly input: EnvironmentListInput;
  readonly connected: (id: EnvironmentId) => boolean;
  readonly canRun: (id: EnvironmentId, driverKind: HarnessId) => boolean;
}
// Reserve the rest of the durable tool-event ceiling for environment/profile metadata.
const discoveryModelBytes = 256 * 1_024;

export function delegationEngines(
  store: EngineCatalogStore,
  harnesses: readonly DelegationEngine[],
  discovery: EngineDiscovery,
): Promise<EnvironmentHarnessSummary[]>;
export function delegationEngines(
  store: EngineCatalogStore,
  harnesses: readonly DelegationEngine[],
  modelPage?: DelegationModelPage,
): Promise<AgentHarnessSummary[]>;
export async function delegationEngines(
  store: EngineCatalogStore,
  harnesses: readonly DelegationEngine[],
  selection?: DelegationModelPage | EngineDiscovery,
): Promise<AgentHarnessSummary[] | EnvironmentHarnessSummary[]> {
  const catalogs = await store.listHarnessCatalogs(
    [...new Set(harnesses.map(({ environmentId }) => environmentId))],
    harnesses.map(({ id }) => id),
  );
  if (selection && "input" in selection) {
    const discovery = { ...selection, input: EnvironmentListInputSchema.parse(selection.input) };
    const query = [
      ...new Set(discovery.input.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []),
    ].sort();
    let remaining = 40;
    let remainingBytes = discoveryModelBytes;
    return harnesses.map(({ driverKind, enabled, environmentId, id, name, runtimeRevision }) => {
      const catalog = catalogs.find(
        (row) => row.environmentId === environmentId && row.harnessInstanceId === id,
      )?.catalog;
      const status = !enabled
        ? "disabled"
        : !discovery.connected(environmentId)
          ? "disconnected"
          : !discovery.canRun(environmentId, driverKind)
            ? "unavailable"
            : (catalog?.status ?? "unreported");
      const offered =
        status === "ready"
          ? catalog!.models.filter((model) => {
              const text =
                `${model.modelId} ${model.providerId} ${model.displayName} ${name} ${driverKind}`.toLowerCase();
              return (
                model.unavailableReason === undefined && query.every((word) => text.includes(word))
              );
            })
          : [];
      const focused = discovery.input.harnessInstanceId === id;
      const hash = focused
        ? createHash("sha256")
            .update(JSON.stringify({ query, status, name, driverKind, runtimeRevision, catalog }))
            .digest("hex")
        : "";
      const start = focused ? modelPageStart(discovery.input.cursor, id, hash, offered.length) : 0;
      const candidates = offered.slice(start, start + Math.min(8, remaining));
      const projected = candidates.map(({ modelId, providerId, displayName, options }) => ({
        modelId,
        providerId,
        ...(displayName === modelId ? {} : { displayName }),
        ...(options.length
          ? {
              options: options.map((option) =>
                option.type === "toggle"
                  ? {
                      id: option.id,
                      values: [false, true] as [false, true],
                      default: option.defaultValue,
                    }
                  : {
                      id: option.id,
                      values: option.values.map(({ value }) => value),
                      ...(option.defaultValue === undefined
                        ? {}
                        : { default: option.defaultValue }),
                    },
              ),
            }
          : {}),
      }));
      const shown: EnvironmentHarnessSummary["models"] = [];
      for (const model of projected) {
        const bytes = Buffer.byteLength(JSON.stringify(model));
        if (bytes > discoveryModelBytes)
          throw new OpensteerError({
            code: "resource_exhausted",
            message: `${name}: discovery options for ${model.modelId} exceed the model metadata limit`,
          });
        if (bytes > remainingBytes) break;
        shown.push(model);
        remainingBytes -= bytes;
      }
      remaining -= shown.length;
      const next = start + shown.length;
      return {
        driverKind,
        enabled,
        environmentId,
        id,
        name,
        status,
        ...(catalog?.detail && status === catalog.status && status !== "ready"
          ? { detail: catalog.detail }
          : {}),
        models: shown,
        modelsOmitted: offered.length - next,
        ...(focused && next < offered.length
          ? { modelsNextCursor: modelPageCursor(id, hash, next) }
          : {}),
      };
    });
  }
  const modelPage = selection;
  let remaining = agentInspectionModelsShown;
  return harnesses.map(({ driverKind, enabled, environmentId, id, name }) => {
    const catalog = catalogs.find(
      (record) => record.environmentId === environmentId && record.harnessInstanceId === id,
    )?.catalog;
    const offered =
      catalog?.status === "ready"
        ? catalog.models.filter((model) => model.unavailableReason === undefined)
        : [];
    const focused = modelPage?.harnessInstanceId === id;
    const catalogHash = focused
      ? createHash("sha256")
          .update(JSON.stringify({ status: catalog?.status, models: catalog?.models }))
          .digest("hex")
      : "";
    const start = focused ? modelPageStart(modelPage?.cursor, id, catalogHash, offered.length) : 0;
    const shown = offered.slice(start, start + Math.min(agentHarnessModelsShown, remaining));
    remaining -= shown.length;
    const next = start + shown.length;
    return {
      driverKind,
      enabled,
      environmentId,
      id,
      models: shown.map(({ modelId, providerId }): AgentModelSummary => ({ modelId, providerId })),
      modelsOmitted: offered.length - next,
      ...(focused && next < offered.length
        ? { modelsNextCursor: modelPageCursor(id, catalogHash, next) }
        : {}),
      name,
    };
  });
}

const ModelPageCursorSchema = z.strictObject({
  id: HarnessInstanceIdSchema,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  offset: z.number().int().min(1).max(8_192),
});

function modelPageCursor(id: HarnessInstanceId, hash: string, offset: number): string {
  return Buffer.from(JSON.stringify({ id, hash, offset }), "utf8").toString("base64url");
}

function modelPageStart(
  cursor: string | undefined,
  id: HarnessInstanceId,
  hash: string,
  offeredCount: number,
): number {
  if (!cursor) return 0;
  try {
    const parsed = ModelPageCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (
      parsed.id !== id ||
      parsed.hash !== hash ||
      parsed.offset >= offeredCount ||
      modelPageCursor(id, hash, parsed.offset) !== cursor
    )
      throw new Error("invalid cursor");
    return parsed.offset;
  } catch {
    throw badRequest(
      "Model page cursor is invalid or the engine catalog changed; start again without a cursor",
    );
  }
}

interface Wanted {
  readonly selection: ModelSelection;
  readonly unlisted: "carry" | "refuse";
}

function placementFailure(
  environment: { readonly name: string },
  wanted: Wanted,
  harnessName: string,
  catalog: HarnessInstanceCatalog | null,
): OpensteerError {
  if (!catalog) {
    return conflict(
      `${harnessName} on ${environment.name} has not reported the models it can run`,
      true,
    );
  }
  if (catalog.status !== "ready") {
    return conflict(
      `${harnessName} on ${environment.name} is not ready: ${catalog.detail}`,
      isRetryableHarnessCatalogStatus(catalog.status),
    );
  }
  const match = matchModelSelection(catalog.models, wanted.selection, wanted.unlisted);
  if (match.kind === "option-unavailable") {
    return badRequest(
      `${harnessName} on ${environment.name}: ${modelOptionUnavailableMessage(match)}`,
    );
  }
  return badRequest(
    `${harnessName} on ${environment.name} does not offer ${modelName(wanted)}; it offers ${offeredModels(catalog.models)}. Name one of those with model.`,
  );
}

/**
 * The chosen canonical pair and options travel with the work; a native id
 * does not, because the target account's catalog is the only authority on
 * what its own endpoint answers to.
 */
function placement(
  wanted: Wanted,
  target: {
    readonly harness: { readonly id: HarnessInstanceId };
    readonly model: HarnessModelDescriptor;
  },
): DelegationPlacement {
  return {
    harnessInstanceId: target.harness.id,
    modelSelection: storedModelSelection(wanted.selection, target.model),
  };
}

function modelName(wanted: Wanted): string {
  return `${wanted.selection.providerId}/${wanted.selection.modelId}`;
}

function offeredModels(models: readonly HarnessModelDescriptor[]): string {
  if (models.length === 0) return "no models";
  const shown = models
    .slice(0, offeredModelsShown)
    .map((model) => `${model.providerId}/${model.modelId}`)
    .join(", ");
  return models.length > offeredModelsShown
    ? `${shown} and ${models.length - offeredModelsShown} more`
    : shown;
}

function catalogDescription(catalog: HarnessInstanceCatalog | null, wanted: Wanted): string {
  if (!catalog) return "models not reported";
  if (catalog.status !== "ready") return `${catalog.status} (${catalog.detail})`;
  const match = matchModelSelection(catalog.models, wanted.selection, wanted.unlisted);
  if (match.kind === "option-unavailable") return modelOptionUnavailableMessage(match);
  return offeredModels(catalog.models);
}

function badRequest(message: string): OpensteerError {
  return new OpensteerError({ code: "bad_request", message });
}

function conflict(message: string, retryable = false): OpensteerError {
  return new OpensteerError({ code: "conflict", message, retryable });
}
