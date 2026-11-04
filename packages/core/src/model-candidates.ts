import { z } from "zod";
import type { EnvironmentId, HarnessInstanceId } from "./ids.js";
import type { HarnessId, ModelSelection } from "./models.js";
import type { ModelWant } from "./background-models.js";
import { canonicalModelReference } from "./model-registry.js";
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
        readonly values: readonly { readonly value: string }[];
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
  /** Nonsecret endpoint identity; account revision must also change when this changes. */
  readonly sourceBoundary: string;
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
  "endpoint-changed",
  "unauthorized",
]);
export type ModelCandidateSkipReason = z.infer<typeof ModelCandidateSkipReasonSchema>;
export type ModelRunEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ModelCandidateSkipReason; readonly detail?: string };
export interface OriginalModelSelection {
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly harnessRevision: number;
  readonly sourceBoundary: string;
  readonly modelSelection: ModelSelection;
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
  const canonical = canonicalModelReference(selection.modelId, selection.providerId);
  return JSON.stringify([
    candidate.environmentId,
    candidate.harnessInstanceId,
    canonical.providerId,
    canonical.modelId,
    Object.entries(selection.options).sort(([a], [b]) => a.localeCompare(b)),
  ]);
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
  /** Account-level eligibility, checked before anything about a model. */
  const usable = (
    account: AuthorizedModelAccountSnapshot,
    want: ModelWant | null,
  ): account is AuthorizedModelAccountSnapshot & { readonly catalog: SelectionCatalog } => {
    if (input.excludedAccounts.includes(account.harnessInstanceId))
      return skip(account, want, "excluded") ?? false;
    if (account.removed) return skip(account, want, "removed") ?? false;
    if (!account.enabled) return skip(account, want, "disabled") ?? false;
    if (!account.available) return skip(account, want, "offline") ?? false;
    const eligibility = input.canRun(account);
    if (!eligibility.ok)
      return skip(account, want, eligibility.reason, eligibility.detail) ?? false;
    if (account.catalog?.status !== "ready")
      return (
        skip(
          account,
          want,
          "catalog-not-ready",
          account.catalog?.detail ?? account.catalog?.status,
        ) ?? false
      );
    return true;
  };
  const inspect = (
    account: AuthorizedModelAccountSnapshot,
    selection: ModelSelection,
    want: ModelWant | null,
    original: boolean,
  ): ResolvedModelCandidate | null => {
    if (!usable(account, want)) return null;
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
  let original: ResolvedModelCandidate | null = null;
  if (input.original) {
    const own = input.original;
    const account = input.accounts.find(
      (a) => a.environmentId === own.environmentId && a.harnessInstanceId === own.harnessInstanceId,
    );
    if (!account)
      skipped.push({
        want: null,
        harnessInstanceId: own.harnessInstanceId,
        reason: "unauthorized",
      });
    else if (
      account.harnessRevision !== own.harnessRevision ||
      account.sourceBoundary !== own.sourceBoundary
    )
      skipped.push({
        want: null,
        harnessInstanceId: own.harnessInstanceId,
        reason: "endpoint-changed",
      });
    else original = inspect(account, own.modelSelection, null, true);
  }
  const seen = new Set<string>(original ? [modelCandidateKey(original)] : []);
  const candidates: ResolvedModelCandidate[] = [];
  const accounts = [...input.accounts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  for (const want of input.wants)
    for (const account of accounts) {
      const engine = "kind" in want ? want.driverKind : want.engine;
      if (account.driverKind !== engine) continue;
      if (
        !("kind" in want) &&
        want.harnessInstanceId &&
        want.harnessInstanceId !== account.harnessInstanceId
      )
        continue;
      if (account.sourceId === "openai-compatible" && ("kind" in want || !want.harnessInstanceId)) {
        skipped.push({
          want,
          harnessInstanceId: account.harnessInstanceId,
          reason: "endpoint-binding-required",
        });
        continue;
      }
      let selection: ModelSelection;
      if ("kind" in want) {
        if (want.kind === "catalog-light") {
          if (!usable(account, want)) continue;
          const light = account.catalog.lightModel;
          if (!light) {
            skip(account, want, "model-unavailable", "This account has no small model");
            continue;
          }
          selection = { ...light, options: light.options ?? {} };
        } else
          selection = { providerId: want.providerId, modelId: want.modelId, options: want.options };
      } else {
        const reference = canonicalModelReference(want.model, account.driverKind);
        const matches = (account.catalog?.models ?? []).filter(
          (model) =>
            model.modelId === want.model ||
            (model.providerId === reference.providerId && model.modelId === reference.modelId),
        );
        // A bare canonical ID is portable only when this catalog identifies one lab for it.
        const model = matches.length === 1 ? matches[0] : undefined;
        selection = {
          providerId: model?.providerId ?? (reference.providerId as ModelSelection["providerId"]),
          modelId: model?.modelId ?? (reference.modelId as ModelSelection["modelId"]),
          options: want.options ?? {},
        };
        if (matches.length > 1) {
          skipped.push({
            want,
            harnessInstanceId: account.harnessInstanceId,
            reason: "model-unavailable",
            detail: "Ambiguous canonical model ID",
          });
          continue;
        }
      }
      const candidate = inspect(account, selection, want, false);
      if (!candidate) continue;
      const key = modelCandidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  candidates.sort((a, b) => Number(a.usageLimited) - Number(b.usageLimited));
  if (original) candidates.push(original);
  return { candidates, skipped };
}
/** Catalog default, preserving engine defaults by leaving options unspecified. */
export function catalogDefaultModelSelection(
  catalog: SelectionCatalog | null,
): ModelSelection | null {
  if (catalog?.status !== "ready") return null;
  const model = catalog.models.find((model) => model.isDefault && !model.unavailableReason);
  return model
    ? storedModelSelection(
        { providerId: model.providerId, modelId: model.modelId, options: {} },
        model,
      )
    : null;
}
