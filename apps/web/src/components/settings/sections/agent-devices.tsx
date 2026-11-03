import { Icon } from "../../icon.js";
import { Dialog } from "../../dialog.js";
import { AddPhoneDialog } from "../../computers/add-phone-dialog.js";
import { useState } from "react";
import { AddComputerDialog } from "../../computers/add-computer-dialog.js";
import { localJoinOffer } from "../../../desktop/desktop-bridge.js";
import { settingsDeviceRows } from "@opensteer/client/settings";
import { Link } from "react-router";
import { unwrapRpcResult } from "@opensteer/client/host";
import { useShell } from "../../app-shell.js";
import { currentDeviceMachineId } from "../../computers-page.js";
import { SettingsError, SectionHeader } from "../primitives.js";
import { useSettingsRead } from "../use-settings-read.js";
import { actionErrorMessage } from "../../../ui-utils.js";
export function AgentDevicesSection() {
  const shell = useShell();
  const { hostClient, snapshot, desktopBridge, desktopDeployment, localExecutionStatus } = shell;
  const [adding, setAdding] = useState<"choose" | "computer" | "phone" | null>(null);
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
      <SectionHeader
        title="Devices"
        action={
          <button className="btn btn--primary" type="button" onClick={() => setAdding("choose")}>
            Add device
          </button>
        }
      />
      {adding === "computer" ? (
        <AddComputerDialog
          client={hostClient}
          deploymentKind={snapshot.deploymentShape?.kind ?? null}
          deploymentName={snapshot.identityConfig?.deployment.name ?? "Opensteer"}
          homeName={
            snapshot.machines.find((machine) => machine.ownership === "deployment")?.name ?? "Main"
          }
          hostedOnThisComputer={desktopDeployment?.onThisComputer === true}
          localExecutionAction={shell.localExecutionAction}
          localExecutionError={shell.localExecutionError}
          localExecutionStatus={localExecutionStatus}
          offer={localJoinOffer({
            deploymentKind: snapshot.deploymentShape?.kind ?? null,
            status: localExecutionStatus,
          })}
          onAddThisComputer={async (action) => {
            await shell.performLocalExecutionAction(action);
            setAdding(null);
          }}
          onClose={() => setAdding(null)}
          snapshot={snapshot}
        />
      ) : null}
      {adding === "choose" ? (
        <Dialog title="Add device" labelledBy="add-device-title" onClose={() => setAdding(null)}>
          <button className="card card__row" type="button" onClick={() => setAdding("computer")}>
            Computer
          </button>
          <button className="card card__row" type="button" onClick={() => setAdding("phone")}>
            Android Agent Phone
          </button>
          <p>To share iPhone apps, open Devices in Opensteer on that iPhone.</p>
        </Dialog>
      ) : null}
      {adding === "phone" ? (
        <AddPhoneDialog
          client={hostClient}
          deploymentKind={snapshot.deploymentShape?.kind ?? null}
          deploymentName={snapshot.identityConfig?.deployment.name ?? "Opensteer"}
          desktopBridge={desktopBridge}
          homeName={
            snapshot.machines.find((machine) => machine.ownership === "deployment")?.name ?? "Main"
          }
          onClose={() => setAdding(null)}
        />
      ) : null}
      <SettingsError message={devices.error ? actionErrorMessage(devices.error) : null} />
      <ul className="card settings-device-list">
        {settingsDeviceRows(devices.data?.devices ?? [], localId).map((device) => (
          <li key={device.id} className="card__row">
            <span className="card__row-glyph">
              <Icon name={device.device?.form === "phone" ? "phone" : "desktop"} />
            </span>
            <Link className="card__row-body" to={`/settings/devices/computers/${device.id}`}>
              <span className="card__row-title">
                {device.name}
                {snapshot.deploymentShape?.kind === "personal" &&
                device.ownership === "deployment" &&
                device.allowedModules.includes("agents") ? (
                  <span className="chip">Main</span>
                ) : null}
                {device.thisDevice ? <span className="chip">This device</span> : null}
              </span>
              <span className="card__row-detail">
                {device.status === "online"
                  ? snapshot.machines
                      .find((machine) => machine.id === device.id)
                      ?.apps?.map((app) =>
                        app.definitionId.replace(/^apple-/, "").replaceAll("-", " "),
                      )
                      .join(", ") ||
                    (device.device?.platform === "android" ? "Agent Phone" : "Apps and files")
                  : device.status === "offline"
                    ? "Offline"
                    : device.status}
              </span>
            </Link>
            <span
              className={`status-dot status-dot--${device.status === "online" ? "ok" : "muted"}`}
              aria-label={device.status}
            />
            <Icon name="chevron-right" />
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
