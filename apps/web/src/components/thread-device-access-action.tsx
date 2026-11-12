import { useState } from "react";
import type { Request } from "@opensteer/core";
import type { HostClient } from "@opensteer/client/host";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import { actionErrorMessage } from "../ui-utils.js";
import { ActionNote } from "./action-rows.js";
import { useShell } from "./app-shell.js";
import { useHereId } from "./computers/here.js";
import { capabilityLabel, switchPolicy, type DeviceCapability } from "./devices/device-access.js";
import {
  MacosPermissionRows,
  missingMacosGrant,
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
      policy: switchPolicy(machine.access.policy, capability, true),
      runnerId: machineId,
    });
    if (result.outcome === "updated") return;
    await hostClient.refresh();
  }
  throw new Error("It changed on another device. Look again and try once more.");
}

/**
 * An agent asking for a capability that is off on one device. "Turn it on"
 * flips the switch; where this window is that Mac, any macOS grant it still
 * needs follows in the same card. "Not now" sticks for this task.
 */
export function ThreadDeviceAccessAction({
  disabled = false,
  request,
}: {
  readonly disabled?: boolean;
  readonly request: Request;
}) {
  const { desktopBridge, hostClient, reportActionError } = useShell();
  const hereId = useHereId();
  const [pending, setPending] = useState<"on" | "decline" | null>(null);
  const [turnedOn, setTurnedOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payload = request.payload.kind === "device.access" ? request.payload : null;
  const onThisMac = payload !== null && desktopBridge !== null && hereId === payload.machineId;
  const { grants, reload } = useMacosGrants(onThisMac ? desktopBridge : null);
  if (!payload) return <ActionNote alert>This device request is invalid.</ActionNote>;
  const { access, machineId, machineName } = payload;

  async function turnOn() {
    if (pending || disabled) return;
    setPending("on");
    setError(null);
    try {
      await turnOnDeviceAccess(hostClient, machineId, access);
      setTurnedOn(true);
    } catch (reason) {
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

  const missing = onThisMac && missingMacosGrant(grants, access);
  if (turnedOn && desktopBridge && missing)
    return (
      <>
        <ActionNote>{`${capabilityLabel[access]} is on. macOS still has to allow it here.`}</ActionNote>
        <SetupList label="macOS permissions">
          <MacosPermissionRows
            apps={access === "apps"}
            bridge={desktopBridge}
            files={access === "files"}
            grants={grants}
            onAsked={reload}
          />
        </SetupList>
      </>
    );
  return (
    <>
      <ActionNote>
        {turnedOn
          ? `${capabilityLabel[access]} is on for ${machineName}.`
          : "Turning it on may still need an app, browser profile or macOS permission."}
      </ActionNote>
      {error ? <ActionNote alert>{error}</ActionNote> : null}
      {turnedOn ? null : (
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
      )}
    </>
  );
}
