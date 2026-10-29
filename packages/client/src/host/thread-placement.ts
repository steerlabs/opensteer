import type { EnvironmentSummary, HarnessSummary, ThreadSummary } from "./client.js";
import {
  harnessDisplayRank,
  harnessDriverLabel,
  ModelSelectionSchema,
  sameProviderContinuationIdentity,
  type ModelSelection,
  type ProviderContinuationIdentity,
  type ThreadAccessMode,
} from "@opensteer/core";
import type {
  HarnessModelDescriptor,
  HarnessObservedConnection,
  HarnessSetupMethod,
  HarnessSourceDescriptor,
} from "@opensteer/protocol";

type ThreadPlacementAvailability =
  | "configured"
  | "disabled"
  | "disconnected"
  | "missing"
  | "runtime-check"
  | "preparing"
  | "authentication-required"
  | "unavailable";

/**
 * One account of one AI engine on one work location, and whether a Thread can
 * run there right now. Three names travel with it: `engineName` is the engine
 * ("Codex"), `accountName` is what the person called this account of it, and
 * `whereLabel` is the work location.
 */
export interface ThreadPlacementOption {
  /**
   * The Thread access modes this engine says it can enforce here, or null when
   * it has not said — the work location is away, or the driver cannot run. The
   * Host refuses a mode absent from a declaration and refuses nothing on
   * silence, so a control reads null the same way: nothing is ruled out.
   */
  readonly accessModes: readonly ThreadAccessMode[] | null;
  /** The name the person gave this account of the engine. */
  readonly accountName: string;
  readonly available: boolean;
  readonly availability: ThreadPlacementAvailability;
  readonly continuationIdentity: ProviderContinuationIdentity | null;
  /** The account new Threads and freshly picked models use for this engine here. */
  readonly defaultAccount: boolean;
  readonly detail: string;
  readonly driverKind: string;
  /** The engine's product name — "Codex", "Claude Code". */
  readonly engineName: string;
  readonly environmentKind: EnvironmentSummary["kind"];
  readonly environmentId: string;
  /** Host-authoritative permission for signing this engine in on this exact work location. */
  readonly harnessAuthenticationAllowed: boolean;
  readonly harnessInstanceId: string;
  readonly models: readonly HarnessModelDescriptor[];
  readonly observedConnections: readonly HarnessObservedConnection[];
  readonly modelSelection: ModelSelection;
  /** Whether this exact Runner and driver can complete authentication remotely. */
  readonly setupAvailable: boolean;
  readonly setupMethods: readonly HarnessSetupMethod[];
  /**
   * Who this account talks to, as its engine declares it. Null only when the
   * Runner no longer advertises the source the account was added for — the
   * account then cannot run, and the placement says why.
   */
  readonly source: HarnessSourceDescriptor | null;
  readonly sourceId: string;
  readonly whereLabel: string;
}

/**
 * The Runner this session can prove is the computer in front of the reader,
 * as the Desktop reports it. Naming a work location "this computer" is an
 * identity claim, so it is made from the Runner id the Desktop supervises and
 * never from how an environment happens to be named.
 */
export interface LocalRunnerIdentity {
  /** What to call that computer — "This Mac" on macOS, "This computer" elsewhere. */
  readonly label: string;
  readonly runnerId: string;
}

export function threadPlacementOptions(
  environments: readonly EnvironmentSummary[],
  harnesses: readonly HarnessSummary[],
  localRunner: LocalRunnerIdentity | null = null,
): ThreadPlacementOption[] {
  const sortedEnvironments = [...environments].sort(
    (left, right) =>
      environmentRank(left) - environmentRank(right) || left.name.localeCompare(right.name),
  );
  // Engine rank, then the default account first. Within that the Host's own
  // order (creation) stands, so an account never moves because it was renamed.
  const sortedHarnesses = [...harnesses].sort(
    (left, right) =>
      harnessDisplayRank(left.driverKind) - harnessDisplayRank(right.driverKind) ||
      Number(right.isDefault) - Number(left.isDefault),
  );
  return sortedEnvironments.flatMap((environment) =>
    sortedHarnesses
      .filter((harness) => harness.environmentId === environment.id)
      .map((harness) => placementOption(environment, harness, localRunner)),
  );
}

export function compatibleThreadPlacements(
  environments: readonly EnvironmentSummary[],
  harnesses: readonly HarnessSummary[],
  localRunner: LocalRunnerIdentity | null = null,
): ThreadPlacementOption[] {
  return threadPlacementOptions(environments, harnesses, localRunner).filter(
    (option) => option.available,
  );
}

