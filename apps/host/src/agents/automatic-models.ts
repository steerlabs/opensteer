import {
  backgroundModelWants,
  DEFAULT_THREAD_ACCESS_MODE,
  excludedBackgroundAccounts,
  ExecutionPreferencesSchema,
  modelEffortLabel,
  resolveModelCandidates,
  type AgentHomeSettings,
  type AuthorizedModelAccountSnapshot,
  type EnvironmentId,
  type ModelRunEligibility,
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
  usageWindowAppliesToProvider,
  usageWindowIsAccountWide,
  type AutomaticModelsView,
  type HarnessInstanceCatalog,
} from "@opensteer/protocol";
export interface AutomaticModelDependencies {
  readonly store: Pick<
    OpensteerStore,
    | "getAgentHomeSettings"
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
const ok: ModelRunEligibility = {
  ok: true,
};
export function backgroundTextSupport(
  runners: Pick<Runners, "canRunHarness" | "identityForEnvironment">,
): ModelRunPredicate {
  return (account) =>
    runners
      .identityForEnvironment(account.environmentId)
      ?.capabilities.includes("background-text-v1") &&
    runners.canRunHarness(account.environmentId, account.driverKind)
      ? ok
      : {
          ok: false,
          reason: "unsupported-capability",
        };
}
export function personalExecution(
  runners: Pick<Runners, "canRunHarness" | "harnessAccessModes">,
  boundary: {
    readonly environmentId: EnvironmentId;
    readonly accessMode: ThreadAccessMode;
  },
): ModelRunPredicate {
  return (account) =>
    account.environmentId !== boundary.environmentId
      ? {
          ok: false,
          reason: "wrong-computer",
        }
      : !runners.canRunHarness(account.environmentId, account.driverKind)
        ? {
            ok: false,
            reason: "unsupported-capability",
          }
        : runners
              .harnessAccessModes(account.environmentId, account.driverKind)
              ?.includes(boundary.accessMode)
          ? ok
          : {
              ok: false,
              reason: "unsupported-access-mode",
            };
}
function usageFacts(catalog: HarnessInstanceCatalog | null): ModelUsageFact[] {
  if (!catalog) return [];
  const providers = new Set(catalog.models.map((model) => model.providerId));
  return [...providers].flatMap((providerId) =>
    catalog.connections
      .filter(
        (connection) =>
          connection.status === "connected" &&
          (connection.connectionSlot === "primary" || connection.connectionSlot === providerId),
      )
      .flatMap(({ usage }): ModelUsageFact[] => {
        if (!usage) return [];
        const applicable = usage.windows.filter((window) =>
          usageWindowAppliesToProvider(window, providerId),
        );
        const exhaustedWindows = applicable.flatMap((window): ModelUsageFact[] => {
          if (window.usedPercent < 100) return [];
          const parsedReset = window.resetsAt === null ? null : Date.parse(window.resetsAt);
          const resetsAt =
            parsedReset !== null && Number.isFinite(parsedReset) ? parsedReset : null;
          if (window.scope?.kind === "model") {
            return [
              {
                providerId,
                modelId: window.scope.modelId,
                exhausted: true,
                resetsAt,
              },
            ];
          }
          return [
            {
              providerId,
              exhausted: true,
              resetsAt,
            },
          ];
        });
        // Account-wide `limitReached` is explained by exhausted account-wide windows
        // (whose reset timestamps age it out automatically). Only when no account-wide
        // window is exhausted does the flag stand independently as a windowless block.
        const hasExhaustedAccountWindow = usage.windows.some(
          (window) => usageWindowIsAccountWide(window) && window.usedPercent >= 100,
        );
        if (usage.limitReached && !hasExhaustedAccountWindow) {
          return [
            ...exhaustedWindows,
            {
              providerId,
              exhausted: true,
              resetsAt: null,
            },
          ];
        }
        return exhaustedWindows;
      }),
  );
}
export type HostModelAccount = AuthorizedModelAccountSnapshot & {
  readonly catalog: HarnessInstanceCatalog | null;
};
export interface AuthorizedModelAccounts {
  readonly accounts: readonly HostModelAccount[];
  readonly harnesses: readonly HarnessInstanceRecord[];
  readonly environments: readonly {
    readonly id: EnvironmentId;
    readonly name: string;
  }[];
}
export async function readAuthorizedModelAccounts(
  { store, runners }: AutomaticModelDependencies,
  userId: UserId,
): Promise<AuthorizedModelAccounts> {
  const environments = await store.listEnvironmentsForUser(userId);
  const environmentIds = environments.map((environment) => environment.id);
  const [harnesses, catalogs] = await Promise.all([
    store.listHarnessInstances({
      environmentIds,
    }),
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
      isDefault: harness.isDefault,
      enabled: harness.enabled,
      removed: harness.removedAt !== null,
      available: runners.isAvailable(harness.environmentId),
      catalog,
      usage: usageFacts(catalog),
    };
  });
  return {
    accounts,
    harnesses,
    environments,
  };
}
export interface AutomaticModelRequest {
  readonly userId: UserId;
  readonly wants: (settings: AgentHomeSettings) => readonly ModelWant[];
  readonly original?: OriginalModelSelection | undefined;
  readonly canRun: ModelRunPredicate;
}
export interface AutomaticModelResolution extends AuthorizedModelAccounts {
  readonly settings: AgentHomeSettings;
  readonly candidates: readonly ResolvedModelCandidate[];
  readonly skipped: readonly SkippedModelCandidate[];
}
function resolveWithin(
  settings: AgentHomeSettings,
  snapshot: AuthorizedModelAccounts,
  request: Omit<AutomaticModelRequest, "userId">,
): AutomaticModelResolution {
  const resolved = resolveModelCandidates({
    wants: request.wants(settings),
    ...(request.original
      ? {
          original: request.original,
        }
      : {}),
    accounts: snapshot.accounts,
    excludedAccounts: excludedBackgroundAccounts(settings),
    canRun: request.canRun,
    now: Date.now(),
  });
  return {
    ...snapshot,
    settings,
    ...resolved,
  };
}

