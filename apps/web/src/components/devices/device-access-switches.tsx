import { useCallback, useRef, useState, type ReactNode } from "react";
import type { MachineSummary } from "@opensteer/protocol";
import { withDeviceSwitch } from "@opensteer/client/computers";
import type { HostClient } from "@opensteer/client/host";
import { actionErrorMessage } from "../../ui-utils.js";
import {
  capabilityLabel,
  deviceSwitchDetail,
  type DeviceCapability,
  type DeviceSwitch,
} from "./device-access.js";

const accessConflictNotice = "This changed on another device. The switches show what’s set now.";

/** A stale revision means another device changed it first: nothing is written; the page reloads. */
export function useAccessSwitch(
  hostClient: Pick<HostClient, "refresh" | "updateMachineAccess">,
  machine: MachineSummary,
) {
  const [pending, setPending] = useState<DeviceCapability | null>(null);
  const [notice, setNotice] = useState<{
    readonly conflict: boolean;
    readonly text: string;
  } | null>(null);
  const busy = useRef(false);
  const set = useCallback(
    async (capability: DeviceCapability, on: boolean): Promise<boolean> => {
      const access = machine.access;
      if (!access || busy.current) return false;
      busy.current = true;
      setPending(capability);
      setNotice(null);
      try {
        const result = await hostClient.updateMachineAccess({
          expectedRevision: access.revision,
          policy: withDeviceSwitch(access.policy, capability, on),
          runnerId: machine.id,
        });
        if (result.outcome === "conflict") {
          await hostClient.refresh();
          setNotice({ conflict: true, text: accessConflictNotice });
          return false;
        }
        return true;
      } catch (reason) {
        setNotice({ conflict: false, text: actionErrorMessage(reason) });
        return false;
      } finally {
        busy.current = false;
        setPending(null);
      }
    },
    [hostClient, machine.access, machine.id],
  );
  return { notice, pending, set };
}

export function DeviceAccessSwitches({
  editors,
  machine,
  notice,
  onSet,
  pending,
  remedy,
  switches,
  thisDevice,
}: {
  readonly editors: Partial<Record<DeviceCapability, ReactNode>>;
  readonly machine: MachineSummary;
  readonly notice: { readonly conflict: boolean; readonly text: string } | null;
  readonly onSet: (capability: DeviceCapability, on: boolean) => void;
  readonly pending: DeviceCapability | null;
  /** What fixes a missing macOS grant, where this window can. */
  readonly remedy: Partial<Record<DeviceCapability, ReactNode>>;
  readonly switches: readonly DeviceSwitch[];
  readonly thisDevice: boolean;
}) {
  if (switches.length === 0) return null;
  return (
    <section aria-labelledby="device-uses-title" className="settings-group device-uses">
      <h2 className="settings-group__title" id="device-uses-title">
        Your agent can use
      </h2>
      <div className="card device-uses__card">
        {switches.map((item) => {
          const label = capabilityLabel[item.capability];
          const on = item.kind === "fixed" || item.on;
          const editor = on ? editors[item.capability] : null;
          const waiting = item.kind === "switch" && item.needsMacos;
          return (
            <div className="device-uses__item" key={item.capability}>
              <div className="card__row device-uses__row">
                <span className="card__row-body">
                  <span className="card__row-title" id={`device-use-${item.capability}`}>
                    {label}
                  </span>
                  <span
                    className={`card__row-detail${waiting ? " device-uses__waiting" : ""}`}
                    id={`device-use-${item.capability}-detail`}
                  >
                    {deviceSwitchDetail(item, machine, thisDevice)}
                  </span>
                </span>
                <span className="card__row-actions">
                  {item.kind === "fixed" ? (
                    <span className="chip chip--ok">On</span>
                  ) : (
                    <input
                      aria-describedby={`device-use-${item.capability}-detail`}
                      aria-labelledby={`device-use-${item.capability}`}
                      checked={item.on}
                      className="switch"
                      disabled={pending !== null || !machine.access}
                      onChange={(event) => onSet(item.capability, event.currentTarget.checked)}
                      role="switch"
                      type="checkbox"
                    />
                  )}
                </span>
              </div>
              {waiting && remedy[item.capability] ? (
                <div className="device-uses__remedy">{remedy[item.capability]}</div>
              ) : null}
              {editor ? <div className="device-uses__editor">{editor}</div> : null}
            </div>
          );
        })}
      </div>
      {notice ? (
        <p
          className={notice.conflict ? "notice device-uses__notice" : "notice notice--error"}
          role={notice.conflict ? "status" : "alert"}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
