import { useUnreadableResources } from "@opensteer/client/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { MachineSummary, OtherDevice } from "@opensteer/protocol";
import {
  computerGlyph,
  deviceWords,
  devicesScreen,
  hostsDeployment,
  type DeviceRowTone,
  type DeviceScreenRow,
  type HomeRowView,
  type HomeSymbol,
  type SignedInDeviceRow,
} from "@opensteer/client/computers";
import { otherDeviceLine } from "@opensteer/client/settings";
import { unwrapRpcResult } from "@opensteer/client/host";
import { isAgentPhone } from "@opensteer/client/integrations";
import { act, failureWords } from "../use-action.js";
import { useShell } from "../app-shell.js";
import { computerIcon } from "../computers/device-art.js";
import { HerePin } from "../computers/here-pin.js";
import { useHereId } from "../computers/here.js";
import { Icon, type IconName } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import {
  SectionHeader,
  SettingsError,
  SettingsSignOut,
  SettingsUnreadable,
} from "../settings/primitives.js";
import { useSettingsRead } from "../settings/use-settings-read.js";
import { useThreadPath } from "../start-task.js";
import { useToast } from "../toast.js";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import { AddDeviceDialog } from "./add-device-dialog.js";
import { useHomeKind } from "./home-facts.js";
import { deviceRoute, otherDeviceRoute } from "./device-routes.js";

export const otherDeviceIcon: Record<OtherDevice["kind"], IconName> = {
  camera: "camera",
  light: "lightbulb",
  other: "plug",
  speaker: "speaker",
  tv: "tv",
};

const deviceKinds = ["machine"] as const;

