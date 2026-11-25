import { taskOriginLabels, type HostClient } from "@opensteer/client/host";
import { useConnectedAgents } from "@opensteer/client/react";
import { useMemo } from "react";

export function useTaskOrigins(host: HostClient | null, wanted: boolean) {
  const { connections, revoked } = useConnectedAgents(wanted ? host : null);
  return useMemo(() => taskOriginLabels(connections, revoked), [connections, revoked]);
}
