import type { DeploymentId } from "@opensteer/core";
import type { IphoneSetupPort } from "@opensteer/client/host";
import type { DesktopIphoneSetupReason } from "@opensteer/protocol/desktop";
import { useEffect, useId, useRef, useState } from "react";
import { iphoneSetupWords, wifiRetryAction } from "./iphone-setup-words.js";

type WifiStatus = Awaited<ReturnType<IphoneSetupPort["wifiStatus"]>>;
type WifiAction = "enable" | "disable" | "pair";

/**
 * Whether an iPhone this Mac drives also works on the same Wi‑Fi, and the switch
 * that changes it. Only Opensteer on that Mac can answer, so the row is left out
 * when this Mac doesn't hold the iPhone.
 */
export function IphoneWifiRow({
  deploymentId,
  deploymentName,
  deviceId,
  macName,
  port,
  revision,
}: {
  readonly deploymentId: DeploymentId;
  readonly deploymentName: string;
  readonly deviceId: string;
  readonly macName: string;
  readonly port: IphoneSetupPort;
  /** Changes when the Host's devices do, which is when the phone's route may have. */
  readonly revision: unknown;
}) {
  const [status, setStatus] = useState<WifiStatus | "checking" | "not-here">("checking");
  const [failure, setFailure] = useState<DesktopIphoneSetupReason | null>(null);
  const [busy, setBusy] = useState<WifiAction | null>(null);
  const last = useRef<WifiAction>("enable");
  // Only the newest answer counts; an older status read can land after a change.
  const latest = useRef(0);
  const titleId = useId();

  useEffect(() => {
    const mine = ++latest.current;
    port.wifiStatus({ deploymentId, deviceId }).then(
      (next) => {
        if (latest.current === mine) setStatus(next);
      },
      () => {
        if (latest.current === mine) setStatus("not-here");
      },
    );
  }, [port, deploymentId, deviceId, revision]);

  if (status === "not-here") return null;

  async function configure(action: WifiAction) {
    const mine = ++latest.current;
    last.current = action;
    setBusy(action);
    setFailure(null);
    try {
      const next = await port.configureWifi({ deploymentId, deviceId, action });
      if (latest.current !== mine) return;
      setStatus(next);
      setFailure(next.reason);
    } catch {
      if (latest.current === mine) setFailure("native-service-failed");
    } finally {
      if (latest.current === mine) setBusy(null);
    }
  }

  const known = status === "checking" ? null : status;
  const reachable = known?.transport != null;
  const words = failure
    ? iphoneSetupWords(failure, { deploymentName, osVersion: null, step: "wifi" })
    : null;
  const detail =
    busy === "enable" || busy === "pair"
      ? "Turning on… If the iPhone asks, tap Trust and enter its passcode."
      : busy === "disable"
        ? "Turning off…"
        : !known
          ? "Checking…"
          : wifiLine(known, macName);

  return (
    <>
      <div className="card__row device-uses__row">
        <span className="card__row-body">
          <span className="card__row-title" id={titleId}>
            Same Wi‑Fi
          </span>
          <span className="card__row-detail card__row-detail--wrap" id={`${titleId}-detail`}>
            {detail}
          </span>
        </span>
        <span className="card__row-actions">
          <input
            aria-describedby={`${titleId}-detail`}
            aria-labelledby={titleId}
            checked={busy ? busy !== "disable" : (known?.enabled ?? false)}
            className="switch"
            disabled={busy !== null || !reachable}
            onChange={(event) => void configure(event.currentTarget.checked ? "enable" : "disable")}
            role="switch"
            type="checkbox"
          />
        </span>
      </div>
      {words && !busy ? (
        <div className="iphone-wifi__fix" role="alert">
          <p>
            <strong>{words.title}.</strong> {words.detail}
          </p>
          {words.instructions ? (
            <ol className="iphone-setup__steps">
              {words.instructions.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          ) : null}
          {words.recovery === "none" ? null : (
            <button
              className="btn btn--small"
              onClick={() => void configure(wifiRetryAction(failure, last.current))}
              type="button"
            >
              {words.action ?? "Try again"}
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

function wifiLine(status: WifiStatus, macName: string): string {
  if (!status.transport)
    return status.enabled
      ? `On. Not connected now: plug it into ${macName} or join the same Wi‑Fi.`
      : `Off. Plug it into ${macName} to change this.`;
  if (!status.enabled) return `Off. It works only while plugged into ${macName}.`;
  return status.transport === "wifi"
    ? `On, and connected over Wi‑Fi now. Works on the same Wi‑Fi as ${macName} or plugged in.`
    : `On. Plugged in now; also works on the same Wi‑Fi as ${macName}.`;
}
