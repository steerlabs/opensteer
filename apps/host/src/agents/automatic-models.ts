import {
  backgroundModelWants,
  excludedBackgroundAccounts,
  ExecutionPreferencesSchema,
  resolveModelCandidates,
  type AgentHomeSettings,
  type AuthorizedModelAccountSnapshot,
  type BackgroundModelRole,
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
import type { AutomaticModelsView, HarnessInstanceCatalog } from "@opensteer/protocol";
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
          connection.connectionSlot === "primary" || connection.connectionSlot === providerId,
      )
      .flatMap(({ usage }): ModelUsageFact[] => {
        if (!usage) return [];
        if (usage.windows.length === 0)
          return usage.limitReached
            ? [
                {
                  providerId,
                  exhausted: true,
                  resetsAt: null,
                },
              ]
            : [];
        return usage.windows.flatMap((window): ModelUsageFact[] => {
          if (window.usedPercent < 100) return [];
          const resetsAt = window.resetsAt === null ? null : Date.parse(window.resetsAt);
          if (window.scope?.kind !== "model")
            return [
              {
                providerId,
                exhausted: true,
                resetsAt,
              },
            ];
          return window.scope.providerId === providerId
            ? [
                {
                  providerId,
                  modelId: window.scope.modelId,
                  exhausted: true,
                  resetsAt,
                },
              ]
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

/**
 * What runs each background job now, as Settings shows it. Naming needs
 * background text on the account's computer; memory runs on the hosting
 * computer in the person's access mode, and nightly memory ends with Chat's model.
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
  const environment = await store.database
    .selectFrom("executionEnvironments")
    .select("id")
    .where("runnerId", "=", personal.agentHomeComputerId)
    .executeTakeFirstOrThrow();
  const preferences = ExecutionPreferencesSchema.parse(personal.executionPreferences);
  const memory = personalExecution(runners, {
    environmentId: environment.id,
    accessMode: preferences.accessMode,
  });
  const [{ settings, file }, snapshot] = await Promise.all([
    store.getAgentHomeSettings(userId),
    readAuthorizedModelAccounts(dependencies, userId),
  ]);
  const inUse = (
    role: BackgroundModelRole,
    request: Omit<AutomaticModelRequest, "userId" | "wants">,
  ) => {
    const chosen = resolveWithin(settings, snapshot, {
      ...request,
      wants: (current) => backgroundModelWants(current, role),
    }).candidates[0];
    if (!chosen) return null;
    const { modelId, providerId } = chosen.storedModelSelection;
    const harness = snapshot.harnesses.find(({ id }) => id === chosen.harnessInstanceId);
    const computer = snapshot.environments.find(({ id }) => id === chosen.environmentId);
    return {
      harnessInstanceId: chosen.harnessInstanceId,
      accountDisplayName: harness?.name ?? "AI account",
      computerDisplayName: computer?.name ?? "Computer",
      modelDisplayName:
        chosen.account.catalog?.models.find(
          (model) => model.modelId === modelId && model.providerId === providerId,
        )?.displayName ?? modelId,
      usageLimited: chosen.usageLimited,
    };
  };
  return {
    file,
    excludedAccounts: [...excludedBackgroundAccounts(settings)],
    naming: inUse("naming", { canRun: backgroundTextSupport(runners) }),
    light: inUse("light", { canRun: memory }),
    deep: inUse("deep", { canRun: memory, original: preferences.history[0] }),
  };
}