export function DevicesSection() {
  const { desktopBridge, hostClient, snapshot } = useShell();
  const home = useHomeKind();
  const toast = useToast();
  const hereId = useHereId();
  const [adding, setAdding] = useState(false);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The device whose sign-out did not happen: its confirmation says so, not the page behind it. */
  const [failedSignOut, setFailedSignOut] = useState<string | null>(null);
  // One read each for the page's life, read again when the machines change: a re-read keeps the
  // rows it showed, so a row's open confirmation (Sign out this device?) is never taken away.
  const sessions = useSettingsRead(
    () => hostClient.rpc["sessions.list"]({}).then(unwrapRpcResult),
    "devices-sessions",
  );
  const overview = useSettingsRead(
    () => hostClient.rpc["devices.overview.get"]({}).then(unwrapRpcResult),
    "devices-overview",
  );
  const reread = useRef({ revision: snapshot.machineRevision, sessions, overview });
  reread.current.sessions = sessions;
  reread.current.overview = overview;
  useEffect(() => {
    if (reread.current.revision === snapshot.machineRevision) return;
    reread.current.revision = snapshot.machineRevision;
    void reread.current.sessions.reload();
    void reread.current.overview.reload();
  }, [snapshot.machineRevision]);
  const homeName = snapshot.machines.find(hostsDeployment)?.name ?? "Home";
  const view = devicesScreen({
    machines: snapshot.machines,
    sessions: sessions.data?.sessions ?? [],
    hereId,
    home,
    deploymentName: homeName,
    devicesAvailable: snapshot.devicesAvailable === true,
  });
  const otherDevices = overview.data?.otherDevices ?? [];
  const machinesRead = useUnreadableResources(hostClient, deviceKinds);

  function signOut(row: SignedInDeviceRow) {
    if (signingOut) return;
    setSigningOut(row.session.id);
    setError(null);
    setFailedSignOut(null);
    void act(
      hostClient,
      { label: "sign out this device", done: "signed out", happened: "this device was signed out" },
      () =>
        hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey(`session:${row.session.id}`),
          sessionId: row.session.id,
          type: "session.revoke",
        }),
    )
      .then(() => {
        if (row.session.current) {
          window.location.assign("/");
          return;
        }
        sessions.reload();
        toast.success(`${row.label} is signed out.`);
      })
      .catch((reason: unknown) => {
        // Only an action that did not happen, or whose answer was lost, is said; a confirmed
        // sign-out is never called a failure.
        const words = failureWords(reason);
        if (!words) return;
        setFailedSignOut(row.session.id);
        setError(words);
      })
      .finally(() => setSigningOut(null));
  }

  return (
    <>
      <SectionHeader
        action={
          <span className="devices__add">
            <button className="btn btn--primary" onClick={() => setAdding(true)} type="button">
              <Icon name="plus" />
              {deviceWords("devices.add")}
            </button>
          </span>
        }
        lead={view.lead}
        title={view.title}
      />
      {/* With devices held they stay, with their controls, under the error. */}
      {machinesRead.unreadable && machinesRead.held ? (
        <SettingsUnreadable held label="your devices" onRetry={machinesRead.retry} />
      ) : null}
      {machinesRead.unreadable && !machinesRead.held ? (
        <SettingsUnreadable label="your devices" onRetry={machinesRead.retry} />
      ) : (
        <>
          <section aria-labelledby="devices-home-title" className="settings-group">
            <h2 className="settings-group__title" id="devices-home-title">
              {deviceWords("devices.section.home")}
            </h2>
            <ul className="card devices-list">
              <HomeListRow here={view.home.machineId === hereId} row={view.home} />
            </ul>
          </section>
          {view.devices.length > 0 ? (
            <section aria-labelledby="devices-devices-title" className="settings-group">
              <h2 className="settings-group__title" id="devices-devices-title">
                {deviceWords("devices.section.devices")}
              </h2>
              <ul className="card devices-list">
                {view.devices.map((row) => (
                  <DeviceListRow key={row.machine.id} row={row} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      {sessions.data === null && !sessions.error ? (
        <LoadingRows label="Loading devices" rows={1} />
      ) : view.alsoSignedIn.length > 0 ? (
        <section aria-labelledby="devices-also-title" className="settings-group">
          <h2 className="settings-group__title" id="devices-also-title">
            {deviceWords("devices.section.alsoSignedIn")}
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
                      error={failedSignOut === row.session.id ? error : null}
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
        message={(failedSignOut === null ? error : null) ?? sessions.error ?? overview.error}
      />
      {otherDevices.length > 0 ? <OtherDevices devices={otherDevices} /> : null}
      {adding ? <AddDeviceDialog homeName={homeName} onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function deviceBadge(machine: MachineSummary): string | null {
  if (isAgentPhone(machine) || machine.kind === "agent-phone") return "Agent Phone";
  if (machine.kind === "server") return "Server";
  return null;
}

const homeIcons: Readonly<Record<HomeSymbol, IconName>> = {
  laptop: "laptop",
  server: "server",
  cloud: "cloud",
};

/** One status word, one dot: asleep and needs-update are amber, offline is quiet. */
const toneDots: Readonly<Record<DeviceRowTone, string>> = {
  online: "ok",
  asleep: "warn",
  attention: "warn",
  waiting: "busy",
  offline: "muted",
};

function HomeListRow({ here, row }: { readonly here: boolean; readonly row: HomeRowView }) {
  const body = (
    <>
      <span aria-hidden className="devices-row__glyph">
        <Icon name={homeIcons[row.symbol]} />
      </span>
      <span className="card__row-body">
        <span className="card__row-title devices-row__title">
          <span className="devices-row__name">{row.title}</span>
          {here ? <HerePin /> : null}
        </span>
        <span className="card__row-detail devices-row__status">{row.detail}</span>
      </span>
    </>
  );
  return (
    <li className="devices-list__item">
      {row.machineId ? (
        <Link className="card__row devices-row" to={deviceRoute(row.machineId)}>
          {body}
          <Icon className="devices-row__chevron" name="chevron-right" />
        </Link>
      ) : (
        <span className="card__row devices-row">{body}</span>
      )}
    </li>
  );
}

function DeviceListRow({ row }: { readonly row: DeviceScreenRow }) {
  const { machine } = row;
  const badge = row.thisDevice ? null : deviceBadge(machine);
  const away = row.tone === "offline";
  return (
    <li className="devices-list__item">
      <Link
        className={`card__row devices-row${away ? " devices-row--away" : ""}${row.thisDevice ? " devices-row--here" : ""}`}
        to={deviceRoute(machine.id)}
      >
        <span aria-hidden className="devices-row__glyph">
          <Icon name={computerIcon(computerGlyph(machine))} />
        </span>
        <span className="card__row-body">
          <span className="card__row-title devices-row__title">
            <span className="devices-row__name">{row.title}</span>
            {row.thisDevice ? <HerePin /> : null}
            {badge ? <span className="chip devices-row__badge">{badge}</span> : null}
          </span>
          <span className="card__row-detail devices-row__status">
            <span aria-hidden className={`status-dot status-dot--${toneDots[row.tone]}`} />
            {row.detail}
          </span>
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
                    : otherDeviceRoute(line.opens.pluginId)
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
