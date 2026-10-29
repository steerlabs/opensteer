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
