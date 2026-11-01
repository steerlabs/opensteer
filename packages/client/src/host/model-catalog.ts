import { canonicalJson } from "@opensteer/shared/canonicalJson";
import {
  canonicalModelReference,
  chatModelPreferences,
  harnessDisplayRank,
  modelLabLabels,
  type ModelSelection,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { HarnessModelDescriptor } from "@opensteer/protocol";
import {
  describeConnectionUsage,
  observedAccountConnection,
  type UsageModelScope,
} from "./connection-usage.js";
import type { ExecutionSelection } from "./execution-preferences.js";
import {
  selectionForModel,
  selectionForModelEffort,
  type ThreadPlacementOption,
} from "./thread-placement.js";

/**
 * The composer's picker reads the way a choice is stored: an engine, one of its
 * accounts (which fixes who serves and bills the work), and one of that
 * account's models. The same model through two engines, or through two
 * accounts of one engine, is two routes and is listed as such; nothing here
 * folds them into one row, because each runs, behaves and bills differently.
 */

/** One way to run a model: an account, and that account's descriptor of the model. */
export interface ExecutionRoute {
  readonly model: HarnessModelDescriptor;
  readonly placement: ThreadPlacementOption;
}

/**
 * How an engine or account reads at a glance: something can run on it, it
 * needs the person (a sign-in, a repair, an install), or it is waiting on
 * something outside them — its computer, a check under way, being turned off.
 */
export type ExecutionStatus = "attention" | "idle" | "ready";

/** One engine on the picker's side list, with every account of it on offer here. */
export interface ExecutionEngine {
  readonly driverKind: string;
  readonly engineName: string;
  /** Available or not, in placement order: computers first, each engine's default first. */
  readonly accounts: readonly ThreadPlacementOption[];
  readonly status: ExecutionStatus;
}

export function accountStatus(
  placement: Pick<ThreadPlacementOption, "availability" | "available">,
): ExecutionStatus {
  if (placement.available) return "ready";
  switch (placement.availability) {
    case "authentication-required":
    case "missing":
    case "unavailable":
      return "attention";
    default:
      return "idle";
  }
}

const statusRank: Readonly<Record<ExecutionStatus, number>> = { attention: 1, idle: 2, ready: 0 };

/**
 * The engines the placements offer, in the order the placements already rank
 * them, each with all of its accounts. An engine reads as well as its best
 * account: ready when any account can run, needing the person when none can
 * and one of them asks for it.
 */
export function executionEngines(placements: readonly ThreadPlacementOption[]): ExecutionEngine[] {
  const byKind = new Map<string, ThreadPlacementOption[]>();
  for (const placement of placements) {
    const accounts = byKind.get(placement.driverKind);
    if (accounts) accounts.push(placement);
    else byKind.set(placement.driverKind, [placement]);
  }
  return [...byKind.entries()]
    .map(([driverKind, accounts]) => ({
      accounts,
      driverKind,
      engineName: accounts[0]?.engineName ?? driverKind,
      status: accounts
        .map(accountStatus)
        .reduce<ExecutionStatus>(
          (best, next) => (statusRank[next] < statusRank[best] ? next : best),
          "idle",
        ),
    }))
    .sort(
      (left, right) => harnessDisplayRank(left.driverKind) - harnessDisplayRank(right.driverKind),
    );
}

/** How an account is paid for, as far as its engine said: a plan, a key, a cloud identity or a server. */
export type AccountFunding = "cloud" | "key" | "plan" | "server";

/**
 * Read from what the account reported about its own sign-in when it did, and
 * from the kind of source it was added for otherwise. Null when neither says:
 * an account that never connected has told nobody how it pays.
 */
export function accountFunding(
  placement: Pick<ThreadPlacementOption, "observedConnections" | "source">,
): AccountFunding | null {
  switch (observedAccountConnection(placement.observedConnections)?.authKind) {
    case "subscription":
      return "plan";
    case "api-key":
      return "key";
    case "cloud-identity":
      return "cloud";
    case "none":
      return "server";
    default:
      break;
  }
  switch (placement.source?.kind) {
    case "compatible-endpoint":
      return "server";
    case "cloud-identity":
      return "cloud";
    case "gateway":
      return "plan";
    default:
      return null;
  }
}

/**
 * Who a placement signs in as, in the words a person would recognise. Two
 * rules and no more: the identity the provider reported (an email, an
 * organisation) when there is one, otherwise the name the person gave the
 * account. An API key has no identity of its own, so it reads as its name,
 * and two keys can never read the same.
 */
export function placementAccountTitle(
  placement: Pick<ThreadPlacementOption, "accountName" | "observedConnections">,
): string {
  const connection = observedAccountConnection(placement.observedConnections);
  return connection?.accountLabel ?? placement.accountName;
}

/**
 * What is worth adding under the title: where the account talks to, how it is
 * paid for, and how much of the plan is left.
 */
export function placementAccountDetail(
  placement: Pick<ThreadPlacementOption, "accountName" | "observedConnections" | "source">,
  now: number = Date.now(),
  model?: UsageModelScope,
): string | null {
  const connection = observedAccountConnection(placement.observedConnections);
  const parts = [
    placement.source?.kind === "first-party" ? undefined : placement.source?.label,
    connection?.billingLabel,
    connection && placement.source?.quota === "windows"
      ? describeConnectionUsage(connection, now, model)
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Whether the placements reach more than one work location, so a route must say where it runs. */
export function spansWorkLocations(
  placements: readonly Pick<ThreadPlacementOption, "environmentId">[],
): boolean {
  return new Set(placements.map((placement) => placement.environmentId)).size > 1;
}

/** Whether two refs name the same account on the same work location. */
export function samePlacement(
  placement: Pick<ThreadPlacementOption, "environmentId" | "harnessInstanceId">,
  ref: { readonly environmentId: string; readonly harnessInstanceId: string },
): boolean {
  return (
    placement.environmentId === ref.environmentId &&
    placement.harnessInstanceId === ref.harnessInstanceId
  );
}

/** Whether two refs name the same model of the same lab. */
export function sameModel(
  left: Pick<ModelSelection, "modelId" | "providerId">,
  right: Pick<ModelSelection, "modelId" | "providerId">,
): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

/** The placement a selection names, among the ones offered, available or not. */
export function placementForSelection(
  placements: readonly ThreadPlacementOption[],
  selection: { readonly environmentId: string; readonly harnessInstanceId: string },
): ThreadPlacementOption | null {
  return placements.find((placement) => samePlacement(placement, selection)) ?? null;
}

/** The route a selection runs on, or null when its account cannot run it right now. */
export function findRoute(
  placements: readonly ThreadPlacementOption[],
  selection: ExecutionSelection | null,
): ExecutionRoute | null {
  if (!selection) return null;
  const placement = placementForSelection(placements, selection);
  if (!placement?.available) return null;
  const model = placement.models.find((candidate) =>
    sameModel(candidate, selection.modelSelection),
  );
  return model ? { model, placement } : null;
}

/**
 * Every runnable route whose words contain every word typed: the model's
 * names, native id and lab, and the engine, source, account and work location
 * that run it. A word naming an account narrows to that account's routes, so
 * searching for a work account never offers the same model on a personal one.
 */
export function searchRoutes(
  placements: readonly ThreadPlacementOption[],
  query: string,
): ExecutionRoute[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  const routes: ExecutionRoute[] = [];
  for (const placement of placements) {
    if (!placement.available) continue;
    const where = [
      placement.engineName,
      placement.driverKind,
      placement.sourceId,
      placement.source?.label ?? "",
      placement.whereLabel,
      placement.accountName,
      placementAccountTitle(placement),
    ];
    for (const model of placement.models) {
      const text = [
        model.displayName,
        model.modelId,
        model.nativeModelId ?? "",
        model.providerId,
        modelLabLabels[model.providerId] ?? "",
        ...where,
      ]
        .join("\n")
        .toLocaleLowerCase();
      if (words.every((word) => text.includes(word))) routes.push({ model, placement });
    }
  }
  return routes;
}

/** One complete earlier choice, with what it resolves to now. */
export interface RecentChoice {
  /** The account it names, as offered here. */
  readonly placement: ThreadPlacementOption;
  /** Null when that account cannot run the choice right now; it is still listed, with why. */
  readonly route: ExecutionRoute | null;
  readonly selection: ExecutionSelection;
}

/**
 * The person's latest complete choices that still name an account offered
 * here, newest first. A choice that cannot run right now stays in the list
 * with its account, so it is answered for rather than silently dropped.
 */
export function recentChoices(
  placements: readonly ThreadPlacementOption[],
  history: readonly ExecutionSelection[],
  limit = 6,
): RecentChoice[] {
  const choices: RecentChoice[] = [];
  for (const selection of history) {
    const placement = placementForSelection(placements, selection);
    if (!placement) continue;
    choices.push({ placement, route: findRoute(placements, selection), selection });
    if (choices.length === limit) break;
  }
  return choices;
}

/**
 * The selection picking a route makes. Option values come back as they last
 * were on that account for that model; a model never run there carries the
 * values in force, clamped to what it accepts. Staying on the same account and
 * model keeps the values in force.
 */
export function selectionForRoute(
  route: ExecutionRoute,
  current: ExecutionSelection | null,
  history: readonly ExecutionSelection[],
): ExecutionSelection {
  const { model, placement } = route;
  const unchanged =
    current !== null &&
    samePlacement(placement, current) &&
    sameModel(model, current.modelSelection);
  const remembered = history.find(
    (entry) => samePlacement(placement, entry) && sameModel(model, entry.modelSelection),
  );
  const options = unchanged
    ? current.modelSelection.options
    : (remembered?.modelSelection.options ?? current?.modelSelection.options);
  return {
    environmentId: placement.environmentId,
    harnessInstanceId: placement.harnessInstanceId,
    modelSelection: selectionForModel(model, options),
  };
}

/**
 * Switching to another account keeps the model in play when that account
 * offers it; otherwise the model last run on that account, otherwise its
 * default. Null when the account cannot run anything right now.
 */
export function routeOnAccount(
  placement: ThreadPlacementOption,
  current: ExecutionSelection | null,
  history: readonly ExecutionSelection[],
): ExecutionRoute | null {
  if (!placement.available) return null;
  const offered = (wanted: Pick<ModelSelection, "modelId" | "providerId"> | undefined) =>
    wanted ? placement.models.find((model) => sameModel(model, wanted)) : undefined;
  const model =
    offered(current?.modelSelection) ??
    offered(history.find((entry) => samePlacement(placement, entry))?.modelSelection) ??
    placement.models.find((candidate) => candidate.isDefault) ??
    placement.models[0];
  return model ? { model, placement } : null;
}

/**
 * Re-validates a (possibly stale) selection against the current placements:
 * the placement must be available, the model must still be in its catalog,
 * and option values are clamped to the live descriptors. Returns null when
 * the selection is no longer runnable.
 */
export function resolveExecutionSelection(
  candidate: ExecutionSelection | null | undefined,
  placements: readonly ThreadPlacementOption[],
): ExecutionSelection | null {
  if (!candidate) return null;
  const placement = placements.find(
    (option) =>
      option.available &&
      option.environmentId === candidate.environmentId &&
      option.harnessInstanceId === candidate.harnessInstanceId,
  );
  const model = placement?.models.find(
    (descriptor) =>
      !descriptor.unavailableReason &&
      descriptor.providerId === candidate.modelSelection.providerId &&
      descriptor.modelId === candidate.modelSelection.modelId,
  );
  if (!placement || !model) return null;
  return {
    environmentId: placement.environmentId,
    harnessInstanceId: placement.harnessInstanceId,
    modelSelection: selectionForModel(model, candidate.modelSelection.options),
  };
}

/**
 * The composer's execution choice, in precedence order: an explicit pick this
 * visit, else what the person chose last, else the default placement.
 *
 * A pick and a remembered choice are both decisions, not hints: when the
 * account, work location or model they name stops being runnable the answer
 * is null — the composer blocks, keeps naming the choice and says why —
 * because quietly starting work on a different account or a different machine
 * is not what the person asked for. Only option values are clamped to the live
 * descriptors, and the picker shows the values that result. The default
 * placement is consulted only when nothing was ever chosen.
 */
export function composerExecutionSelection(options: {
  readonly chosen: ExecutionSelection | null;
  readonly defaultPlacement: ThreadPlacementOption | null | undefined;
  readonly placements: readonly ThreadPlacementOption[];
  readonly remembered: ExecutionSelection | null | undefined;
}): ExecutionSelection | null {
  const decision = options.chosen ?? options.remembered ?? null;
  if (decision) return resolveExecutionSelection(decision, options.placements);
  return options.defaultPlacement ? executionSelectionForPlacement(options.defaultPlacement) : null;
}

/** The highest-ranked Chat model that any currently runnable placement serves. */
export function rankedChatExecutionSelection(
  placements: readonly ThreadPlacementOption[],
): ExecutionSelection | null {
  for (const preferred of chatModelPreferences) {
    for (const placement of placements) {
      if (!placement.available) continue;
      const model = placement.models.find((candidate) => {
        const reference = canonicalModelReference(candidate.modelId, candidate.providerId);
        return (
          reference.providerId === preferred.providerId && reference.modelId === preferred.modelId
        );
      });
      if (!model) continue;
      return {
        environmentId: placement.environmentId,
        harnessInstanceId: placement.harnessInstanceId,
        modelSelection: selectionForModelEffort(model, preferred.effort),
      };
    }
  }
  return null;
}

/**
 * Chat's one selection rule on every surface. A choice made in this visit and
 * an existing Chat's saved route are decisions, so an unavailable one blocks
 * instead of falling through. Only a genuinely new Chat takes the ranked default.
 */
export function chatExecutionSelection(options: {
  readonly chosen: ExecutionSelection | null;
  readonly existing: ExecutionSelection | null;
  readonly placements: readonly ThreadPlacementOption[];
}): ExecutionSelection | null {
  const decision = options.chosen ?? options.existing;
  if (decision) return resolveExecutionSelection(decision, options.placements);
  const ranked = rankedChatExecutionSelection(options.placements);
  if (ranked) return ranked;
  const runnable = options.placements.filter(({ available }) => available);
  return runnable.length === 1 ? executionSelectionForPlacement(runnable[0]!) : null;
}

/** Everything about a Thread that decides what sending into it will do. */
export interface ThreadExecutionRoute {
  readonly accessMode: ThreadAccessMode;
  readonly environmentId: string;
  readonly harnessInstanceId: string;
  readonly modelSelection: ModelSelection;
}

/**
 * Whether a Thread already runs the route somebody chose: the same account on
 * the same work location — the account is the engine and who pays for it — the
 * same model at the same option values, in the same access mode.
 *
 * The mode belongs here because it is the permission boundary the reader
 * agreed to: sending a Supervised message into a Full-access conversation is
 * not the act they asked for. So does the reasoning level, for the same reason
 * the picker shows it.
 *
 * Option values are compared as the live descriptor normalizes them, so a
 * Thread that spelled out a model's own default and a choice that left it out
 * are one route rather than two; with that account's catalog absent they are
 * compared as they stand. `nativeModelId` is never compared — the Host fills
 * it in from the catalog, so it says nothing about what anyone chose.
 */
export function runsChosenExecution(
  thread: ThreadExecutionRoute,
  chosen: { readonly accessMode: ThreadAccessMode; readonly selection: ExecutionSelection },
  placements: readonly ThreadPlacementOption[],
): boolean {
  const { modelSelection } = chosen.selection;
  if (
    thread.accessMode !== chosen.accessMode ||
    thread.environmentId !== chosen.selection.environmentId ||
    thread.harnessInstanceId !== chosen.selection.harnessInstanceId ||
    thread.modelSelection.providerId !== modelSelection.providerId ||
    thread.modelSelection.modelId !== modelSelection.modelId
  ) {
    return false;
  }
  const descriptor = placements
    .find(
      (placement) =>
        placement.environmentId === thread.environmentId &&
        placement.harnessInstanceId === thread.harnessInstanceId,
    )
    ?.models.find(
      (model) =>
        model.providerId === modelSelection.providerId && model.modelId === modelSelection.modelId,
    );
  const normalized = (values: ModelSelection["options"]): string =>
    canonicalJson(descriptor ? selectionForModel(descriptor, values).options : values);
  return normalized(thread.modelSelection.options) === normalized(modelSelection.options);
}

/** The default selection a placement offers (its default model, default options). */
export function executionSelectionForPlacement(
  placement: ThreadPlacementOption,
): ExecutionSelection {
  return {
    environmentId: placement.environmentId,
    harnessInstanceId: placement.harnessInstanceId,
    modelSelection: placement.modelSelection,
  };
}
