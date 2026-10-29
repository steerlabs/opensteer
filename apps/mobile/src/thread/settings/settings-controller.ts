import {
  accountFunding,
  accountStatus,
  canContinueThreadOnPlacement,
  executionEngines,
  findRoute,
  placementAccountDetail,
  placementAccountTitle,
  placementForSelection,
  recentChoices,
  routeOnAccount,
  resolveExecutionSelection,
  spansWorkLocations,
  searchRoutes,
  type ExecutionRoute,
  type ExecutionSelection,
  type ExecutionStatus,
  type ThreadPlacementOption,
  type ThreadSummary,
} from "@opensteer/client/host";
import type { ExecutionPreferences } from "@opensteer/core";
import type { HarnessModelDescriptor } from "@opensteer/protocol";
import type { ThreadMutationOwner } from "../thread-mutation-gate.js";
import { providerLabel } from "./provider-brand.js";

/** Browsing an engine or account leaves the selection untouched until a model is picked. */
export type PickerStep =
  | { readonly kind: "engines" }
  | { readonly driverKind: string; readonly kind: "accounts" }
  | {
      readonly environmentId: string;
      readonly harnessInstanceId: string;
      readonly kind: "account-models";
      readonly returnTo: "accounts" | "engines";
    };

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

export interface EngineRow {
  readonly detail: string;
  readonly key: string;
  readonly kind: "engine";
  readonly nextStep: PickerStep;
  readonly selected: boolean;
  readonly status: ExecutionStatus;
  readonly title: string;
}

export interface ModelRow {
  readonly detail: string | null;
  readonly key: string;
  readonly kind: "model";
  readonly route: ExecutionRoute;
  readonly blockedReason: string | null;
  readonly selected: boolean;
  readonly suggested: boolean;
  readonly title: string;
}

export interface UnavailableCurrentRow {
  readonly detail: string;
  readonly key: string;
  readonly kind: "unavailable";
  readonly selected: boolean;
  readonly title: string;
}

export interface AccountRow {
  readonly action:
    | { readonly kind: "blocked" | "refresh"; readonly reason: string }
    | { readonly kind: "choose-model" };
  readonly detail: string | null;
  readonly key: string;
  readonly kind: "account";
  readonly placement: ThreadPlacementOption;
  readonly selected: boolean;
  readonly status: ExecutionStatus;
  readonly title: string;
}

export type PickerRow = AccountRow | EngineRow | ModelRow | UnavailableCurrentRow;

export interface PickerSection {
  readonly id: string;
  readonly rows: readonly PickerRow[];
  readonly title: string | null;
}

export type OptionControl =
  | {
      readonly id: string;
      readonly kind: "select";
      readonly label: string;
      /** Undefined when nothing was chosen and the model declares no default. */
      readonly value: string | undefined;
      readonly valueLabel: string;
      readonly values: readonly { readonly label: string; readonly value: string }[];
    }
  | {
      readonly id: string;
      readonly kind: "toggle";
      readonly label: string;
      readonly value: boolean;
    };

export interface ThreadModelPicker {
  readonly currentRoute: ExecutionRoute | null;
  readonly emptyMessage: string | null;
  readonly lostStep: string | null;
  readonly options: readonly OptionControl[];
  readonly sections: readonly PickerSection[];
  readonly showSearch: boolean;
  readonly step: PickerStep;
  readonly subtitle: string | null;
  readonly title: string;
}

export interface ThreadModelPickerInput {
  readonly placements: readonly ThreadPlacementOption[];
  readonly preferences: ExecutionPreferences;
  readonly query: string;
  readonly step: PickerStep;
  readonly subject:
    | { readonly kind: "draft"; readonly selection: ExecutionSelection | null }
    | { readonly kind: "thread"; readonly thread: ThreadSummary };
}

