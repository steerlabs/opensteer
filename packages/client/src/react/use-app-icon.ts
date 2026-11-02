import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ComputerAppIdentity } from "@opensteer/protocol";
import { sharedAppIcons, type AppIconOwner } from "../host/app-icons.js";
import type { HostClient } from "../host/client.js";

const noSubscription = () => () => undefined;

/**
 * A Mac app's own icon, as base64 PNG, read from its Mac; null until an
 * authorized read answers, and for a reader with no Host or no Mac.
 */
export function useAppIcon(
  hostClient: HostClient | null,
  machineId: string | null | undefined,
  identity: ComputerAppIdentity,
): string | null {
  const owner = hostClient ? sharedAppIcons(hostClient) : null;
  const getGeneration = useCallback(() => owner?.generation(machineId) ?? 0, [owner, machineId]);
  const generation = useSyncExternalStore(owner?.subscribe ?? noSubscription, getGeneration);
  const key = machineId ? JSON.stringify([machineId, identity.bundleId.toLowerCase()]) : null;
  const [icon, setIcon] = useState<{
    owner: AppIconOwner;
    generation: number;
    key: string;
    png: string;
  } | null>(null);
  useEffect(() => {
    if (!owner || !machineId || key === null) return;
    let current = true;
    void owner.read(machineId, identity).then((png) => {
      if (current && png) setIcon({ owner, generation, key, png });
    });
    return () => {
      current = false;
    };
  }, [owner, generation, key]);
  return icon?.owner === owner && icon?.generation === generation && icon?.key === key
    ? icon.png
    : null;
}
