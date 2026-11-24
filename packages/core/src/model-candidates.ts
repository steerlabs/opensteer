import { z } from "zod";
import type { EnvironmentId, HarnessInstanceId } from "./ids.js";
import type { HarnessId, ModelSelection } from "./models.js";
import type { ModelWant } from "./background-models.js";
import { canonicalModelReference } from "./model-registry.js";
import { modelEffortOption, withModelEffort } from "./model-effort.js";
import {
  matchModelSelection,
  modelOptionUnavailableMessage,
  runModelSelection,
  storedModelSelection,
} from "./model-selection.js";

/** Structural catalog contract: protocol catalogs supply these facts without a core → protocol dependency. */
export interface SelectionModelDescriptor {
  readonly providerId: ModelSelection["providerId"];
  readonly modelId: ModelSelection["modelId"];
  readonly nativeModelId?: string | undefined;
  readonly displayName: string;
  readonly isDefault: boolean;
  readonly unavailableReason?: string | undefined;
  readonly options: readonly ({ readonly id: string } & (
    | { readonly type: "toggle"; readonly defaultValue: boolean }
    | {
        readonly type: "select";
        readonly defaultValue?: string | undefined;
        readonly values: readonly { readonly value: string; readonly label?: string }[];
      }
  ))[];
}
export interface SelectionCatalog {
  readonly status: string;
  /** Nonsecret display text for a catalog that isn't ready, such as a sign-in prompt. */
  readonly detail?: string | undefined;
  readonly models: readonly SelectionModelDescriptor[];
  readonly lightModel?:
    | (Pick<ModelSelection, "providerId" | "modelId"> & {
        readonly options?: ModelSelection["options"] | undefined;
      })
    | undefined;
}
/** Usage is normalized by the catalog owner to the connections serving each provider. */
export interface ModelUsageFact {
  readonly providerId: string;
  readonly modelId?: string;
  readonly exhausted: boolean;
  readonly resetsAt: number | null;
}
/** Only accounts the principal is currently authorized to use may enter this snapshot. */
export interface AuthorizedModelAccountSnapshot {
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly harnessRevision: number;
  readonly driverKind: HarnessId;
  readonly sourceId: string;
  readonly isDefault: boolean;
  readonly enabled: boolean;
  readonly removed: boolean;
  readonly available: boolean;
  readonly catalog: SelectionCatalog | null;
  readonly usage: readonly ModelUsageFact[];
}
export const ModelCandidateSkipReasonSchema = z.enum([
  "excluded",
  "offline",
  "disabled",
  "removed",
  "unsupported-capability",
  "unsupported-access-mode",
  "wrong-computer",
  "catalog-not-ready",
  "model-unavailable",
  "options-unavailable",
  "endpoint-binding-required",
  "unauthorized",
]);
export type ModelCandidateSkipReason = z.infer<typeof ModelCandidateSkipReasonSchema>;
export type ModelRunEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ModelCandidateSkipReason; readonly detail?: string };
export interface OriginalModelSelection {
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly modelSelection: ModelSelection;
  /** Runs record no account revision, so an arbitrary endpoint may have been replaced since. */
  readonly fromPastRun?: boolean;
}
export interface ResolvedModelCandidate {
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly harnessRevision: number;
  readonly account: AuthorizedModelAccountSnapshot;
  readonly storedModelSelection: ModelSelection;
  readonly runModelSelection: ModelSelection;
  readonly usageLimited: boolean;
  readonly original: boolean;
}
export interface SkippedModelCandidate {
  readonly want: ModelWant | null;
  readonly harnessInstanceId?: HarnessInstanceId;
  readonly environmentId?: EnvironmentId;
  readonly reason: ModelCandidateSkipReason;
  readonly detail?: string;
}
export interface ResolveModelCandidatesInput {
  readonly wants: readonly ModelWant[];
  readonly original?: OriginalModelSelection;
  readonly accounts: readonly AuthorizedModelAccountSnapshot[];
  readonly excludedAccounts: readonly HarnessInstanceId[];
  readonly canRun: (account: AuthorizedModelAccountSnapshot) => ModelRunEligibility;
  readonly now: number;
}
export function modelCandidateKey(
  candidate: Pick<
    ResolvedModelCandidate,
    "environmentId" | "harnessInstanceId" | "runModelSelection"
  >,
): string {
  const selection = candidate.runModelSelection;
  return JSON.stringify([
    candidate.environmentId,
    candidate.harnessInstanceId,
    selection.providerId,
    selection.modelId,
    Object.entries(selection.options).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
type AccountEligibilityFacts = Pick<
  AuthorizedModelAccountSnapshot,
  "harnessInstanceId" | "enabled" | "removed" | "available" | "catalog"
>;
interface AccountEligibilityInput<T> {
  readonly excludedAccounts: readonly HarnessInstanceId[];
  readonly canRun: (account: T) => ModelRunEligibility;
}
export function automaticAccountOrder<T extends { readonly isDefault: boolean }>(
  accounts: readonly T[],
): T[] {
  return [...accounts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}
export function automaticAccountEligibility<T extends AccountEligibilityFacts>(
  account: T,
  input: AccountEligibilityInput<T>,
): ModelRunEligibility {
  if (input.excludedAccounts.includes(account.harnessInstanceId))
    return { ok: false, reason: "excluded" };
  if (account.removed) return { ok: false, reason: "removed" };
  if (!account.enabled) return { ok: false, reason: "disabled" };
  if (!account.available) return { ok: false, reason: "offline" };
  const eligibility = input.canRun(account);
  if (!eligibility.ok) return eligibility;
  if (account.catalog?.status !== "ready") {
    const detail = account.catalog?.detail ?? account.catalog?.status;
    return { ok: false, reason: "catalog-not-ready", ...(detail ? { detail } : {}) };
  }
  return { ok: true };
}
export function resolveModelCandidates(input: ResolveModelCandidatesInput): {
  candidates: ResolvedModelCandidate[];
  skipped: SkippedModelCandidate[];
} {
  const skipped: SkippedModelCandidate[] = [];
  const skip = (
    account: AuthorizedModelAccountSnapshot,
    want: ModelWant | null,
    reason: ModelCandidateSkipReason,
    detail?: string,
  ) => {
    skipped.push({
      want,
      harnessInstanceId: account.harnessInstanceId,
      environmentId: account.environmentId,
      reason,
      ...(detail ? { detail } : {}),
    });
    return null;
  };
  const usable = (
    account: AuthorizedModelAccountSnapshot,
    want: ModelWant | null,
  ): account is AuthorizedModelAccountSnapshot & { readonly catalog: SelectionCatalog } => {
    const eligibility = automaticAccountEligibility(account, input);
    return eligibility.ok || (skip(account, want, eligibility.reason, eligibility.detail) ?? false);
  };
  const buildCandidate = (
    account: AuthorizedModelAccountSnapshot & { readonly catalog: SelectionCatalog },
    selection: ModelSelection,
    want: ModelWant | null,
    original: boolean,
  ): ResolvedModelCandidate | null => {
    const match = matchModelSelection(account.catalog.models, selection, "refuse");
    if (match.kind === "model-unavailable")
      return skip(account, want, "model-unavailable", match.reason);
    if (match.kind === "option-unavailable")
      return skip(account, want, "options-unavailable", modelOptionUnavailableMessage(match));
    const stored = storedModelSelection(selection, match.model);
    return {
      account,
      environmentId: account.environmentId,
      harnessInstanceId: account.harnessInstanceId,
      harnessRevision: account.harnessRevision,
      storedModelSelection: stored,
      runModelSelection: runModelSelection(stored, match.model),
      original,
      usageLimited: account.usage.some(
        (fact) =>
          fact.exhausted &&
          fact.providerId === stored.providerId &&
          (!fact.modelId || fact.modelId === stored.modelId) &&
          (fact.resetsAt === null || fact.resetsAt > input.now),
      ),
    };
  };
  const seen = new Map<string, number>();
  const candidates: ResolvedModelCandidate[] = [];
  const accounts = automaticAccountOrder(input.accounts);
  for (const want of input.wants) {
    const engine = "kind" in want ? want.driverKind : want.engine;
    const named = "kind" in want || !("account" in want) ? undefined : want.account;
    if (named && !accounts.some((account) => account.harnessInstanceId === named)) {
      skipped.push({ want, harnessInstanceId: named, reason: "unauthorized" });
      continue;
    }
    for (const account of accounts) {
      if (account.driverKind !== engine) continue;
      if (named && named !== account.harnessInstanceId) continue;
      if (account.sourceId === "openai-compatible" && !named) {
        skip(account, want, "endpoint-binding-required");
        continue;
      }
      if (!usable(account, want)) continue;
      let selection: ModelSelection;
      const exact =
        "kind" in want || want.model === undefined ? null : { ...want, model: want.model };
      if (exact === null && !("kind" in want && want.kind === "model")) {
        const light = account.catalog.lightModel;
        if (!light) {
          skip(account, want, "model-unavailable", "This account has no small model");
          continue;
        }
        selection = { ...light, options: light.options ?? {} };
      } else if (exact === null) {
        if (!("kind" in want) || want.kind !== "model") continue;
        selection = { providerId: want.providerId, modelId: want.modelId, options: {} };
      } else {
        const models = account.catalog.models;
        // The catalog's own provider/model pair is exact for any lab, listed or not.
        const pair = models.filter(
          (model) => `${model.providerId}/${model.modelId}` === exact.model,
        );
        const reference = canonicalModelReference(exact.model, account.sourceId);
        const matches = pair.length
          ? pair
          : models.filter(
              (model) =>
                model.modelId === exact.model ||
                (model.providerId === reference.providerId && model.modelId === reference.modelId),
            );
        if (matches.length > 1) {
          skip(account, want, "model-unavailable", "Ambiguous canonical model ID");
          continue;
        }
        // A bare canonical ID is portable only when this catalog identifies one lab for it.
        const matched = matches[0];
        selection = {
          providerId: matched?.providerId ?? (reference.providerId as ModelSelection["providerId"]),
          modelId: matched?.modelId ?? (reference.modelId as ModelSelection["modelId"]),
          options: {},
        };
      }
      const model = account.catalog.models.find(
        (entry) => entry.providerId === selection.providerId && entry.modelId === selection.modelId,
      );
      if (!model) {
        skip(account, want, "model-unavailable");
        continue;
      }
      if (model.unavailableReason) {
        skip(account, want, "model-unavailable", model.unavailableReason);
        continue;
      }
      const effort = "effort" in want ? want.effort : undefined;
      if (effort !== undefined) {
        const tuned = withModelEffort(selection, model, effort);
        if (!tuned) {
          const offered = modelEffortOption(model)?.values.map(({ value }) => value) ?? [];
          skip(
            account,
            want,
            "options-unavailable",
            `${model.displayName} has no ${effort} effort; it takes ${offered.join(", ")}`,
          );
          continue;
        }
        selection = tuned;
      }
      const candidate = buildCandidate(account, selection, want, false);
      if (!candidate) continue;
      const key = modelCandidateKey(candidate);
      if (seen.has(key)) continue;
      seen.set(key, candidates.length);
      candidates.push(candidate);
    }
  }
  if (input.original) {
    const own = input.original;
    const account = input.accounts.find(
      (a) => a.environmentId === own.environmentId && a.harnessInstanceId === own.harnessInstanceId,
    );
    let fallback: ResolvedModelCandidate | null = null;
    if (!account)
      skipped.push({
        want: null,
        harnessInstanceId: own.harnessInstanceId,
        environmentId: own.environmentId,
        reason: "unauthorized",
      });
    else if (own.fromPastRun && account.sourceId === "openai-compatible")
      skip(account, null, "endpoint-binding-required");
    else if (usable(account, null))
      fallback = buildCandidate(account, own.modelSelection, null, true);
    if (fallback) {
      const existing = seen.get(modelCandidateKey(fallback));
      if (existing !== undefined)
        candidates[existing] = { ...candidates[existing]!, original: true };
      else candidates.push(fallback);
    }
  }
  candidates.sort((a, b) => Number(a.usageLimited) - Number(b.usageLimited));
  return { candidates, skipped };
}
export function catalogDefaultModel<T extends SelectionModelDescriptor>(
  catalog: (Omit<SelectionCatalog, "models"> & { readonly models: readonly T[] }) | null,
): T | null {
  if (catalog?.status !== "ready") return null;
  return catalog.models.find((model) => model.isDefault && !model.unavailableReason) ?? null;
}
/** Catalog default, preserving engine defaults by leaving options unspecified. */
export function catalogDefaultModelSelection(
  catalog: SelectionCatalog | null,
): ModelSelection | null {
  const model = catalogDefaultModel(catalog);
  return model
    ? storedModelSelection(
        { providerId: model.providerId, modelId: model.modelId, options: {} },
        model,
      )
    : null;
}

export function catalogDefaultCandidate<
  T extends AccountEligibilityFacts & { readonly isDefault: boolean; readonly sourceId: string },
>(
  input: AccountEligibilityInput<T> & { readonly accounts: readonly T[] },
): { readonly account: T; readonly modelSelection: ModelSelection } | null {
  for (const account of automaticAccountOrder(input.accounts)) {
    if (account.sourceId === "openai-compatible") continue;
    if (!automaticAccountEligibility(account, input).ok) continue;
    const modelSelection = catalogDefaultModelSelection(account.catalog);
    if (modelSelection) return { account, modelSelection };
  }
  return null;
}