export function defaultThreadPlacement(
  environments: readonly EnvironmentSummary[],
  harnesses: readonly HarnessSummary[],
  localRunner: LocalRunnerIdentity | null = null,
): ThreadPlacementOption | undefined {
  const mainEnvironmentIds = new Set(
    environments.filter((environment) => environment.kind === "main").map(({ id }) => id),
  );
  return threadPlacementOptions(environments, harnesses, localRunner).find(
    (option) =>
      option.available && option.defaultAccount && mainEnvironmentIds.has(option.environmentId),
  );
}

/**
 * How every surface says an AI account is still getting ready on its
 * computer, as it is for a while after that computer starts. The Host holds
 * work for it until it is ready, so this is a wait, never a fault.
 */
export function accountGettingReady(subject: string): string {
  return `${subject} is getting ready`;
}

/**
 * An account to wait for while none can run, or null when none is getting
 * ready and the person has something to fix rather than wait out.
 */
export function preparingPlacement(
  placements: readonly ThreadPlacementOption[],
): ThreadPlacementOption | null {
  return placements.find(({ availability }) => availability === "preparing") ?? null;
}

/**
 * Whether the account a Thread runs on is getting ready. An offline
 * computer's account state is as old as its connection, so it is never read
 * as preparing; the computer being offline is what is said then.
 */
export function threadAccountPreparing(
  environments: readonly EnvironmentSummary[],
  thread: Pick<ThreadSummary, "environmentId" | "harnessInstanceId">,
): boolean {
  const environment = environments.find(({ id }) => id === thread.environmentId);
  return (
    environment?.connected === true &&
    environment.harnessCatalogs.some(
      (catalog) =>
        catalog.harnessInstanceId === thread.harnessInstanceId && catalog.status === "preparing",
    )
  );
}

/** Whether an existing Thread can move here without abandoning its native conversation. */
export function canContinueThreadOnPlacement(
  thread: Pick<ThreadSummaryLike, "continuationIdentity">,
  placement: Pick<ThreadPlacementOption, "continuationIdentity">,
): boolean {
  if (thread.continuationIdentity === null) return true;
  return (
    placement.continuationIdentity !== null &&
    sameProviderContinuationIdentity(thread.continuationIdentity, placement.continuationIdentity)
  );
}

interface ThreadSummaryLike {
  readonly continuationIdentity: ProviderContinuationIdentity | null;
}

export function resolveThreadPlacement(
  environments: readonly EnvironmentSummary[],
  harnesses: readonly HarnessSummary[],
  selection: { readonly environmentId?: string; readonly harnessInstanceId?: string },
  localRunner: LocalRunnerIdentity | null = null,
): ThreadPlacementOption {
  const hasEnvironment = selection.environmentId !== undefined;
  const hasHarness = selection.harnessInstanceId !== undefined;
  if (hasEnvironment !== hasHarness) {
    throw new Error("Choose both where work runs and the AI engine.");
  }
  const options = threadPlacementOptions(environments, harnesses, localRunner);
  const selected = hasEnvironment
    ? options.find(
        (option) =>
          option.environmentId === selection.environmentId &&
          option.harnessInstanceId === selection.harnessInstanceId,
      )
    : defaultThreadPlacement(environments, harnesses, localRunner);
  if (!selected) {
    throw new Error(
      "Main cannot start this Thread. Choose where work runs if another location is available.",
    );
  }
  if (!selected.available) {
    throw new Error(
      `${selected.accountName} cannot run on ${selected.whereLabel}: ${selected.detail}`,
    );
  }
  return selected;
}

