import { useMemo } from "react";
import type { HostClient } from "../host/client.js";
import {
  connectedAgentRowDistinctions,
  matchingConnectedAgentRows,
  type ConnectedAgentNow,
} from "../host/connected-agents-now.js";
import { useConnectedAgents } from "./use-connected-agents.js";

/** The catalog is only needed if two visible rows would otherwise read the same. */
export function useConnectedAgentRowDistinctions(
  client: HostClient | null,
  agents: readonly ConnectedAgentNow[],
  sharedDeviceName?: string | null,
) {
  const matching = useMemo(
    () => matchingConnectedAgentRows(agents, sharedDeviceName),
    [agents, sharedDeviceName],
  );
  const { connections } = useConnectedAgents(matching.size ? client : null);
  return useMemo(
    () => connectedAgentRowDistinctions(agents, matching, connections),
    [agents, matching, connections],
  );
}
