import { hostDeploymentPolicy } from "@opensteer/client/host";
import { Icon } from "../../icon.js";
import { Dialog } from "../../dialog.js";
import { AddPhoneDialog } from "../../computers/add-phone-dialog.js";
import { useState } from "react";
import { AddComputerDialog } from "../../computers/add-computer-dialog.js";
import { localJoinOffer } from "../../../desktop/desktop-bridge.js";
import {
  connectDeviceDraftText,
  otherDeviceLine,
  pluginPath,
  settingsDeviceRows,
} from "@opensteer/client/settings";
import type { OtherDevice } from "@opensteer/protocol";
import type { IconName } from "../../icon.js";
import { useStartTask, useThreadPath } from "../../start-task.js";
import { Link } from "react-router";
import { unwrapRpcResult } from "@opensteer/client/host";
import { useShell } from "../../app-shell.js";
import { currentDeviceMachineId } from "../../computers-page.js";
import { deviceBrowser, deviceLendsApps } from "@opensteer/client/computers";
import { isAgentPhone } from "@opensteer/client/integrations";
import { SettingsError, SectionHeader } from "../primitives.js";
import { useSettingsRead } from "../use-settings-read.js";
import { actionErrorMessage } from "../../../ui-utils.js";
export function AgentDevicesSection() {
  const shell = useShell();
  const { hostClient, snapshot, desktopBridge, desktopDeployment, localExecutionStatus } = shell;
  const [adding, setAdding] = useState<"choose" | "computer" | "phone" | null>(null);
  const startTask = useStartTask();
  const devices = useSettingsRead(
    () => hostClient.rpc["devices.overview.get"]({}).then(unwrapRpcResult),
    `settings-devices:${snapshot.machineRevision}`,
  );
  const localId = desktopBridge
    ? currentDeviceMachineId({
        deploymentPolicy: hostDeploymentPolicy(snapshot) ?? null,
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
          deploymentPolicy={hostDeploymentPolicy(snapshot) ?? null}
          deploymentName={snapshot.identityConfig?.deployment.name ?? "Opensteer"}
          homeName={
            snapshot.machines.find((machine) => machine.ownership === "deployment")?.name ?? "Main"
          }
          hostedOnThisComputer={desktopDeployment?.onThisComputer === true}
          localExecutionAction={shell.localExecutionAction}
          localExecutionError={shell.localExecutionError}
          localExecutionStatus={localExecutionStatus}
          offer={localJoinOffer({
            deploymentPolicy: hostDeploymentPolicy(snapshot) ?? null,
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
          <button
            className="card card__row"
            type="button"
            onClick={() => {
              setAdding(null);
              startTask(connectDeviceDraftText);
            }}
          >
            <span className="card__row-body">
              <span>Something else</span>
              <span className="card__row-detail">Tell an agent what to connect</span>
            </span>
          </button>
          <p>To share iPhone apps, open Devices in Opensteer on that iPhone.</p>
        </Dialog>
      ) : null}
      {adding === "phone" ? (
        <AddPhoneDialog
          client={hostClient}
          deploymentPolicy={hostDeploymentPolicy(snapshot) ?? null}
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
                {hostDeploymentPolicy(snapshot)?.deploymentOwnsMainComputer === true &&
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
                        app.definitionId === "apple-messages"
                          ? "iMessage"
                          : app.definitionId === "macos-app"
                            ? "Computer use"
                            : app.definitionId.replace(/^apple-/, "").replaceAll("-", " "),
                      )
                      .join(", ") ||
                    (isAgentPhone(device)
                      ? "Agent Phone"
                      : snapshot.machines.some(
                            (machine) =>
                              machine.id === device.id &&
                              !deviceLendsApps(machine) &&
                              deviceBrowser(machine, [])?.kind === "lent",
                          )
                        ? "Browser"
                        : "Apps and files")
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
      {devices.data?.otherDevices?.length ? (
        <OtherDevices devices={devices.data.otherDevices} />
      ) : null}
    </>
  );
}

export const otherDeviceIcon: Record<OtherDevice["kind"], IconName> = {
  camera: "camera",
  light: "lightbulb",
  other: "plug",
  speaker: "speaker",
  tv: "tv",
};

/** Things that run no Opensteer, reached through a plugin's server on one of these computers. */
function OtherDevices({ devices }: { readonly devices: readonly OtherDevice[] }) {
  const { snapshot } = useShell();
  const threadPath = useThreadPath();
  return (
    <section aria-labelledby="other-devices-title" className="settings-group">
      <h2 className="settings-group__title" id="other-devices-title">
        Other devices
      </h2>
      <ul className="card settings-device-list">
        {devices.map((device) => {
          const task = snapshot.threads.find((thread) => thread.id === device.setupThreadId);
          const line = otherDeviceLine(device, (task?.pendingRequests ?? 0) > 0);
          return (
            <li key={device.pluginId} className="card__row">
              <span className="card__row-glyph">
                <Icon name={otherDeviceIcon[device.kind]} />
              </span>
              <Link
                className="card__row-body"
                to={
                  line.opens.kind === "task"
                    ? threadPath(line.opens.threadId)
                    : pluginPath({ kind: "plugin", pluginId: line.opens.pluginId })
                }
              >
                <span className="card__row-title">{device.name}</span>
                <span className="card__row-detail">{line.detail}</span>
              </Link>
              <span
                className={`status-dot status-dot--${line.tone === "attention" ? "warn" : line.tone}`}
                aria-hidden
              />
              <Icon name="chevron-right" />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