function placementOption(
  environment: EnvironmentSummary,
  harness: HarnessSummary,
  localRunner: LocalRunnerIdentity | null,
): ThreadPlacementOption {
  const advertised = environment.harnessDrivers.find(
    (driver) => driver.driverKind === harness.driverKind,
  );
  const source =
    advertised?.readiness === "unavailable"
      ? null
      : (advertised?.sources.find((candidate) => candidate.sourceId === harness.sourceId) ?? null);
  const base = {
    accessModes:
      advertised && advertised.readiness !== "unavailable" ? advertised.accessModes : null,
    accountName: harness.name,
    continuationIdentity: null,
    defaultAccount: harness.isDefault,
    driverKind: harness.driverKind,
    engineName: harnessDriverLabel(harness.driverKind),
    environmentId: environment.id,
    environmentKind: environment.kind,
    harnessAuthenticationAllowed: environment.harnessAuthenticationAllowed,
    harnessInstanceId: harness.id,
    setupAvailable: false,
    observedConnections: [],
    setupMethods: [],
    source,
    sourceId: harness.sourceId,
    whereLabel: workLocationLabel(environment, localRunner),
  } as const;
  const unavailableSelection = ModelSelectionSchema.parse({
    modelId: "unavailable",
    options: {},
    providerId: "unavailable",
  });
  if (!environment.connected) {
    return {
      ...base,
      availability: "disconnected",
      available: false,
      detail: "This work location is not connected",
      models: [],
      modelSelection: unavailableSelection,
    };
  }
  if (!harness.enabled) {
    return {
      ...base,
      availability: "disabled",
      available: false,
      detail: "This AI engine is turned off",
      models: [],
      modelSelection: unavailableSelection,
    };
  }
  const catalog = environment.harnessCatalogs.find(
    (candidate) => candidate.harnessInstanceId === harness.id,
  );
  if (!advertised) {
    return {
      ...base,
      availability: "missing",
      available: false,
      detail: "This AI engine is not available here",
      models: [],
      modelSelection: unavailableSelection,
    };
  }
  if (advertised?.readiness === "unavailable") {
    return {
      ...base,
      availability: "unavailable",
      available: false,
      detail: advertised.reason,
      models: [],
      modelSelection: unavailableSelection,
    };
  }
  // The account names a source its engine no longer offers here: nothing can
  // sign it in or run it, and saying so beats a catalog that never arrives.
  if (source === null) {
    return {
      ...base,
      availability: "unavailable",
      available: false,
      detail: `${base.engineName} no longer offers the source this account was added for`,
      models: [],
      modelSelection: unavailableSelection,
    };
  }
  if (!catalog || catalog.status !== "ready") {
    return {
      ...base,
      availability:
        catalog?.status === "authentication-required"
          ? "authentication-required"
          : catalog?.status === "preparing"
            ? "preparing"
            : catalog?.status === "unavailable"
              ? "unavailable"
              : "runtime-check",
      available: false,
      detail: catalog?.detail ?? "Checking models on this work location",
      models: [],
      modelSelection: unavailableSelection,
      observedConnections: catalog?.connections ?? [],
      setupAvailable: (catalog?.setupMethods.length ?? 0) > 0,
      setupMethods: catalog?.setupMethods ?? [],
    };
  }
  const runnableModels = catalog.models.filter((model) => !model.unavailableReason);
  const defaultModel = runnableModels.find((model) => model.isDefault) ?? runnableModels[0];
  if (!defaultModel) {
    return {
      ...base,
      availability: "unavailable",
      available: false,
      // A size only the person can supply is a setting to visit, not a fault.
      detail: catalog.models.some((model) => model.needsContextWindow)
        ? "Its models need a context size. Add one in AI services on the web or desktop app."
        : (catalog.models[0]?.unavailableReason ?? "This AI engine did not report any models"),
      models: catalog.models,
      observedConnections: catalog.connections,
      setupAvailable: catalog.setupMethods.length > 0,
      setupMethods: catalog.setupMethods,
      modelSelection: unavailableSelection,
    };
  }
  return {
    ...base,
    availability: advertised?.readiness ?? "configured",
    available: true,
    continuationIdentity: catalog.continuationIdentity,
    detail:
      advertised?.note ??
      (advertised?.readiness === "runtime-check" ? "Checked when work starts" : "Ready"),
    models: runnableModels,
    modelSelection: selectionForModel(defaultModel),
    observedConnections: catalog.connections,
    setupAvailable: catalog.setupMethods.length > 0,
    setupMethods: catalog.setupMethods,
  };
}

/**
 * Builds a valid selection for a model, optionally re-seating option values
 * carried over from another selection: a carried value survives only while
 * the descriptor still accepts it. The Host rejects invalid option values
 * outright, so carried-over choices must be clamped before they go on the
 * wire.
 *
 * A selection names only what differs from the model's defaults. An option it
 * leaves out runs at whatever the engine declares when the Run starts, so a
 * default is never frozen into a Thread as though someone had chosen it — and
 * a Thread whose engine or account stops offering an option it never chose
 * keeps running.
 */
export function selectionForModel(
  model: HarnessModelDescriptor,
  carried?: ModelSelection["options"],
): ModelSelection {
  const options: Array<readonly [string, boolean | string]> = [];
  for (const option of model.options) {
    const previous = carried?.[option.id];
    const chosen =
      option.type === "toggle"
        ? typeof previous === "boolean"
          ? previous
          : undefined
        : typeof previous === "string" && option.values.some((choice) => choice.value === previous)
          ? previous
          : undefined;
    if (chosen !== undefined && chosen !== option.defaultValue) options.push([option.id, chosen]);
  }
  return ModelSelectionSchema.parse({
    modelId: model.modelId,
    options: Object.fromEntries(options),
    providerId: model.providerId,
  });
}

function environmentRank(environment: EnvironmentSummary): number {
  if (environment.kind === "main") return 0;
  if (environment.kind === "local") return 1;
  return 2;
}

function workLocationLabel(
  environment: EnvironmentSummary,
  localRunner: LocalRunnerIdentity | null,
): string {
  if (environment.kind === "main") return "Main";
  // Only the Runner the Desktop supervises earns the first-person name; every
  // other work location keeps the durable name its Runner enrolled with.
  if (localRunner && environment.runnerId === localRunner.runnerId) return localRunner.label;
  return environment.name;
}
