import { unwrapRpcResult, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import type { ComputerAppSetupSummary } from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import { useCallback, useEffect, useState } from "react";

type SetupList = Pick<HostClient, "rpc">;

/**
 * One pending-approvals read per Host and machine revision, shared by every
 * Thread opened in between: the Host announces a change to them as a machine
 * change, so opening another Thread reads nothing new.
 */
const reads = new WeakMap<
  SetupList,
  { readonly revision: number; readonly requests: Promise<readonly ComputerAppSetupSummary[]> }
>();

export function readSetupRequests(
  hostClient: SetupList,
  revision: number,
): Promise<readonly ComputerAppSetupSummary[]> {
  const cached = reads.get(hostClient);
  if (cached?.revision === revision) return cached.requests;
  const requests = Promise.resolve()
    .then(() => hostClient.rpc["integration.computer.setup.list"]({}))
    .then(unwrapRpcResult)
    .then((list) => list.requests);
  reads.set(hostClient, { requests, revision });
  // A failed read is not kept, so the next Thread asks again.
  requests.catch(() => {
    if (reads.get(hostClient)?.requests === requests) reads.delete(hostClient);
  });
  return requests;
}

/** Forgets the shared read after this phone answered one, so the next read is fresh. */
function forgetSetupRequests(hostClient: SetupList): void {
  reads.delete(hostClient);
}

/** The plugin servers an agent in this Thread installed that wait for the owner to allow them. */
export function threadServerApprovals(
  requests: readonly ComputerAppSetupSummary[],
  threadId: string,
): readonly ComputerAppSetupSummary[] {
  return requests.filter((request) => request.kind === "server" && request.threadId === threadId);
}

const selectMachineRevision = (snapshot: HostSnapshot) => snapshot.machineRevision;
const none: readonly ComputerAppSetupSummary[] = [];

export function useThreadServerApprovals(
  hostClient: HostClient,
  threadId: string,
): { readonly requests: readonly ComputerAppSetupSummary[]; readonly reload: () => Promise<void> } {
  const revision = useHostSelector(hostClient, selectMachineRevision);
  const [state, setState] = useState<{
    readonly key: string;
    readonly requests: readonly ComputerAppSetupSummary[];
  }>({ key: threadId, requests: none });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    readSetupRequests(hostClient, revision).then(
      (requests) => {
        if (active)
          setState({ key: threadId, requests: threadServerApprovals(requests, threadId) });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [generation, hostClient, revision, threadId]);
  const reload = useCallback(async () => {
    forgetSetupRequests(hostClient);
    setGeneration((value) => value + 1);
  }, [hostClient]);
  return { requests: state.key === threadId ? state.requests : none, reload };
}
