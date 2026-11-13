import { useState } from "react";
import { Link } from "react-router";
import type { MachineSummary, OtherDevice } from "@opensteer/protocol";
import {
  computerGlyph,
  devicesView,
  hostsDeployment,
  type DeviceRow,
  type SignedInDeviceRow,
} from "@opensteer/client/computers";
import { otherDeviceLine, pluginPath } from "@opensteer/client/settings";
import { unwrapRpcResult } from "@opensteer/client/host";
import { isAgentPhone } from "@opensteer/client/integrations";
import { actionErrorMessage } from "../../ui-utils.js";
import { useShell } from "../app-shell.js";
import { computerIcon } from "../computers/device-art.js";
import { HerePin } from "../computers/here-pin.js";
import { useHereId } from "../computers/here.js";
import { Icon, type IconName } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { SectionHeader, SettingsError, SettingsSignOut } from "../settings/primitives.js";
import { useSettingsRead } from "../settings/use-settings-read.js";
import { useThreadPath } from "../start-task.js";
import { useToast } from "../toast.js";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import { AddDeviceDialog } from "./add-device-dialog.js";
import { deviceStatusLine, deviceUsesLine } from "./device-access.js";
import { deviceRoute } from "./device-routes.js";

export const otherDeviceIcon: Record<OtherDevice["kind"], IconName> = {
  camera: "camera",
  light: "lightbulb",
  other: "plug",
  speaker: "speaker",
  tv: "tv",
};

