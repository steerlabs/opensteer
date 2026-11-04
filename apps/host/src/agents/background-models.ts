import {
  backgroundModelRankings,
  type BackgroundModelMode,
  type BackgroundModelPreferences,
  type BackgroundModelRole,
  type EnvironmentId,
  type HarnessId,
  type HarnessInstanceId,
  type ModelSelection,
  type ResolvedBackgroundCandidate,
} from "@opensteer/core";
import type { HarnessInstanceCatalog, HarnessObservedUsage } from "@opensteer/protocol";
import { matchModelSelection, runModelSelection } from "./model-selection.js";

/** Accounts must already be authorized for the principal and execution boundary. */
export interface BackgroundAccountSnapshot {
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly harnessRevision: number;
  readonly driverKind: HarnessId;
  readonly available: boolean;
  readonly canRun: boolean;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly catalog: HarnessInstanceCatalog | null;
  /** Only connections that serve this provider, supplied by the catalog owner. */
  readonly usageByProvider: Readonly<Record<string, readonly HarnessObservedUsage[]>>;
}
export interface BackgroundResolutionInput {
  readonly accounts: readonly BackgroundAccountSnapshot[];
  readonly preferences: BackgroundModelPreferences;
  readonly ownProviderId?: string;
  readonly originatingEnvironmentId?: EnvironmentId;
  readonly taskModelFallback?: ResolvedBackgroundCandidate;
  readonly now: number;
}
export type BackgroundCandidateSkipReason =
  | "consent-required"
  | "offline"
  | "unsupported"
  | "disabled"
  | "catalog-not-ready"
  | "model-unavailable"
  | "option-unavailable"
  | "usage-limit";
export interface BackgroundCandidateDecision {
  readonly candidate: ResolvedBackgroundCandidate;
  readonly skipReason: BackgroundCandidateSkipReason | null;
}
/** One account's one model with its options: what a repeated attempt would run again. */
export function backgroundCandidateKey(
  candidate: Pick<
    ResolvedBackgroundCandidate,
    "environmentId" | "harnessInstanceId" | "modelSelection"
  >,
) {
  return JSON.stringify([
    candidate.environmentId,
    candidate.harnessInstanceId,
    candidate.modelSelection.providerId,
    candidate.modelSelection.modelId,
    Object.entries(candidate.modelSelection.options).sort(),
  ]);
}
function usageLimited(account: BackgroundAccountSnapshot, model: ModelSelection, now: number) {
  return (account.usageByProvider[model.providerId] ?? []).some((usage) => {
    const windows = usage.windows.filter(
      (window) =>
        (!window.scope ||
          window.scope.kind === "account" ||
          (window.scope.providerId === model.providerId &&
            window.scope.modelId === model.modelId)) &&
        (window.resetsAt === null || Date.parse(window.resetsAt) > now),
    );
    return (
      windows.some((window) => window.usedPercent >= 100) ||
      (usage.limitReached && usage.windows.length === 0)
    );
  });
}
/** Shared with Settings so the displayed skips are exactly the admission skips. */
export function inspectBackgroundCandidates(
  role: BackgroundModelRole,
  input: BackgroundResolutionInput,
): BackgroundCandidateDecision[] {
  const accounts = [...input.accounts].sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      Number(b.environmentId === input.originatingEnvironmentId) -
        Number(a.environmentId === input.originatingEnvironmentId) ||
      a.environmentId.localeCompare(b.environmentId) ||
      a.harnessInstanceId.localeCompare(b.harnessInstanceId),
  );
  const mode: BackgroundModelMode = input.preferences.backgroundModels[role];
  const decisions: BackgroundCandidateDecision[] = [];
  const seen = new Set<string>();
  const add = (
    account: BackgroundAccountSnapshot,
    selection: ModelSelection,
    reason: ResolvedBackgroundCandidate["reason"],
  ) => {
    const match = matchModelSelection(
      account.catalog?.status === "ready" ? account.catalog.models : [],
      selection,
      "refuse",
    );
    const modelSelection =
      match.kind === "offered" ? runModelSelection(selection, match.model) : selection;
    const key = backgroundCandidateKey({ ...account, modelSelection });
    // The task's own model always closes the list; its user drops repeats of what it tried.
    if (seen.has(key) && reason !== "task-model") return;
    seen.add(key);
    const skipReason: BackgroundCandidateSkipReason | null = !account.enabled
      ? "disabled"
      : !account.available
        ? "offline"
        : !account.canRun
          ? "unsupported"
          : account.catalog?.status !== "ready"
            ? "catalog-not-ready"
            : match.kind !== "offered"
              ? match.kind
              : selection.providerId !== input.ownProviderId &&
                  !input.preferences.backgroundProviderConsent.includes(selection.providerId)
                ? "consent-required"
                : usageLimited(account, selection, input.now)
                  ? "usage-limit"
                  : null;
    decisions.push({
      candidate: {
        environmentId: account.environmentId,
        harnessInstanceId: account.harnessInstanceId,
        harnessRevision: account.harnessRevision,
        modelSelection,
        reason,
      },
      skipReason,
    });
  };
  if (mode.kind === "pinned") {
    const account = accounts.find(
      (a) =>
        a.environmentId === mode.selection.environmentId &&
        a.harnessInstanceId === mode.selection.harnessInstanceId,
    );
    if (account) add(account, mode.selection.modelSelection, "pinned");
  }
  for (const rank of backgroundModelRankings[role])
    for (const account of accounts) {
      if (account.driverKind !== rank.driverKind) continue;
      if (rank.kind === "model")
        add(
          account,
          { providerId: rank.providerId, modelId: rank.modelId, options: rank.options },
          "ranked",
        );
      else if (account.catalog?.status === "ready" && account.catalog.lightModel)
        add(
          account,
          { ...account.catalog.lightModel, options: account.catalog.lightModel.options ?? {} },
          "ranked",
        );
    }
  if (input.taskModelFallback) {
    const fallback = input.taskModelFallback;
    const account = accounts.find(
      (a) =>
        a.environmentId === fallback.environmentId &&
        a.harnessInstanceId === fallback.harnessInstanceId,
    );
    if (account) add(account, fallback.modelSelection, "task-model");
  }
  return decisions;
}
export function resolveBackgroundCandidates(
  role: BackgroundModelRole,
  input: BackgroundResolutionInput,
): ResolvedBackgroundCandidate[] {
  return inspectBackgroundCandidates(role, input)
    .filter((decision) => decision.skipReason === null)
    .map((decision) => decision.candidate);
}
