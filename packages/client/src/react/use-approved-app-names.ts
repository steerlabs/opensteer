import { useEffect, useState, useSyncExternalStore } from "react";
import { approvedAppNames, type ApprovedAppNames } from "../host/approved-app-names.js";
import type { HostClient } from "../host/client.js";
import { unwrapRpcResult } from "../host/host-session-client.js";
import type { HostSnapshotSource } from "../host/host-snapshot-store.js";

export type ApprovedAppNamesHost = HostSnapshotSource & {
  readonly rpc: Pick<HostClient["rpc"], "integration.computer.apps.approved">;
};

const noSubscription = () => () => {};

/**
 * The names of the Mac apps the person approved (`approvedAppNames`), read only while something
 * the person watches names a Mac app, and again when the Home says a machine changed. Keeps the
 * names it had through a failed read. For display only: what an agent reads keeps its own names.
 */
export function useApprovedAppNames(
  client: ApprovedAppNamesHost | null,
  wanted: boolean,
): ApprovedAppNames | null {
  const revision = useSyncExternalStore(
    client ? client.subscribe : noSubscription,
    () => client?.getSnapshot().machineRevision ?? null,
  );
  const [read, setRead] = useState<{
    readonly client: ApprovedAppNamesHost;
    readonly names: ApprovedAppNames;
  }>();
  useEffect(() => {
    if (!client || !wanted) return;
    const controller = new AbortController();
    void client.rpc["integration.computer.apps.approved"]({}, { signal: controller.signal })
      .then(unwrapRpcResult)
      .then(
        ({ apps }) => {
          if (!controller.signal.aborted) setRead({ client, names: approvedAppNames(apps) });
        },
        () => undefined,
      );
    return () => controller.abort();
  }, [client, wanted, revision]);
  return read?.client === client ? read.names : null;
}
