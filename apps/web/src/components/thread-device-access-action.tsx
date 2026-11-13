import { createContext, useContext, useMemo, useState } from "react";
import type { Request } from "@opensteer/core";
import { withDeviceSwitch } from "@opensteer/client/computers";
import type { HostClient } from "@opensteer/client/host";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import { actionErrorMessage } from "../ui-utils.js";
import { ActionNote } from "./action-rows.js";
import { useShell } from "./app-shell.js";
import { useHereId } from "./computers/here.js";
import { Icon } from "./icon.js";
import { capabilityLabel, type DeviceCapability } from "./devices/device-access.js";
import {
  MacosPermissionRows,
  missingMacosGrant,
  readMacosGrants,
  useMacosGrants,
} from "./devices/macos-permission-rows.js";
import { SetupList } from "./first-run/setup-list.js";

export function deviceAccessRequestTitle(payload: {
  readonly access: DeviceCapability;
  readonly machineName: string;
}): string {
  return `Let your agent use ${capabilityLabel[payload.access]} on ${payload.machineName}?`;
}

/**
 * Turns one switch on, as the device page would. A revision someone else
 * moved first is read again and asked once more: the only field this writes
 * on top of what is stored is the one switch the person just said yes to.
 */
export async function turnOnDeviceAccess(
  hostClient: Pick<HostClient, "getSnapshot" | "refresh" | "updateMachineAccess">,
  machineId: string,
  capability: DeviceCapability,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const machine = hostClient.getSnapshot().machines.find((entry) => entry.id === machineId);
    if (!machine?.access) throw new Error("This device can’t be changed from here right now.");
    const result = await hostClient.updateMachineAccess({
      expectedRevision: machine.access.revision,
      policy: withDeviceSwitch(machine.access.policy, capability, true),
      runnerId: machineId,
    });
    if (result.outcome === "updated") return;
    await hostClient.refresh();
  }
  throw new Error("It changed on another device. Look again and try once more.");
}

/** A device switch just turned on here whose macOS grant is still missing. */
export interface DeviceGrantFollowUp {
  readonly requestId: string;
  readonly machineName: string;
  readonly access: DeviceCapability;
}

const DeviceGrantFollowUpContext = createContext<{
  readonly retain: (followUp: DeviceGrantFollowUp) => void;
  readonly release: (requestId: string) => void;
} | null>(null);

/**
 * Fulfilling a device.access Request resolves it, which takes its card out of
 * the dock. The dock keeps the macOS grants that switch still needs here, so
 * "Turn it on" carries on into them where the person pressed it.
 */
export function useDeviceGrantFollowUps(liveRequestIds: readonly string[]) {
  const [followUps, setFollowUps] = useState<readonly DeviceGrantFollowUp[]>([]);
  const context = useMemo(
    () => ({
      retain: (followUp: DeviceGrantFollowUp) =>
        setFollowUps((current) => [
          ...current.filter((entry) => entry.requestId !== followUp.requestId),
          followUp,
        ]),
      release: (requestId: string) =>
        setFollowUps((current) => current.filter((entry) => entry.requestId !== requestId)),
    }),
    [],
  );
  const shown = followUps.filter((entry) => !liveRequestIds.includes(entry.requestId));
  const node =
    shown.length > 0 ? (
      <>
        {shown.map((followUp) => (
          <DeviceGrantFollowUpCard
            followUp={followUp}
            key={followUp.requestId}
            onDone={() => context.release(followUp.requestId)}
          />
        ))}
      </>
    ) : null;
  return { Provider: DeviceGrantFollowUpContext.Provider, context, node };
}

function DeviceGrantFollowUpCard({
  followUp,
  onDone,
}: {
  readonly followUp: DeviceGrantFollowUp;
  readonly onDone: () => void;
}) {
  const { desktopBridge } = useShell();
  const { grants, reload } = useMacosGrants(desktopBridge);
  if (!desktopBridge) return null;
  const label = capabilityLabel[followUp.access];
  const missing = grants === null || missingMacosGrant(grants, followUp.access);
  return (
    <div className="input-surface input-surface--action request-card">
      <section aria-label={`${label} on ${followUp.machineName}`} className="action-panel">
        <div className="action-panel__head">
          <span aria-hidden className="action-panel__icon">
            <Icon name={missing ? "lock" : "check"} />
          </span>
          <span className="action-panel__title">{`${label} is on for ${followUp.machineName}`}</span>
        </div>
        <div className="action-panel__content">
          <ActionNote>
            {missing ? "macOS still has to allow it here." : "macOS allows it now."}
          </ActionNote>
          <SetupList label="macOS permissions">
            <MacosPermissionRows
              apps={followUp.access === "apps"}
              bridge={desktopBridge}
              files={followUp.access === "files"}
              grants={grants}
              onAsked={reload}
            />
          </SetupList>
          <div className="action-buttons">
            <button className="btn" onClick={onDone} type="button">
              {missing ? "Do this later" : "Done"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * An agent asking for a capability that is off on one device. "Turn it on"
 * flips the switch; where this window is that Mac, any macOS grant it still
 * needs follows in the dock, after the Request itself has resolved. "Not now"
 * sticks for this task.
 */
export function ThreadDeviceAccessAction({
  disabled = false,
  request,
}: {
  readonly disabled?: boolean;
  readonly request: Request;
}) {
  const { desktopBridge, hostClient, reportActionError } = useShell();
  const followUps = useContext(DeviceGrantFollowUpContext);
  const hereId = useHereId();
  const [pending, setPending] = useState<"on" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const payload = request.payload.kind === "device.access" ? request.payload : null;
  const onThisMac = payload !== null && desktopBridge !== null && hereId === payload.machineId;
  if (!payload) return <ActionNote alert>This device request is invalid.</ActionNote>;
  const { access, machineId, machineName } = payload;

  async function turnOn() {
    if (pending || disabled) return;
    setPending("on");
    setError(null);
    let followUp = false;
    try {
      // Retained before the write: fulfilling resolves this Request and unmounts it.
      followUp =
        onThisMac && desktopBridge !== null
          ? missingMacosGrant(await readMacosGrants(desktopBridge), access)
          : false;
      if (followUp) followUps?.retain({ access, machineName, requestId: request.id });
      await turnOnDeviceAccess(hostClient, machineId, access);
    } catch (reason) {
      if (followUp) followUps?.release(request.id);
      setError(actionErrorMessage(reason));
    } finally {
      setPending(null);
    }
  }

  async function decline() {
    if (pending || disabled) return;
    setPending("decline");
    setError(null);
    try {
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
        requestId: request.id,
        response: { kind: "external", value: { decision: "declined" } },
        type: "request.respond",
      });
    } catch (reason) {
      setError(actionErrorMessage(reason));
      reportActionError(reason);
      setPending(null);
    }
  }

  return (
    <>
      <ActionNote>
        Turning it on may still need an app, browser profile or macOS permission.
      </ActionNote>
      {error ? <ActionNote alert>{error}</ActionNote> : null}
      <div className="action-buttons">
        <button
          className="btn"
          disabled={pending !== null || disabled}
          onClick={() => void decline()}
          type="button"
        >
          Not now
        </button>
        <button
          className="btn btn--primary"
          disabled={pending !== null || disabled}
          onClick={() => void turnOn()}
          type="button"
        >
          {pending === "on" ? "Turning on…" : "Turn it on"}
        </button>
      </div>
    </>
  );
}
