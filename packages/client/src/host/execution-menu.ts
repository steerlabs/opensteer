import { usageLimitReached } from "./usage-notice.js";
import type { ExecutionSelection } from "./execution-preferences.js";
import {
  accountStatus,
  executionEngines,
  findRoute,
  placementAccountDetail,
  placementAccountTitle,
  placementForSelection,
  sameModel,
  samePlacement,
  searchRoutes,
  spansWorkLocations,
  type ExecutionEngine,
  type ExecutionRoute,
  type ExecutionStatus,
} from "./model-catalog.js";
import { modelSettings, type ModelSetting } from "./model-options.js";
import type { ThreadPlacementOption } from "./thread-placement.js";

/**
 * The execution menu every client draws: the person's AIs (a side list on a
 * wide screen, a row of chips on a narrow one), the models of the one being
 * looked at, and the settings of the model in force. Looking at another AI
 * changes nothing; only picking a model does.
 */

export interface ExecutionMenuEngine {
  readonly driverKind: string;
  readonly name: string;
  readonly status: ExecutionStatus;
  /** A word or two on why nothing on it can run — "Sign in", "Offline" — or null when something can. */
  readonly note: string | null;
  /** The AI the choice in force runs on. */
  readonly inUse: boolean;
}

export interface ExecutionMenuModel {
  readonly key: string;
  readonly route: ExecutionRoute;
  readonly name: string;
  /** What the model is for, as its engine describes it; for a search result, where it runs. */
  readonly description: string | null;
  readonly checked: boolean;
}

export interface ExecutionMenuInput {
  readonly placements: readonly ThreadPlacementOption[];
  readonly history: readonly ExecutionSelection[];
  /** The choice in force, whether or not it can run right now. */
  readonly selection: ExecutionSelection | null;
  /** The AI being looked at; null for the one in use, else the first that can run. */
  readonly browsing: string | null;
  readonly query?: string;
}

export interface ExecutionMenu {
  /** AIs that can run, in display order. */
  readonly ready: readonly ExecutionMenuEngine[];
  /** AIs that cannot run right now, each saying why. */
  readonly unavailable: readonly ExecutionMenuEngine[];
  readonly browsed: ExecutionMenuEngine | null;
  /** The account whose models are listed. */
  readonly account: ThreadPlacementOption | null;
  readonly models: readonly ExecutionMenuModel[];
  /** The browsed AI has no account that can run: this one says why, and is the one to fix. */
  readonly blocked: ThreadPlacementOption | null;
  /** The route in force, when it can run. */
  readonly current: ExecutionRoute | null;
  /** The settings of the route in force, while its own account is the one listed. */
  readonly settings: readonly ModelSetting[];
  /** Every engine's matching models while searching; null otherwise. */
  readonly results: readonly ExecutionMenuModel[] | null;
}

