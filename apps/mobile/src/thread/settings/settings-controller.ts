import {
  executionMenu,
  executionAccounts,
  canContinueThreadOnPlacement,
  placementForSelection,
  type ExecutionSelection,
  type ExecutionRoute,
  type ThreadPlacementOption,
  type ThreadSummary,
} from "@opensteer/client/host";
import type { ExecutionPreferences } from "@opensteer/core";
import type { ThreadMutationOwner } from "../thread-mutation-gate.js";
export type PickerStep =
  { readonly kind: "engines"; readonly driverKind?: string } | { readonly kind: "conversation" };
export type SettingsGuardInput =
  | { readonly canRespond: boolean; readonly kind: "draft" }
  | {
      readonly canRespond: boolean;
      readonly hasRun: boolean;
      readonly kind: "thread";
      readonly mutationOwner: ThreadMutationOwner | null;
      readonly thread: ThreadSummary;
    };

export function settingsDisabledReason(input: SettingsGuardInput): string | null {
  if (input.kind === "draft") {
    return input.canRespond ? null : "Reconnect to choose thread settings.";
  }
  if (input.thread.status === "archived") return "This thread is archived.";
  if (!input.canRespond) return "Reconnect to change thread settings.";
  switch (input.mutationOwner) {
    case "message":
      return "Wait for your pending message to send before changing thread settings.";
    case "request":
      return "Wait for your response to send before changing thread settings.";
    case "settings":
      return "Updating thread settings…";
    case null:
      break;
  }
  return input.hasRun ? "Finish the current run before changing thread settings." : null;
}

export interface ModelRow {
  readonly kind: "model";
  readonly key: string;
  readonly route: ExecutionRoute;
  readonly title: string;
  readonly detail: string | null;
  readonly selected: boolean;
  readonly blockedReason: string | null;
}
export interface AccountRow {
  readonly key: string;
  readonly placement: ThreadPlacementOption;
  readonly title: string;
  readonly detail: string | null;
  readonly selected: boolean;
  readonly exhausted: boolean;
  readonly action: {
    readonly kind: "choose-model" | "refresh" | "blocked";
    readonly reason: string;
  };
}
export type ThreadModelPicker = ReturnType<typeof buildThreadModelPicker>;
export interface ThreadModelPickerInput {
  readonly placements: readonly ThreadPlacementOption[];
  readonly preferences: ExecutionPreferences;
  readonly query: string;
  readonly step: PickerStep;
  readonly subject:
    | { readonly kind: "draft"; readonly selection: ExecutionSelection | null }
    | { readonly kind: "thread"; readonly thread: ThreadSummary };
}
export function buildThreadModelPicker(input: ThreadModelPickerInput) {
  const { subject, placements } = input;
  const selection =
    subject.kind === "draft"
      ? subject.selection
      : {
          environmentId: subject.thread.environmentId,
          harnessInstanceId: subject.thread.harnessInstanceId,
          modelSelection: subject.thread.modelSelection,
        };
  const menu = executionMenu({
    placements,
    selection,
    history: input.preferences.history,
    browsing: input.step.kind === "engines" ? (input.step.driverKind ?? null) : null,
    query: input.query,
  });
  const models: ModelRow[] = (menu.results ?? menu.models).map((row) => ({
    kind: "model",
    key: row.key,
    route: row.route,
    title: row.name,
    selected: row.checked,
    blockedReason: row.route.model.unavailableReason ?? null,
    detail:
      [
        row.description,
        subject.kind === "thread" &&
        !canContinueThreadOnPlacement(subject.thread, row.route.placement)
          ? "Starts fresh here"
          : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
  }));
  const accounts: AccountRow[] = executionAccounts(placements, selection).map((row) => ({
    ...row,
    key: `${row.placement.environmentId}/${row.placement.harnessInstanceId}`,
    action: {
      kind: row.placement.available
        ? "choose-model"
        : row.placement.availability === "authentication-required" &&
            row.placement.harnessAuthenticationAllowed
          ? "refresh"
          : "blocked",
      reason: row.placement.detail,
    },
  }));
  const anchor = selection ? placementForSelection(placements, selection) : null;
  return {
    menu,
    models,
    accounts,
    currentRoute: menu.current,
    options: menu.settings,
    step: input.step,
    unavailableCurrent:
      selection && !menu.current
        ? {
            title:
              subject.kind === "thread"
                ? subject.thread.modelLabel
                : selection.modelSelection.modelId,
            detail: !anchor
              ? "Its AI account is no longer here."
              : !anchor.available
                ? anchor.detail
                : (anchor.models.find(
                    (model) =>
                      model.providerId === selection.modelSelection.providerId &&
                      model.modelId === selection.modelSelection.modelId,
                  )?.unavailableReason ?? `${anchor.accountName} no longer offers this model.`),
          }
        : null,
  };
}
