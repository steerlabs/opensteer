import {
  modelLabLabels,
  type EnvironmentId,
  type Thread,
  type Workspace,
  type UserId,
} from "@opensteer/core";
import type { HarnessInstanceRecord, OpensteerStore } from "@opensteer/database";
import type { BackgroundModelsView } from "@opensteer/protocol";
import type { RunnerRegistry } from "@opensteer/orchestration";
import type { HostServerDependencies } from "../server.js";
import {
  inspectBackgroundCandidates,
  type BackgroundResolutionInput,
  type BackgroundAccountSnapshot,
} from "./background-models.js";

export async function readBackgroundResolutionInput(
  dependencies: Pick<HostServerDependencies, "store" | "runners">,
  userId: UserId,
) {
  const environments = await dependencies.store.listEnvironmentsForUser(userId);
  const [preferences, { harnesses, accounts }] = await Promise.all([
    dependencies.store.getBackgroundModelPreferences(userId),
    backgroundAccounts(
      dependencies.store,
      environments.map((environment) => environment.id),
      dependencies.runners.isAvailable.bind(dependencies.runners),
      (harness) =>
        dependencies.runners
          .identityForEnvironment(harness.environmentId)
          ?.capabilities.includes("background-text-v1") === true &&
        dependencies.runners.canRunHarness(harness.environmentId, harness.driverKind),
    ),
  ]);
  return { accounts, preferences, now: Date.now(), environments, harnesses };
}

export async function readBackgroundModels(
  dependencies: Pick<HostServerDependencies, "store" | "runners">,
  userId: UserId,
): Promise<BackgroundModelsView> {
  const [{ accounts, preferences, environments, harnesses }, main] = await Promise.all([
    readBackgroundResolutionInput(dependencies, userId),
    dependencies.store.findMainWorkspaceForOwner(userId),
  ]);
  // Chat's provider is the person's own, as it is for memory passes: Main's
  // memory and most tasks already reach it, so it needs no consent here.
  const chat = main?.homeThreadId
    ? await dependencies.store.getThreadForOwner(main.homeThreadId, userId)
    : undefined;
  const memory = chat
    ? await readMemoryBackgroundResolutionInput(dependencies, userId, main, chat, "deep")
    : undefined;
  const display = ({
    candidate,
    skipReason,
    usageLimited,
  }: ReturnType<typeof inspectBackgroundCandidates>[number]) => {
    const harness = harnesses.find((harness) => harness.id === candidate.harnessInstanceId);
    const catalog = accounts.find(
      (account) => account.harnessInstanceId === candidate.harnessInstanceId,
    )?.catalog;
    const model = catalog?.models.find(
      (model) =>
        model.providerId === candidate.modelSelection.providerId &&
        model.modelId === candidate.modelSelection.modelId,
    );
    return {
      ...candidate,
      skipReason,
      usageLimited,
      providerDisplayName:
        modelLabLabels[candidate.modelSelection.providerId] ?? candidate.modelSelection.providerId,
      modelDisplayName: model?.displayName ?? candidate.modelSelection.modelId,
      accountDisplayName: harness?.name ?? candidate.harnessInstanceId,
      computerDisplayName:
        environments.find((environment) => environment.id === candidate.environmentId)?.name ??
        candidate.environmentId,
    };
  };
  const roleView = (role: "light" | "deep") => {
    const resolution =
      role === "deep"
        ? memory
        : {
            accounts,
            preferences,
            now: Date.now(),
            ...(chat ? { ownProviderId: chat.modelSelection.providerId } : {}),
          };
    const candidates = resolution ? inspectBackgroundCandidates(role, resolution).map(display) : [];
    return {
      mode: preferences.backgroundModels[role],
      effectivePick: candidates.find((candidate) => candidate.skipReason === null) ?? null,
      candidates,
    };
  };
  return {
    pinnableModels: accounts.flatMap((account) => {
      if (
        !account.enabled ||
        !account.available ||
        !account.canRun ||
        account.catalog?.status !== "ready"
      )
        return [];
      return account.catalog.models
        .filter((model) => !model.unavailableReason)
        .map((model) => {
          const pin = {
            environmentId: account.environmentId,
            harnessInstanceId: account.harnessInstanceId,
            modelSelection: { providerId: model.providerId, modelId: model.modelId, options: {} },
          };
          const decision = inspectBackgroundCandidates("light", {
            accounts: [account],
            preferences: {
              ...preferences,
              backgroundModels: {
                ...preferences.backgroundModels,
                light: { kind: "pinned", selection: pin },
              },
            },
            now: Date.now(),
            ...(chat ? { ownProviderId: chat.modelSelection.providerId } : {}),
          })[0]!;
          return display(decision);
        });
    }),
    backgroundProviderConsent: preferences.backgroundProviderConsent,
    light: roleView("light"),
    deep: roleView("deep"),
  };
}

