import type { HostClient } from "@opensteer/client/host";
import { loadComputerUseData, type ComputerUseData } from "@opensteer/client/integrations";
import type { ClientReadState } from "@opensteer/client/reads";
import { useCallback } from "react";
import { useScreenRead } from "../ui/client-feedback.js";

/**
 * What the block reads besides the machine: the approved apps and the pending
 * approvals. It rereads when the Host says a machine changed and after each
 * action here, and keeps what it had through outages and failed rereads.
 */
export function useComputerUseData(hostClient: HostClient | null): {
  readonly data: ComputerUseData | null;
  readonly read: ClientReadState<ComputerUseData> & { readonly refresh: () => void };
  readonly reload: () => Promise<void>;
} {
  const read = useScreenRead(hostClient, {
    key: "computer-use",
    label: "computer use",
    read: hostClient === null ? null : () => loadComputerUseData(hostClient),
    subscribeInvalidation: (invalidate) => {
      if (hostClient === null) return () => {};
      let revision = hostClient.getSnapshot().machineRevision;
      return hostClient.subscribe(() => {
        const next = hostClient.getSnapshot().machineRevision;
        if (next === revision) return;
        revision = next;
        invalidate();
      });
    },
  });
  const { refresh } = read;
  const reload = useCallback(async () => refresh(), [refresh]);
  return { data: read.data, read, reload };
}
