import { useCallback, useEffect, useState } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { phoneOwnerView } from "../host/phone-tab.js";
import { ownerViewComputerReadiness } from "../integrations/computer-reasons.js";
import { useHostSelector } from "./use-host-snapshot.js";

/**
 * Keeps the person's own view open under a phone's tab while it is in front,
 * so what the tab shows never depends on a task. Opening touches nothing on
 * the phone, so it needs no press; only a person's Open wakes it. A refused
 * open, or a view that went unavailable, waits for that press: asking again by
 * itself would loop. True while a view is being opened for the tab.
 */
export function usePhoneTabView(
  hostClient: HostClient,
  machineId: string,
  inFront: boolean,
): boolean {
  const select = useCallback(
    (snapshot: HostSnapshot) => {
      const machine = snapshot.machines.find(({ id }) => id === machineId);
      return (
        snapshot.connection === "connected" &&
        machine !== undefined &&
        Boolean(machine.tabOpenedAt) &&
        phoneOwnerView(machine) === null &&
        ownerViewComputerReadiness(machine, true) === null
      );
    },
    [machineId],
  );
  const wanted = useHostSelector(hostClient, select) && inFront;
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    hostClient
      .openComputerView(machineId, { kind: "phone", display: "main" }, { wake: false })
      .catch(() => {
        if (current) setRefused(true);
      });
    return () => {
      current = false;
      setRefused(false);
    };
  }, [hostClient, machineId, wanted]);
  return wanted && !refused;
}
