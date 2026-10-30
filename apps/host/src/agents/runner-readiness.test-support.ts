import { observe } from "@opensteer/shared/test-support/observation";
import type { EnvironmentId, HarnessInstanceId } from "@opensteer/core";
import type { HarnessInstanceCatalog } from "@opensteer/protocol";

export function runnerCatalogReadiness(options: {
  readonly bootId: string;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceIds: readonly HarnessInstanceId[];
  readonly requireReady: boolean;
  readonly onReady: () => void;
}): (
  bootId: string,
  connectionId: string,
  environmentId: EnvironmentId,
  catalogs: readonly HarnessInstanceCatalog[],
) => void {
  const settled = new Map<HarnessInstanceId, HarnessInstanceCatalog>();
  let connection: string | undefined;
  return (bootId, connectionId, environmentId, catalogs) => {
    if (bootId !== options.bootId || environmentId !== options.environmentId) return;
    if (connection !== connectionId) {
      settled.clear();
      connection = connectionId;
    }
    for (const catalog of catalogs) settled.set(catalog.harnessInstanceId, catalog);
    if (
      options.harnessInstanceIds.every((id) => {
        const catalog = settled.get(id);
        return (
          catalog &&
          (options.requireReady ? catalog.status === "ready" : catalog.status !== "preparing")
        );
      })
    )
      options.onReady();
  };
}

export interface RunnerReadinessSnapshot {
  readonly bootId: string;
  readonly connectionId: string;
  readonly currentConnectionId: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly catalogs: readonly HarnessInstanceCatalog[];
}

/** Observe committed state for one boot; the source must fence its current connection. */
export function runnerReady(options: {
  readonly bootId: string;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceIds: readonly HarnessInstanceId[];
  readonly requireReady?: boolean;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly read: () => RunnerReadinessSnapshot | undefined;
  readonly subscribe: (notify: () => void) => () => void;
}) {
  return observe({
    ...options,
    label: `Runner boot ${options.bootId} environment ${options.environmentId} committed catalog`,
    matches: (snapshot) => {
      if (!snapshot) return false;
      if (snapshot.bootId !== options.bootId || snapshot.environmentId !== options.environmentId)
        return false;
      if (!snapshot.connected)
        throw new Error(`Runner boot ${options.bootId} disconnected before readiness`);
      if (snapshot.connectionId !== snapshot.currentConnectionId) return false;
      return options.harnessInstanceIds.every((id) =>
        snapshot.catalogs.some(
          (catalog) =>
            catalog.harnessInstanceId === id &&
            (options.requireReady === false
              ? catalog.status !== "preparing"
              : catalog.status === "ready"),
        ),
      );
    },
  });
}