/**
 * The accounts on these computers as background resolution sees them.
 * `supports` is what this kind of background work needs of the account's
 * Runner: background text for naming, a Run in the pass's access mode for memory.
 */
export async function backgroundAccounts(
  store: Pick<OpensteerStore, "listHarnessInstances" | "listHarnessCatalogs">,
  environmentIds: readonly EnvironmentId[],
  isAvailable: (environmentId: EnvironmentId) => boolean,
  canRun: (harness: HarnessInstanceRecord) => boolean,
): Promise<{
  readonly harnesses: readonly HarnessInstanceRecord[];
  readonly accounts: BackgroundAccountSnapshot[];
}> {
  const [harnesses, catalogs] = await Promise.all([
    store.listHarnessInstances({ environmentIds: [...environmentIds] }),
    store.listHarnessCatalogs([...environmentIds]),
  ]);
  const accounts = harnesses.map((harness): BackgroundAccountSnapshot => {
    const catalog =
      catalogs.find(
        (record) =>
          record.harnessInstanceId === harness.id && record.environmentId === harness.environmentId,
      )?.catalog ?? null;
    const usageByProvider = Object.fromEntries(
      (catalog?.models ?? []).map((model) => [
        model.providerId,
        (catalog?.connections ?? [])
          .filter(
            (connection) =>
              connection.connectionSlot === "primary" ||
              connection.connectionSlot === model.providerId,
          )
          .flatMap((connection) => (connection.usage ? [connection.usage] : [])),
      ]),
    );
    return {
      environmentId: harness.environmentId,
      harnessInstanceId: harness.id,
      harnessRevision: harness.runtimeRevision,
      driverKind: harness.driverKind,
      enabled: harness.enabled && harness.removedAt === null,
      isDefault: harness.isDefault,
      catalog,
      usageByProvider,
      available: isAvailable(harness.environmentId),
      canRun: canRun(harness),
    };
  });
  return { harnesses, accounts };
}

/** Shared by Settings and managed memory admission: Main's files and access mode define the boundary. */
export async function readMemoryBackgroundResolutionInput(
  {
    store,
    runners,
  }: {
    store: OpensteerStore;
    runners: Pick<RunnerRegistry, "isAvailable" | "canRunHarness" | "harnessAccessModes">;
  },
  ownerId: UserId,
  main: Workspace | null | undefined,
  worker: Thread,
  role: "light" | "deep",
): Promise<BackgroundResolutionInput | undefined> {
  if (
    main?.backing.kind !== "local-directory" ||
    main.backing.ownerEnvironmentId !== worker.environmentId ||
    !main.homeThreadId
  )
    return undefined;
  const [preferences, chat, { harnesses, accounts }] = await Promise.all([
    store.getBackgroundModelPreferences(ownerId),
    store.getThreadForOwner(main.homeThreadId, ownerId),
    backgroundAccounts(
      store,
      [worker.environmentId],
      (environmentId) => runners.isAvailable(environmentId),
      (harness) =>
        runners.canRunHarness(harness.environmentId, harness.driverKind) &&
        runners
          .harnessAccessModes(harness.environmentId, harness.driverKind)
          ?.includes(worker.accessMode) === true,
    ),
  ]);
  const chatHarness = chat
    ? harnesses.find((harness) => harness.id === chat.harnessInstanceId)
    : undefined;
  return {
    accounts,
    preferences,
    now: Date.now(),
    ...(chat ? { ownProviderId: chat.modelSelection.providerId } : {}),
    ...(role === "deep" && chat && chatHarness
      ? {
          taskModelFallback: {
            environmentId: chat.environmentId,
            harnessInstanceId: chat.harnessInstanceId,
            harnessRevision: chatHarness.runtimeRevision,
            modelSelection: chat.modelSelection,
            reason: "task-model",
          },
        }
      : {}),
  };
}
