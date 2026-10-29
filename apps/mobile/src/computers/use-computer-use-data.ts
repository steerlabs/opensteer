import type { HostClient } from "@opensteer/client/host";
import { loadComputerUseData, type ComputerUseData } from "@opensteer/client/integrations";
import { useCallback, useEffect, useMemo, useState } from "react";
import { operationDetail } from "../client/mobile-client.js";

/**
 * What the block reads besides the machine: the approved apps and the pending
 * approvals. It reloads when the Host says a machine changed and after each
 * action here, and keeps what it had when a reload fails.
 */
export function useComputerUseData(
  hostClient: HostClient | null,
  revision: number,
): {
  readonly data: ComputerUseData | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
} {
  const [data, setData] = useState<ComputerUseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const source = useMemo(() => ({ active: false, request: 0 }), [hostClient]);
  // Another Deployment's apps are never this one's, even for a moment.
  useEffect(() => {
    setData(null);
    setError(null);
  }, [hostClient]);

  const reload = useCallback(async () => {
    if (!source.active || hostClient === null) return;
    const current = ++source.request;
    try {
      const next = await loadComputerUseData(hostClient);
      if (!source.active || current !== source.request) return;
      setData(next);
      setError(null);
    } catch (reason) {
      if (source.active && current === source.request) {
        setError(operationDetail(reason, "Computer use could not be loaded."));
      }
      throw reason;
    }
  }, [hostClient, source]);

  useEffect(() => {
    source.active = true;
    void reload().catch(() => undefined);
    return () => {
      source.active = false;
      source.request += 1;
    };
  }, [reload, revision, source]);

  return { data, error, reload };
}
