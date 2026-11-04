import { modelLabLabels, type EnvironmentId, type UserId } from "@opensteer/core";
import type { HarnessInstanceRecord, OpensteerStore } from "@opensteer/database";
import type { BackgroundModelsView } from "@opensteer/protocol";
import type { HostServerDependencies } from "../server.js";
import {
  inspectBackgroundCandidates,
  type BackgroundAccountSnapshot,
} from "./background-models.js";

export async function readBackgroundModels(
  dependencies: Pick<HostServerDependencies, "store" | "runners">,
  userId: UserId,
): Promise<BackgroundModelsView> {
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
  const roleView = (role: "light" | "deep") => {
    const candidates = inspectBackgroundCandidates(role, {
      accounts,
      preferences,
      now: Date.now(),
    }).map(({ candidate, skipReason }) => {
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
        providerDisplayName:
          modelLabLabels[candidate.modelSelection.providerId] ??
          candidate.modelSelection.providerId,
        modelDisplayName: model?.displayName ?? candidate.modelSelection.modelId,
        accountDisplayName: harness?.name ?? candidate.harnessInstanceId,
        computerDisplayName:
          environments.find((environment) => environment.id === candidate.environmentId)?.name ??
          candidate.environmentId,
      };
    });
    return {
      mode: preferences.backgroundModels[role],
      effectivePick: candidates.find((candidate) => candidate.skipReason === null) ?? null,
      candidates,
    };
  };
  return {
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
  supports: (harness: HarnessInstanceRecord) => boolean,
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
      supportsBackgroundText: supports(harness),
    };
  });
  return { harnesses, accounts };
}
