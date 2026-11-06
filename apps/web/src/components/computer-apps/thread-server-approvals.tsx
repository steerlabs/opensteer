import type { ComputerAppSetupSummary } from "@opensteer/integration-core";
import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useShell } from "../app-shell.js";
import { ComputerSetupApprovals } from "./computer-app-approval.js";

interface SetupList {
  viewer: string | null;
  key: string | null;
  requests: readonly ComputerAppSetupSummary[] | null;
  loading: Promise<void> | null;
  readonly listeners: Set<() => void>;
}

/**
 * The viewer's pending computer approvals, read once per machine revision for
 * every open task together: a phone on a weak link pays for one list, not one per view.
 */
const lists = new WeakMap<HostClient, SetupList>();

function listFor(client: HostClient): SetupList {
  let list = lists.get(client);
  if (!list) {
    list = { viewer: null, key: null, requests: null, loading: null, listeners: new Set() };
    lists.set(client, list);
  }
  return list;
}

function refresh(client: HostClient, viewer: string, revision: number, force = false) {
  const list = listFor(client);
  const key = `${viewer}\n${revision}`;
  if (!force && list.key === key) return list.loading ?? Promise.resolve();
  // What one person was asked is never shown to the next one signed in.
  if (list.viewer !== viewer) list.requests = null;
  list.viewer = viewer;
  list.key = key;
  const loading: Promise<void> = client.rpc["integration.computer.setup.list"]({})
    .then(unwrapRpcResult)
    .then(
      ({ requests }) => {
        if (list.loading === loading) list.requests = requests;
      },
      () => undefined,
    )
    .finally(() => {
      if (list.loading === loading) list.loading = null;
      for (const listener of list.listeners) listener();
    });
  list.loading = loading;
  return loading;
}

/** Plugin servers this task's agent installed that wait for the viewer to let them run on a computer. */
export function ThreadServerApprovals({ threadId }: { readonly threadId: string }) {
  const { hostClient, snapshot } = useShell();
  const viewer = snapshot.user?.id ?? null;
  const revision = snapshot.machineRevision;
  const list = listFor(hostClient);
  const requests = useSyncExternalStore(
    useCallback(
      (changed: () => void) => {
        list.listeners.add(changed);
        return () => list.listeners.delete(changed);
      },
      [list],
    ),
    () => (list.viewer === viewer ? list.requests : null),
  );
  useEffect(() => {
    if (viewer) void refresh(hostClient, viewer, revision);
  }, [hostClient, revision, viewer]);
  const waiting =
    requests?.filter((request) => request.kind === "server" && request.threadId === threadId) ?? [];
  if (!viewer || waiting.length === 0) return null;
  return (
    <div className="request-stack">
      <div className="card">
        <ComputerSetupApprovals
          detail={(request) =>
            `Wants to run on ${snapshot.machines.find((machine) => machine.id === request.runnerId)?.name ?? "your computer"}`
          }
          hostClient={hostClient}
          onChanged={() => refresh(hostClient, viewer, revision, true)}
          requests={waiting}
        />
      </div>
    </div>
  );
}