export function DevicesSection() {
  const { desktopBridge, hostClient, snapshot } = useShell();
  const toast = useToast();
  const hereId = useHereId();
  const [adding, setAdding] = useState(false);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessions = useSettingsRead(
    () => hostClient.rpc["sessions.list"]({}).then(unwrapRpcResult),
    `devices-sessions:${snapshot.machineRevision}`,
  );
  const overview = useSettingsRead(
    () => hostClient.rpc["devices.overview.get"]({}).then(unwrapRpcResult),
    `devices-overview:${snapshot.machineRevision}`,
  );
  const view = devicesView({
    machines: snapshot.machines,
    sessions: sessions.data?.sessions ?? [],
    hereId,
    otherDevices: overview.data?.otherDevices ?? [],
  });
  const homeName = snapshot.machines.find(hostsDeployment)?.name ?? "Home";

  function signOut(row: SignedInDeviceRow) {
    if (signingOut) return;
    setSigningOut(row.session.id);
    setError(null);
    void hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey(`session:${row.session.id}`),
        sessionId: row.session.id,
        type: "session.revoke",
      })
      .then(() => {
        if (row.session.current) {
          window.location.assign("/");
          return;
        }
        sessions.reload();
        toast.success(`${row.label} is signed out.`);
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setSigningOut(null));
  }

  return (
    <>
      <SectionHeader
        action={
          <button className="btn btn--primary" onClick={() => setAdding(true)} type="button">
            <Icon name="plus" />
            Add a device
          </button>
        }
        lead={`Everywhere you’re signed in. Your agent runs on ${homeName} and reaches the rest.`}
        title="Devices"
      />
      <ul className="card devices-list">
        {view.devices.map((row) => (
          <DeviceListRow here={row.machine.id === hereId} key={row.machine.id} row={row} />
        ))}
      </ul>
      {sessions.data === null && !sessions.error ? (
        <LoadingRows label="Loading devices" rows={1} />
      ) : view.alsoSignedIn.length > 0 ? (
        <section aria-labelledby="devices-also-title" className="settings-group">
          <h2 className="settings-group__title" id="devices-also-title">
            Also signed in
          </h2>
          <p className="settings-group__caption">{view.alsoSignedInCaption}</p>
          <ul className="card devices-list">
            {view.alsoSignedIn.map((row) => {
              const browserWindow = row.session.current && desktopBridge === null;
              const title = browserWindow ? "This browser window" : row.label;
              return (
                <li className="card__row devices-row devices-row--signed-in" key={row.session.id}>
                  <span aria-hidden className="devices-row__glyph">
                    <Icon name={row.session.form === "mobile" ? "phone" : "globe"} />
                  </span>
                  <span className="card__row-body">
                    <span className="card__row-title">{title}</span>
                    <span className="card__row-detail">
                      {browserWindow ? `${row.label} · Runs nothing itself` : row.status}
                    </span>
                  </span>
                  <span className="card__row-actions">
                    <SettingsSignOut
                      label={`Sign out ${title}`}
                      onConfirm={() => signOut(row)}
                      pending={signingOut !== null}
                      warning={`${title} loses access. Your agent, files and tasks stay on this Opensteer.`}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <SettingsError
        message={
          error ??
          (sessions.error ? actionErrorMessage(sessions.error) : null) ??
          (overview.error ? actionErrorMessage(overview.error) : null)
        }
      />
      {view.otherDevices.length > 0 ? <OtherDevices devices={view.otherDevices} /> : null}
      {adding ? <AddDeviceDialog homeName={homeName} onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function deviceBadge(machine: MachineSummary, here: boolean): string | null {
  if (here || hostsDeployment(machine)) return null;
  if (isAgentPhone(machine) || machine.kind === "agent-phone") return "Agent Phone";
  if (machine.kind === "server") return "Server";
  return null;
}

function DeviceListRow({ here, row }: { readonly here: boolean; readonly row: DeviceRow }) {
  const { snapshot } = useShell();
  const { machine } = row;
  const badge = deviceBadge(machine, here);
  const uses = deviceUsesLine(machine, snapshot.devicesAvailable === true);
  const away = machine.status === "offline";
  return (
    <li className="devices-list__item">
      <Link
        className={`card__row devices-row${away ? " devices-row--away" : ""}${here ? " devices-row--here" : ""}`}
        to={deviceRoute(machine.id)}
      >
        <span aria-hidden className="devices-row__glyph">
          <Icon name={computerIcon(computerGlyph(machine))} />
        </span>
        <span className="card__row-body">
          <span className="card__row-title devices-row__title">
            <span className="devices-row__name">{row.label}</span>
            {here ? <HerePin /> : null}
            {badge ? <span className="chip devices-row__badge">{badge}</span> : null}
          </span>
          <span className="card__row-detail devices-row__status">{deviceStatusLine(machine)}</span>
          {uses && !hostsDeployment(machine) ? (
            <span className="card__row-detail devices-row__uses">{uses}</span>
          ) : null}
        </span>
        <Icon className="devices-row__chevron" name="chevron-right" />
      </Link>
    </li>
  );
}

function OtherDevices({ devices }: { readonly devices: readonly OtherDevice[] }) {
  const { snapshot } = useShell();
  const threadPath = useThreadPath();
  return (
    <section aria-labelledby="other-devices-title" className="settings-group">
      <h2 className="settings-group__title" id="other-devices-title">
        Other devices
      </h2>
      <ul className="card devices-list">
        {devices.map((device) => {
          const task = snapshot.threads.find((thread) => thread.id === device.setupThreadId);
          const line = otherDeviceLine(device, (task?.pendingRequests ?? 0) > 0);
          return (
            <li className="devices-list__item" key={device.pluginId}>
              <Link
                className="card__row devices-row"
                to={
                  line.opens.kind === "task"
                    ? threadPath(line.opens.threadId)
                    : pluginPath({ kind: "plugin", pluginId: line.opens.pluginId })
                }
              >
                <span aria-hidden className="devices-row__glyph">
                  <Icon name={otherDeviceIcon[device.kind]} />
                </span>
                <span className="card__row-body">
                  <span className="card__row-title">{device.name}</span>
                  <span className="card__row-detail">{line.detail}</span>
                </span>
                <span
                  aria-hidden
                  className={`status-dot status-dot--${line.tone === "attention" ? "warn" : line.tone}`}
                />
                <Icon className="devices-row__chevron" name="chevron-right" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
