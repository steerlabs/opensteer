import {
  automaticAccountEligibility,
  automaticModelDefaults,
  automaticModelWants,
  modelLabLabels,
  resolveModelCandidates,
  type AuthorizedModelAccountSnapshot,
  type AutomaticModelConfig,
  type EnvironmentId,
  type HarnessInstanceId,
  type ModelRunEligibility,
  type ModelSelection,
  type ModelUsageFact,
  type ModelWant,
  type OriginalModelSelection,
  type ResolvedModelCandidate,
  type SkippedModelCandidate,
  type ThreadAccessMode,
  type UserId,
} from "@opensteer/core";
import type { HarnessInstanceRecord, OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import {
  automaticModelCatalogView,
  type AutomaticModelsView,
  type HarnessInstanceCatalog,
} from "@opensteer/protocol";

export interface AutomaticModelDependencies {
  readonly store: Pick<
    OpensteerStore,
    | "getAutomaticModelConfig"
    | "listEnvironmentsForUser"
    | "listHarnessInstances"
    | "listHarnessCatalogs"
  >;
  readonly runners: Pick<RunnerRegistry, "isAvailable">;
}
export type ModelRunPredicate = (account: AuthorizedModelAccountSnapshot) => ModelRunEligibility;
type Runners = Pick<
  RunnerRegistry,
  "canRunHarness" | "harnessAccessModes" | "identityForEnvironment"
>;

const ok: ModelRunEligibility = { ok: true };

export function backgroundTextSupport(
  runners: Pick<Runners, "canRunHarness" | "identityForEnvironment">,
): ModelRunPredicate {
  return (account) =>
    runners
      .identityForEnvironment(account.environmentId)
      ?.capabilities.includes("background-text-v1") &&
    runners.canRunHarness(account.environmentId, account.driverKind)
      ? ok
      : { ok: false, reason: "unsupported-capability" };
}

export function workspaceExecution(
  runners: Pick<Runners, "canRunHarness" | "harnessAccessModes">,
  boundary: { readonly environmentId: EnvironmentId; readonly accessMode: ThreadAccessMode },
): ModelRunPredicate {
  return (account) =>
    account.environmentId !== boundary.environmentId
      ? { ok: false, reason: "wrong-computer" }
      : !runners.canRunHarness(account.environmentId, account.driverKind)
        ? { ok: false, reason: "unsupported-capability" }
        : runners
              .harnessAccessModes(account.environmentId, account.driverKind)
              ?.includes(boundary.accessMode)
          ? ok
          : { ok: false, reason: "unsupported-access-mode" };
}

/** Nonsecret: an endpoint URL carries no credentials, and changing it advances the revision. */
function sourceBoundary(harness: HarnessInstanceRecord): string {
  const config = harness.config as { readonly baseUrl?: unknown } | null;
  return JSON.stringify([
    harness.sourceId,
    typeof config?.baseUrl === "string" ? config.baseUrl : null,
  ]);
}

function usageFacts(catalog: HarnessInstanceCatalog | null): ModelUsageFact[] {
  if (!catalog) return [];
  const providers = new Set(catalog.models.map((model) => model.providerId));
  return [...providers].flatMap((providerId) =>
    catalog.connections
      .filter(
        (connection) =>
          connection.connectionSlot === "primary" || connection.connectionSlot === providerId,
      )
      .flatMap(({ usage }): ModelUsageFact[] => {
        if (!usage) return [];
        if (usage.windows.length === 0)
          return usage.limitReached ? [{ providerId, exhausted: true, resetsAt: null }] : [];
        return usage.windows.flatMap((window): ModelUsageFact[] => {
          if (window.usedPercent < 100) return [];
          const resetsAt = window.resetsAt === null ? null : Date.parse(window.resetsAt);
          if (window.scope?.kind !== "model") return [{ providerId, exhausted: true, resetsAt }];
          return window.scope.providerId === providerId
            ? [{ providerId, modelId: window.scope.modelId, exhausted: true, resetsAt }]
            : [];
        });
      }),
  );
}

export type HostModelAccount = AuthorizedModelAccountSnapshot & {
  readonly catalog: HarnessInstanceCatalog | null;
};
export interface AuthorizedModelAccounts {
  readonly accounts: readonly HostModelAccount[];
  readonly harnesses: readonly HarnessInstanceRecord[];
  readonly environments: readonly { readonly id: EnvironmentId; readonly name: string }[];
}

export async function readAuthorizedModelAccounts(
  { store, runners }: AutomaticModelDependencies,
  userId: UserId,
): Promise<AuthorizedModelAccounts> {
  const environments = await store.listEnvironmentsForUser(userId);
  const environmentIds = environments.map((environment) => environment.id);
  const [harnesses, catalogs] = await Promise.all([
    store.listHarnessInstances({ environmentIds }),
    store.listHarnessCatalogs(environmentIds),
  ]);
  const accounts = harnesses.map((harness): HostModelAccount => {
    const catalog =
      catalogs.find(
        (record) =>
          record.harnessInstanceId === harness.id && record.environmentId === harness.environmentId,
      )?.catalog ?? null;
    return {
      environmentId: harness.environmentId,
      harnessInstanceId: harness.id,
      harnessRevision: harness.runtimeRevision,
      driverKind: harness.driverKind,
      sourceId: harness.sourceId,
      sourceBoundary: sourceBoundary(harness),
      isDefault: harness.isDefault,
      enabled: harness.enabled,
      removed: harness.removedAt !== null,
      available: runners.isAvailable(harness.environmentId),
      catalog,
      usage: usageFacts(catalog),
    };
  });
  return { accounts, harnesses, environments };
}

/** A Thread's own model as an original: revalidated against the account as it is now. */
export interface OriginalPlacement {
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly modelSelection: ModelSelection;
}
function originalSelection(
  accounts: readonly AuthorizedModelAccountSnapshot[],
  placement: OriginalPlacement,
): OriginalModelSelection {
  const account = accounts.find(
    (candidate) =>
      candidate.environmentId === placement.environmentId &&
      candidate.harnessInstanceId === placement.harnessInstanceId,
  );
  // An account outside this person's authority resolves as unauthorized.
  return {
    ...placement,
    harnessRevision: account?.harnessRevision ?? 0,
    sourceBoundary: account?.sourceBoundary ?? "",
  };
}

export interface AutomaticModelRequest {
  readonly userId: UserId;
  readonly wants: (config: AutomaticModelConfig) => readonly ModelWant[];
  readonly original?: OriginalPlacement | undefined;
  readonly canRun: ModelRunPredicate;
}
export interface AutomaticModelResolution extends AuthorizedModelAccounts {
  readonly config: AutomaticModelConfig;
  readonly candidates: readonly ResolvedModelCandidate[];
  readonly skipped: readonly SkippedModelCandidate[];
}

function readAutomaticModelInputs(dependencies: AutomaticModelDependencies, userId: UserId) {
  return Promise.all([
    dependencies.store.getAutomaticModelConfig(userId),
    readAuthorizedModelAccounts(dependencies, userId),
  ]);
}

function resolveWithin(
  config: AutomaticModelConfig,
  snapshot: AuthorizedModelAccounts,
  request: Omit<AutomaticModelRequest, "userId">,
): AutomaticModelResolution {
  const resolved = resolveModelCandidates({
    wants: request.wants(config),
    ...(request.original
      ? { original: originalSelection(snapshot.accounts, request.original) }
      : {}),
    accounts: snapshot.accounts,
    excludedAccounts: config.excludedAccounts,
    canRun: request.canRun,
    now: Date.now(),
  });
  return { ...snapshot, config, ...resolved };
}

/** Every automatic site resolves through here: the person's config over their own accounts. */
export async function resolveAutomaticModels(
  dependencies: AutomaticModelDependencies,
  request: AutomaticModelRequest,
): Promise<AutomaticModelResolution> {
  const [config, snapshot] = await readAutomaticModelInputs(dependencies, request.userId);
  return resolveWithin(config, snapshot, request);
}

/**
 * Settings' view for one person. Light is the general preference: naming and
 * memory each add their own requirements when they run. Deep runs only memory,
 * so it previews within Main's computer and access mode, ending with Chat.
 */
export async function readAutomaticModelPreview(
  dependencies: AutomaticModelDependencies & {
    readonly store: Pick<OpensteerStore, "findMainWorkspaceForOwner" | "getThreadForOwner">;
    readonly runners: Pick<Runners, "canRunHarness" | "harnessAccessModes">;
  },
  userId: UserId,
): Promise<AutomaticModelsView> {
  const { store, runners } = dependencies;
  const main = await store.findMainWorkspaceForOwner(userId);
  const chat = main?.homeThreadId ? await store.getThreadForOwner(main.homeThreadId, userId) : null;
  const memory =
    main?.backing.kind === "local-directory" && chat
      ? {
          canRun: workspaceExecution(runners, {
            environmentId: main.backing.ownerEnvironmentId,
            accessMode: chat.accessMode,
          }),
          original: chat,
        }
      : { canRun: () => ok };
  const [config, snapshot] = await readAutomaticModelInputs(dependencies, userId);
  const light = resolveWithin(config, snapshot, {
    wants: (current) => automaticModelWants(current, "light"),
    canRun: () => ok,
  });
  const deep = resolveWithin(config, snapshot, {
    wants: (current) => automaticModelWants(current, "deep"),
    ...memory,
  });
  const { accounts, harnesses, environments } = snapshot;
  const names = (environmentId?: EnvironmentId, harnessInstanceId?: HarnessInstanceId) => {
    const account = accounts.find(
      (candidate) =>
        candidate.environmentId === environmentId &&
        candidate.harnessInstanceId === harnessInstanceId,
    );
    const harness = harnesses.find((candidate) => candidate.id === harnessInstanceId);
    const environment = environments.find((candidate) => candidate.id === environmentId);
    return account && harness && environment
      ? { account, accountDisplayName: harness.name, computerDisplayName: environment.name }
      : undefined;
  };
  const modelNames = (
    account: HostModelAccount | undefined,
    modelId: string,
    providerId?: string,
  ) => {
    const model = account?.catalog?.models.find(
      (candidate) =>
        candidate.modelId === modelId &&
        (providerId === undefined || candidate.providerId === providerId),
    );
    const lab = providerId ?? model?.providerId;
    return {
      ...(lab ? { providerDisplayName: modelLabLabels[lab] ?? lab } : {}),
      modelDisplayName: model?.displayName ?? modelId,
    };
  };
  const preview = ({ candidates, skipped }: AutomaticModelResolution) => ({
    candidates: candidates.map(
      ({ account: _snapshot, runModelSelection: _run, storedModelSelection, ...candidate }) => {
        const { account, ...own } = names(candidate.environmentId, candidate.harnessInstanceId)!;
        const { providerId, modelId } = storedModelSelection;
        return {
          ...candidate,
          ...own,
          modelSelection: storedModelSelection,
          providerDisplayName: modelLabLabels[providerId] ?? providerId,
          modelDisplayName: modelNames(account, modelId, providerId).modelDisplayName,
        };
      },
    ),
    skipped: skipped.map((skip) => {
      const own = names(skip.environmentId, skip.harnessInstanceId);
      if (!own) return skip;
      const { account, ...display } = own;
      const want = skip.want;
      return {
        ...skip,
        ...display,
        // A catalog-light rank or an engine-only want names no model of its own.
        ...(want === null
          ? {}
          : "model" in want
            ? modelNames(account, want.model)
            : "kind" in want && want.kind === "model"
              ? modelNames(account, want.modelId, want.providerId)
              : {}),
      };
    }),
  });
  return {
    config,
    maintainedDefaults: {
      light: [...automaticModelDefaults.light],
      deep: [...automaticModelDefaults.deep],
    },
    accounts: accounts.map((account) => {
      const eligibility = automaticAccountEligibility(account, {
        excludedAccounts: config.excludedAccounts,
        canRun: () => ok,
      });
      const { accountDisplayName, computerDisplayName } = names(
        account.environmentId,
        account.harnessInstanceId,
      )!;
      return {
        harnessInstanceId: account.harnessInstanceId,
        environmentId: account.environmentId,
        accountDisplayName,
        computerDisplayName,
        driverKind: account.driverKind,
        harnessRevision: account.harnessRevision,
        sourceId: account.sourceId,
        isDefault: account.isDefault,
        enabled: account.enabled,
        removed: account.removed,
        available: account.available,
        catalog: automaticModelCatalogView(account.catalog),
        eligible: eligibility.ok,
        reason: eligibility.ok ? null : eligibility.reason,
      };
    }),
    light: { label: "General preference", ...preview(light) },
    deep: preview(deep),
  };
}
