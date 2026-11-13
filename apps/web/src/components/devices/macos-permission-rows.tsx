import { useCallback, useEffect, useState } from "react";
import type {
  DesktopComputerUsePermissionsResult,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { Icon } from "../icon.js";
import { SetupRow } from "../first-run/setup-list.js";

export type MacosGrants = {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  readonly fullDiskAccess: boolean;
} | null;

/**
 * This Mac's grants as macOS reports them now. They change in System Settings,
 * so they are read again whenever this window comes back to the front.
 */
export function useMacosGrants(bridge: OpensteerDesktopBridge | null): {
  readonly grants: MacosGrants;
  readonly reload: () => void;
} {
  const [grants, setGrants] = useState<MacosGrants>(null);
  const reload = useCallback(() => {
    if (!bridge) return;
    void Promise.all([
      bridge.computerUsePermissionsGet().catch(() => null),
      bridge.checkFullDiskAccess().catch(() => null),
    ]).then(
      ([apps, disk]: [DesktopComputerUsePermissionsResult | null, { granted: boolean } | null]) =>
        setGrants({
          accessibility: apps?.accessibility === "granted",
          screenRecording: apps?.screenRecording === "granted",
          fullDiskAccess: disk?.granted === true,
        }),
    );
  }, [bridge]);
  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return { grants, reload };
}

/** Whether a switch that is on still waits on macOS here. */
export function missingMacosGrant(
  grants: MacosGrants,
  capability: "browser" | "apps" | "files",
): boolean {
  if (!grants) return false;
  if (capability === "apps") return !grants.accessibility || !grants.screenRecording;
  if (capability === "files") return !grants.fullDiskAccess;
  return false;
}

/**
 * One row per macOS grant the switches that are on need, each turning green
 * as soon as macOS reports it.
 */
export function MacosPermissionRows({
  apps,
  bridge,
  files,
  grants,
  onAsked,
}: {
  readonly apps: boolean;
  readonly bridge: OpensteerDesktopBridge;
  readonly files: boolean;
  readonly grants: MacosGrants;
  readonly onAsked: () => void;
}) {
  const ask = (operation: () => Promise<unknown>) => void operation().then(onAsked, onAsked);
  return (
    <>
      {apps ? (
        <>
          <GrantRow
            allowed={grants?.accessibility ?? null}
            detail="For Apps · lets your agent click and type"
            onOpen={() =>
              ask(() => bridge.computerUsePermissionsRequest({ pane: "accessibility" }))
            }
            title="Accessibility"
          />
          <GrantRow
            allowed={grants?.screenRecording ?? null}
            detail="For Apps · lets your agent and your phone see its windows"
            onOpen={() =>
              ask(() => bridge.computerUsePermissionsRequest({ pane: "screen-recording" }))
            }
            title="Screen Recording"
          />
        </>
      ) : null}
      {files ? (
        <GrantRow
          allowed={grants?.fullDiskAccess ?? null}
          detail="For Files and commands · reach folders like Documents and Desktop"
          onOpen={() => ask(() => bridge.requestFullDiskAccess())}
          title="Full Disk Access"
        />
      ) : null}
    </>
  );
}

function GrantRow({
  allowed,
  detail,
  onOpen,
  title,
}: {
  readonly allowed: boolean | null;
  readonly detail: string;
  readonly onOpen: () => void;
  readonly title: string;
}) {
  return (
    <SetupRow
      detail={detail}
      title={title}
      tone={allowed ? "ready" : "idle"}
      trailing={
        allowed === null ? (
          <span aria-label="Checking" className="spinner" role="status" />
        ) : allowed ? (
          <span className="setup-done">
            <Icon name="check" />
            Allowed
          </span>
        ) : (
          <button className="btn btn--small" onClick={onOpen} type="button">
            Open System Settings
          </button>
        )
      }
    />
  );
}