/** Every automatic site resolves through here: the person's settings.json over their own accounts. */
export async function resolveAutomaticModels(
  dependencies: AutomaticModelDependencies,
  request: AutomaticModelRequest,
): Promise<AutomaticModelResolution> {
  const [{ settings }, snapshot] = await Promise.all([
    dependencies.store.getAgentHomeSettings(request.userId),
    readAuthorizedModelAccounts(dependencies, request.userId),
  ]);
  return resolveWithin(settings, snapshot, request);
}

export function memoryPassModelRequest(input: {
  readonly role: "light" | "deep";
  readonly environmentId: EnvironmentId;
  readonly accessMode?: ThreadAccessMode;
  readonly original?: OriginalModelSelection | undefined;
  readonly runners: Pick<Runners, "canRunHarness" | "harnessAccessModes">;
}): Omit<AutomaticModelRequest, "userId"> {
  return {
    wants: (settings) => backgroundModelWants(settings, input.role),
    ...(input.role === "deep" && input.original ? { original: input.original } : {}),
    canRun: personalExecution(input.runners, {
      environmentId: input.environmentId,
      accessMode: input.accessMode ?? DEFAULT_THREAD_ACCESS_MODE,
    }),
  };
}

/**
 * What runs each background job now, as Settings shows it. Naming needs
 * background text on the account's computer; memory runs on each managed
 * worker's computer and access mode (or the hosting computer in full access
 * before provisioning), and nightly memory falls back to Chat's model.
 */
export async function readAutomaticModelPreview(
  dependencies: AutomaticModelDependencies & {
    readonly store: Pick<OpensteerStore, "database">;
    readonly runners: Pick<
      Runners,
      "canRunHarness" | "harnessAccessModes" | "identityForEnvironment"
    >;
  },
  userId: UserId,
): Promise<AutomaticModelsView> {
  const { store, runners } = dependencies;
  const personal = await store.database
    .selectFrom("personalSettings")
    .select(["agentHomeComputerId", "executionPreferences"])
    .where("ownerId", "=", userId)
    .executeTakeFirstOrThrow();
  const [environment, workers, { settings, file }, snapshot] = await Promise.all([
    store.database
      .selectFrom("executionEnvironments")
      .select("id")
      .where("runnerId", "=", personal.agentHomeComputerId)
      .executeTakeFirstOrThrow(),
    store.database
      .selectFrom("triggers")
      .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
      .select(["triggers.systemRole", "threads.environmentId", "threads.accessMode"])
      .where("triggers.createdBy", "=", userId)
      .where("triggers.systemRole", "in", ["memory-light", "memory-nightly"])
      .execute(),
    store.getAgentHomeSettings(userId),
    readAuthorizedModelAccounts(dependencies, userId),
  ]);
  const preferences = ExecutionPreferencesSchema.parse(personal.executionPreferences);
  const memoryBoundary = (systemRole: "memory-light" | "memory-nightly") => {
    const worker = workers.find((row) => row.systemRole === systemRole);
    return {
      environmentId: worker?.environmentId ?? environment.id,
      accessMode: worker?.accessMode ?? DEFAULT_THREAD_ACCESS_MODE,
    };
  };
  const inUse = (request: Omit<AutomaticModelRequest, "userId">) => {
    const chosen = resolveWithin(settings, snapshot, request).candidates[0];
    if (!chosen) return null;
    const { modelId, providerId } = chosen.storedModelSelection;
    const harness = snapshot.harnesses.find(({ id }) => id === chosen.harnessInstanceId);
    const computer = snapshot.environments.find(({ id }) => id === chosen.environmentId);
    const model = chosen.account.catalog?.models.find(
      (entry) => entry.modelId === modelId && entry.providerId === providerId,
    );
    return {
      harnessInstanceId: chosen.harnessInstanceId,
      accountDisplayName: harness?.name ?? "AI account",
      computerDisplayName: computer?.name ?? "Computer",
      modelDisplayName: model?.displayName ?? modelId,
      effortDisplayName: model ? modelEffortLabel(model, chosen.runModelSelection.options) : null,
      usageLimited: chosen.usageLimited,
    };
  };
  return {
    file,
    excludedAccounts: [...excludedBackgroundAccounts(settings)],
    naming: inUse({
      wants: (current) => backgroundModelWants(current, "naming"),
      canRun: backgroundTextSupport(runners),
    }),
    light: inUse(
      memoryPassModelRequest({
        role: "light",
        ...memoryBoundary("memory-light"),
        runners,
      }),
    ),
    deep: inUse(
      memoryPassModelRequest({
        role: "deep",
        ...memoryBoundary("memory-nightly"),
        original: preferences.history[0],
        runners,
      }),
    ),
  };
}
