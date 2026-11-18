import { Link, useNavigate, useParams } from "react-router";
import { unwrapRpcResult } from "@opensteer/client/host";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageHeader, PageTopbar } from "../page-header.js";
import { LocalServerSection } from "../plugins/local-server-section.js";
import { SettingsError, SettingsRow } from "../settings/primitives.js";
import { useSettingsRead } from "../settings/use-settings-read.js";
import { useThreadPath } from "../start-task.js";
import { DevicesBackLink } from "./device-page.js";
import { deviceRoute, devicesRoute } from "./device-routes.js";

/** One device that runs no Opensteer, reached through a local server on one of the computers. */
export function OtherDevicePage() {
  const { pluginId = "" } = useParams();
  const { hostClient, openMobileNavigation, snapshot } = useShell();
  const navigate = useNavigate();
  const threadPath = useThreadPath();
  const overview = useSettingsRead(
    () => hostClient.rpc["devices.overview.get"]({}).then(unwrapRpcResult),
    "devices-overview",
    true,
  );
  const device = overview.data?.otherDevices?.find((each) => each.pluginId === pluginId) ?? null;
  const task = device?.setupThreadId
    ? (snapshot.threads.find((thread) => thread.id === device.setupThreadId) ?? null)
    : null;
  return (
    <div className="page device-page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title={device?.name ?? "Device"} />
      <div className="page__content device-page__content">
        <DevicesBackLink />
        <SettingsError message={overview.error} />
        {device ? (
          <>
            <PageHeader title={device.name} />
            {device.issue ? (
              <p className="notice notice--warn" role="status">
                {device.issue}
              </p>
            ) : null}
            <section className="settings-group">
              <div className="card">
                {device.computer ? (
                  <Link className="card__row plugins-link-row" to={deviceRoute(device.computer.id)}>
                    <span className="card__row-body">
                      <span className="card__row-title">{`Through ${device.computer.name}`}</span>
                      <span className="card__row-detail">
                        {device.computer.status === "online"
                          ? "Its server runs there"
                          : `Waiting for ${device.computer.name}`}
                      </span>
                    </span>
                    <Icon name="chevron-right" />
                  </Link>
                ) : null}
                {device.setupThreadId ? (
                  <SettingsRow
                    title="Set up in"
                    detail={
                      <Link to={threadPath(device.setupThreadId)}>
                        {task?.title ?? "Open task"}
                      </Link>
                    }
                  />
                ) : null}
              </div>
            </section>
            <LocalServerSection
              by={{ pluginId: device.pluginId }}
              name={device.name}
              onRemoved={() => void navigate(devicesRoute)}
            />
          </>
        ) : overview.data ? (
          <>
            <PageHeader title="Device not found" />
            <p className="card__empty">It may have been removed.</p>
          </>
        ) : overview.error ? null : (
          <LoadingRows label="Loading device" rows={3} />
        )}
      </div>
    </div>
  );
}
