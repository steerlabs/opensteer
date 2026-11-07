import type { ComputerAppSetupSummary } from "@opensteer/integration-core";
import type { HostClient } from "../host/client.js";
import { unwrapRpcResult } from "../host/host-session-client.js";

type SetupHost = Pick<HostClient, "rpc" | "getSnapshot" | "subscribe">;

const lists = new WeakMap<object, ReturnType<typeof createSetupRequests>>();

export function computerSetupRequests(host: SetupHost) {
  let list = lists.get(host);
  if (!list) {
    list = createSetupRequests(host);
    lists.set(host, list);
  }
  return list;
}

function createSetupRequests(host: SetupHost) {
  let snapshot = host.getSnapshot();
  let epoch = 0;
  let key: string | null = null;
  let pending: Promise<readonly ComputerAppSetupSummary[]> | null = null;
  let requests: readonly ComputerAppSetupSummary[] | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const currentKey = () => `${snapshot.user?.id ?? ""}\n${snapshot.machineRevision}\n${epoch}`;

  function read(): Promise<readonly ComputerAppSetupSummary[]> {
    const nextKey = currentKey();
    if (key === nextKey && pending) return pending;
    key = nextKey;
    const loading = Promise.resolve()
      .then(() => host.rpc["integration.computer.setup.list"]({}))
      .then(unwrapRpcResult)
      .then(
        ({ requests: next }) => {
          if (pending === loading) {
            requests = next;
            notify();
          }
          return next;
        },
        (error: unknown) => {
          if (pending === loading) {
            key = null;
            pending = null;
          }
          throw error;
        },
      );
    pending = loading;
    return loading;
  }

  function invalidate() {
    key = null;
    pending = null;
    if (listeners.size && snapshot.user && snapshot.connection === "connected")
      void read().catch(() => undefined);
  }

  // Keep tracking connection epochs between mounts, without fetching for closed views.
  host.subscribe(() => {
    const next = host.getSnapshot();
    const viewerChanged = next.user?.id !== snapshot.user?.id;
    const reconnected = next.connection === "connected" && snapshot.connection !== "connected";
    const changed =
      viewerChanged || reconnected || next.machineRevision !== snapshot.machineRevision;
    snapshot = next;
    if (reconnected) epoch += 1;
    if (viewerChanged) {
      requests = null;
      notify();
    }
    if (changed) invalidate();
  });

  return {
    read,
    invalidate,
    getSnapshot: () => requests,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function invalidateComputerSetupRequests(host: object): void {
  lists.get(host)?.invalidate();
}