export function executionMenu(input: ExecutionMenuInput): ExecutionMenu {
  const { history, placements, selection } = input;
  const engines = executionEngines(placements);
  const current = findRoute(placements, selection);
  const anchor = selection ? placementForSelection(placements, selection) : null;
  const rows = engines.map((engine): ExecutionMenuEngine => ({
    driverKind: engine.driverKind,
    inUse: engine.driverKind === anchor?.driverKind,
    name: engine.engineName,
    note: engine.status === "ready" ? null : engineNote(engine),
    status: engine.status,
  }));
  const browsedKind =
    [input.browsing, anchor?.driverKind].find(
      (kind) => kind != null && engines.some((engine) => engine.driverKind === kind),
    ) ??
    engines.find((engine) => engine.status === "ready")?.driverKind ??
    engines[0]?.driverKind ??
    null;
  const engine = engines.find((candidate) => candidate.driverKind === browsedKind) ?? null;
  const account = engine ? listedAccount(engine, anchor, history) : null;
  const isCurrent = (route: ExecutionRoute) =>
    current !== null &&
    samePlacement(route.placement, current.placement) &&
    sameModel(route.model, current.model);
  const row = (route: ExecutionRoute, description: string | null): ExecutionMenuModel => ({
    checked: isCurrent(route),
    description,
    key: `${route.placement.environmentId}/${route.placement.harnessInstanceId}/${route.model.providerId}/${route.model.modelId}`,
    name: route.model.displayName,
    route,
  });
  const showWhere = spansWorkLocations(placements);
  const query = input.query?.trim() ?? "";
  return {
    account,
    blocked: account && !account.available ? account : null,
    browsed: rows.find((candidate) => candidate.driverKind === browsedKind) ?? null,
    current,
    models: account?.available
      ? account.models.map((model) => row({ model, placement: account }, model.description ?? null))
      : [],
    ready: rows.filter((candidate) => candidate.status === "ready"),
    results:
      query === ""
        ? null
        : searchRoutes(placements, query).map((route) =>
            row(
              route,
              [
                route.placement.engineName,
                placementAccountTitle(route.placement),
                showWhere ? route.placement.whereLabel : null,
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          ),
    settings:
      current && account && selection && samePlacement(account, current.placement)
        ? modelSettings(current.model, selection.modelSelection.options)
        : [],
    unavailable: rows.filter((candidate) => candidate.status !== "ready"),
  };
}

/** One account of the AI in force, as the conversation's account list shows it. */
export interface ExecutionAccountChoice {
  readonly placement: ThreadPlacementOption;
  readonly title: string;
  /** Plan and what is left of it, where it runs when that tells it apart, or why it cannot run. */
  readonly detail: string | null;
  readonly selected: boolean;
  /** Its plan has run out for this model until it resets. */
  readonly exhausted: boolean;
}

/**
 * The accounts the choice in force could move to: every account of its AI,
 * runnable or not. Two accounts that sign in as the same person are told
 * apart by where they run, or failing that by the names they were given.
 */
export function executionAccounts(
  placements: readonly ThreadPlacementOption[],
  selection: ExecutionSelection | null,
  now: number = Date.now(),
): ExecutionAccountChoice[] {
  const anchor = selection ? placementForSelection(placements, selection) : null;
  if (!anchor || !selection) return [];
  const accounts = placements.filter((placement) => placement.driverKind === anchor.driverKind);
  const model = selection.modelSelection;
  const titles = accounts.map(placementAccountTitle);
  const showWhere = spansWorkLocations(accounts);
  return accounts.map((placement, index) => {
    const title = titles[index] ?? placement.accountName;
    const twins = accounts.filter((_, other) => titles[other] === title);
    const where =
      showWhere || (twins.length > 1 && spansWorkLocations(twins)) ? placement.whereLabel : null;
    const name =
      twins.length > 1 && where === null && placement.accountName !== title
        ? placement.accountName
        : null;
    return {
      detail: placement.available
        ? [where, name, placementAccountDetail(placement, now, model)]
            .filter(Boolean)
            .join(" · ") || null
        : [where, placement.detail].filter(Boolean).join(" · "),
      exhausted: usageLimitReached(placement, model, now),
      placement,
      selected: samePlacement(placement, anchor),
      title,
    };
  });
}

const availabilityNotes: Readonly<Record<ThreadPlacementOption["availability"], string | null>> = {
  "authentication-required": "Sign in",
  configured: null,
  disabled: "Turned off",
  disconnected: "Offline",
  missing: "Not installed",
  preparing: "Starting",
  "runtime-check": "Checking",
  unavailable: "Unavailable",
};

/** The note of the account the engine's status comes from. */
function engineNote(engine: ExecutionEngine): string | null {
  const account =
    engine.accounts.find((candidate) => accountStatus(candidate) === engine.status) ??
    engine.accounts[0];
  return account ? (availabilityNotes[account.availability] ?? null) : null;
}

/**
 * The account whose models an AI shows: the one in force, else the one last
 * used on it, else its default — the account a model picked here runs on.
 * One that can run beats one that cannot, except the one in force, which
 * stays listed so the reason it cannot run is the thing shown.
 */
function listedAccount(
  engine: ExecutionEngine,
  anchor: ThreadPlacementOption | null,
  history: readonly ExecutionSelection[],
): ThreadPlacementOption | null {
  const find = (ref: { environmentId: string; harnessInstanceId: string } | null | undefined) =>
    ref ? engine.accounts.find((candidate) => samePlacement(candidate, ref)) : undefined;
  const lastUsed = history.map(find).find((candidate) => candidate?.available);
  return (
    find(anchor) ??
    lastUsed ??
    engine.accounts.find((candidate) => candidate.available && candidate.defaultAccount) ??
    engine.accounts.find((candidate) => candidate.available) ??
    engine.accounts[0] ??
    null
  );
}
