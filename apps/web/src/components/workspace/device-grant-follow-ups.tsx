import { createContext, useMemo, useState, type ReactNode } from "react";
import type { DeviceCapability } from "../devices/device-access.js";

/** A device switch just turned on here whose macOS grant is still missing. */
export interface DeviceGrantFollowUp {
  readonly access: DeviceCapability;
  readonly deploymentId: string | null;
  readonly machineId: string;
  readonly machineName: string;
  /** The subagent that asked, so its own view keeps the follow-up too. */
  readonly nodeId: string | null;
  readonly requestId: string;
  /** The conversation whose dock it was pressed in. */
  readonly threadId: string;
}

export const DeviceGrantFollowUpContext = createContext<{
  readonly followUps: readonly DeviceGrantFollowUp[];
  readonly retain: (followUp: DeviceGrantFollowUp) => void;
  readonly release: (requestId: string) => void;
} | null>(null);

export const DeviceGrantDock = createContext<string | null>(null);

/**
 * Fulfilling a device.access Request takes its card, and often its whole surface (a subagent's
 * footer, Voice's ask), off the screen. The workspace keeps the macOS grants the switch still
 * needs, so "Turn it on" carries on into them wherever it was pressed.
 */
export function DeviceGrantFollowUpProvider({ children }: { readonly children: ReactNode }) {
  const [followUps, setFollowUps] = useState<readonly DeviceGrantFollowUp[]>([]);
  const value = useMemo(
    () => ({
      followUps,
      retain: (followUp: DeviceGrantFollowUp) =>
        setFollowUps((current) => [
          ...current.filter(
            (entry) =>
              entry.requestId !== followUp.requestId &&
              !(
                entry.deploymentId === followUp.deploymentId &&
                entry.machineId === followUp.machineId &&
                entry.access === followUp.access
              ),
          ),
          followUp,
        ]),
      release: (requestId: string) =>
        setFollowUps((current) => current.filter((entry) => entry.requestId !== requestId)),
    }),
    [followUps],
  );
  return <DeviceGrantFollowUpContext value={value}>{children}</DeviceGrantFollowUpContext>;
}