export function buildThreadModelPicker(input: ThreadModelPickerInput): ThreadModelPicker {
  const { placements, preferences, subject } = input;
  const selection: ExecutionSelection | null =
    subject.kind === "draft"
      ? subject.selection
      : {
          environmentId: subject.thread.environmentId,
          harnessInstanceId: subject.thread.harnessInstanceId,
          modelSelection: subject.thread.modelSelection,
        };
  const currentRoute =
    resolveExecutionSelection(selection, placements) === null
      ? null
      : findRoute(placements, selection);
  const currentPlacement = selection === null ? null : placementForSelection(placements, selection);
  const engines = executionEngines(placements);
  const multiLocation = spansWorkLocations(placements);
  const startsFresh = (placement: ThreadPlacementOption): boolean =>
    subject.kind === "thread" && !canContinueThreadOnPlacement(subject.thread, placement);
  const accountDetail = (placement: ThreadPlacementOption): string | null =>
    joinDetail([
      placementAccountTitle(placement) === placement.accountName
        ? null
        : placementAccountTitle(placement),
      placementAccountDetail(placement),
      fundingLabels[accountFunding(placement) ?? ""] ?? null,
      multiLocation ? placement.whereLabel : null,
    ]);
  const modelRow = (route: ExecutionRoute, qualified: boolean, suggested = false): ModelRow => ({
    blockedReason: route.model.unavailableReason ?? null,
    detail: joinDetail([
      route.model.unavailableReason ?? null,
      qualified ? route.placement.accountName : (route.model.description ?? null),
      qualified ? accountDetail(route.placement) : null,
      suggested ? "Suggested" : null,
      startsFresh(route.placement) ? "Starts fresh here" : null,
    ]),
    key: `model:${route.placement.environmentId}:${route.placement.harnessInstanceId}:${route.model.providerId}:${route.model.modelId}`,
    kind: "model",
    route,
    selected:
      selection !== null &&
      samePlacement(route.placement, selection) &&
      route.model.providerId === selection.modelSelection.providerId &&
      route.model.modelId === selection.modelSelection.modelId,
    suggested,
    title: qualified
      ? `${route.placement.engineName} · ${route.model.displayName}`
      : route.model.displayName,
  });
  const accountRow = (placement: ThreadPlacementOption): AccountRow => ({
    action: !placement.available
      ? {
          kind:
            placement.availability === "authentication-required" &&
            placement.harnessAuthenticationAllowed
              ? "refresh"
              : "blocked",
          reason: placement.detail,
        }
      : placement.models.length === 0
        ? { kind: "blocked", reason: "This AI account is not reporting any models." }
        : { kind: "choose-model" },
    detail: joinDetail([
      accountDetail(placement),
      placement.defaultAccount ? "Default" : null,
      placement.available && startsFresh(placement) ? "Starts fresh here" : null,
      !placement.available
        ? placement.detail
        : placement.models.length === 0
          ? "This AI account is not reporting any models."
          : null,
    ]),
    key: `account:${placement.environmentId}:${placement.harnessInstanceId}`,
    kind: "account",
    placement,
    selected: selection !== null && samePlacement(placement, selection),
    status: accountStatus(placement),
    title: placement.accountName,
  });
  const unavailableRow = (
    chosen: ExecutionSelection,
    placement: ThreadPlacementOption | null,
    label: string,
  ): UnavailableCurrentRow => ({
    detail: joinDetail([
      placement?.accountName ?? (subject.kind === "thread" ? subject.thread.harnessLabel : null),
      placement === null
        ? "Its AI account is no longer here."
        : !placement.available
          ? placement.detail
          : (placement.models.find(
              (m) =>
                m.providerId === chosen.modelSelection.providerId &&
                m.modelId === chosen.modelSelection.modelId,
            )?.unavailableReason ?? `${placement.accountName} no longer offers this model.`),
    ])!,
    key: `unavailable:${chosen.environmentId}:${chosen.harnessInstanceId}:${chosen.modelSelection.providerId}:${chosen.modelSelection.modelId}`,
    kind: "unavailable",
    selected:
      selection !== null &&
      samePlacement(chosen, selection) &&
      chosen.modelSelection.modelId === selection.modelSelection.modelId &&
      chosen.modelSelection.providerId === selection.modelSelection.providerId,
    title: `${placement?.engineName ?? (subject.kind === "thread" ? subject.thread.harnessLabel : "Unavailable engine")} · ${label}`,
  });
  const rootSections: PickerSection[] = [];
  if (selection !== null && currentRoute === null)
    rootSections.push({
      id: "current",
      title: null,
      rows: [
        unavailableRow(
          selection,
          currentPlacement,
          subject.kind === "thread"
            ? subject.thread.modelLabel
            : (currentPlacement?.models.find(
                (m) =>
                  m.providerId === selection.modelSelection.providerId &&
                  m.modelId === selection.modelSelection.modelId,
              )?.displayName ?? selection.modelSelection.modelId),
        ),
      ],
    });
  const recent = recentChoices(placements, preferences.history);
  if (recent.length > 0)
    rootSections.push({
      id: "recent",
      title: "Recent",
      rows: recent.map((choice) =>
        choice.route === null || choice.route.model.unavailableReason
          ? unavailableRow(
              choice.selection,
              choice.placement,
              choice.selection.modelSelection.modelId,
            )
          : modelRow(choice.route, true),
      ),
    });
  rootSections.push({
    id: "engines",
    title: recent.length > 0 ? "Engines" : null,
    rows: engines.map((engine): EngineRow => {
      const available = engine.accounts.filter((p) => p.available);
      const only = available.length === 1 ? available[0] : undefined;
      return {
        detail: statusLabels[engine.status],
        key: `engine:${engine.driverKind}`,
        kind: "engine",
        nextStep: only
          ? {
              kind: "account-models",
              environmentId: only.environmentId,
              harnessInstanceId: only.harnessInstanceId,
              returnTo: "engines",
            }
          : { kind: "accounts", driverKind: engine.driverKind },
        selected: currentPlacement?.driverKind === engine.driverKind,
        status: engine.status,
        title: engine.engineName,
      };
    }),
  });
  const base: ThreadModelPicker = {
    currentRoute,
    emptyMessage: !rootSections.some((section) => section.rows.length > 0)
      ? "No AI accounts are set up on this work location."
      : null,
    lostStep: null,
    options:
      currentRoute !== null && selection !== null
        ? optionControls(currentRoute.model, selection)
        : [],
    sections: rootSections,
    showSearch: true,
    step: { kind: "engines" },
    subtitle: null,
    title: "AI",
  };
  const step = input.step;
  let view = base;
  if (step.kind === "accounts") {
    const engine = engines.find((e) => e.driverKind === step.driverKind);
    if (!engine)
      return { ...base, lostStep: "That engine is no longer offered here. Choose another." };
    view = {
      ...base,
      step,
      title: "Account",
      subtitle: engine.engineName,
      sections: [{ id: "accounts", title: null, rows: engine.accounts.map(accountRow) }],
    };
  } else if (step.kind === "account-models") {
    const placement = placementForSelection(placements, step);
    if (!placement?.available)
      return { ...base, lostStep: "That AI account is no longer available. Choose another." };
    const preferred = routeOnAccount(placement, selection, preferences.history);
    const labs = [...new Set(placement.models.map((m) => m.providerId))];
    const sections: PickerSection[] = labs.map((lab) => ({
      id: `lab:${lab}`,
      title: labs.length > 1 ? providerLabel(lab) : null,
      rows: placement.models
        .filter((m) => m.providerId === lab)
        .map((model) => modelRow({ model, placement }, false, model === preferred?.model)),
    }));
    const unavailable = placements.filter(
      (p) => p.driverKind === placement.driverKind && !p.available,
    );
    if (unavailable.length > 0)
      sections.push({
        id: "unavailable-accounts",
        title: "Unavailable accounts",
        rows: unavailable.map(accountRow),
      });
    view = {
      ...base,
      step,
      title: "Model",
      subtitle: `${placement.engineName} · ${placement.accountName}`,
      sections,
      emptyMessage: sections.some((section) => section.rows.length > 0)
        ? null
        : "This AI account is not reporting any models.",
    };
  }
  if (input.query.trim() !== "") {
    const routes = searchRoutes(placements, input.query);
    return {
      ...view,
      emptyMessage: routes.length === 0 ? "No matches" : null,
      sections: [
        { id: "search", title: "Results", rows: routes.map((route) => modelRow(route, true)) },
      ],
    };
  }
  return view;
}

