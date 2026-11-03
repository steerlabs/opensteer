import { settingsDeviceRows } from "@opensteer/client/settings";
import { Link } from "react-router";
import { unwrapRpcResult } from "@opensteer/client/host";
import { useShell } from "../../app-shell.js";
import { currentDeviceMachineId } from "../../computers-page.js";
import { SettingsError, SectionHeader } from "../primitives.js";
import { useSettingsRead } from "../use-settings-read.js";
import { actionErrorMessage } from "../../../ui-utils.js";
export function AgentDevicesSection() {
  const { hostClient, snapshot, desktopBridge, desktopDeployment, localExecutionStatus } =
    useShell();
  const devices = useSettingsRead(
    () => hostClient.rpc["devices.overview.get"]({}).then(unwrapRpcResult),
    "settings-devices",
  );
  const localId = desktopBridge
    ? currentDeviceMachineId({
        deploymentKind: snapshot.deploymentShape?.kind ?? null,
        hostsDeploymentOnThisComputer: desktopDeployment?.onThisComputer === true,
        localRunnerId: localExecutionStatus?.runner.runnerId ?? null,
        machines: snapshot.machines,
      })
    : null;
  return (
    <>
      <SectionHeader title="Devices" lead={null} />
      <Link className="btn btn--primary" to="/settings/devices/computers">
        Add device
      </Link>
      <SettingsError message={devices.error ? actionErrorMessage(devices.error) : null} />
      <ul className="card settings-device-list">
        {settingsDeviceRows(devices.data?.devices ?? [], localId).map((device) => (
          <li key={device.id} className="card__row">
            <Link className="card__row-body" to={`/settings/devices/computers/${device.id}`}>
              <span className="card__row-title">
                {device.name}
                {device.thisDevice ? <span className="chip">This device</span> : null}
              </span>
              <span className="card__row-detail">{device.status}</span>
            </Link>
          </li>
        ))}
      </ul>
      {!devices.data ? (
        <p role="status">Loading devices…</p>
      ) : devices.data.devices.length === 0 ? (
        <p>No devices added.</p>
      ) : null}
    </>
  );
}