const statusLabels: Record<ExecutionStatus, string> = {
  ready: "Ready",
  attention: "Needs attention",
  idle: "Waiting",
};
const fundingLabels: Readonly<Record<string, string>> = {
  plan: "Plan",
  key: "API key",
  cloud: "Cloud",
  server: "Model server",
};

function optionControls(
  model: HarnessModelDescriptor,
  selection: ExecutionSelection,
): OptionControl[] {
  return model.options.flatMap((option): OptionControl[] => {
    const chosen = selection.modelSelection.options[option.id];
    if (option.type === "toggle") {
      return [
        {
          id: option.id,
          kind: "toggle",
          label: option.label,
          value: typeof chosen === "boolean" ? chosen : option.defaultValue,
        },
      ];
    }
    // With neither a valid choice nor a declared default the provider decides,
    // so no listed value is presented as the one in force.
    const value =
      option.values.find((candidate) => candidate.value === chosen) ??
      option.values.find((candidate) => candidate.value === option.defaultValue);
    if (option.values.length === 0) return [];
    return [
      {
        id: option.id,
        kind: "select",
        label: option.label,
        value: value?.value,
        valueLabel: value?.label ?? "Default",
        values: option.values,
      },
    ];
  });
}

function joinDetail(parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null && part.length > 0);
  return present.length > 0 ? present.join(" · ") : null;
}

function samePlacement(
  left: { readonly environmentId: string; readonly harnessInstanceId: string },
  right: { readonly environmentId: string; readonly harnessInstanceId: string },
): boolean {
  return (
    left.environmentId === right.environmentId && left.harnessInstanceId === right.harnessInstanceId
  );
}
