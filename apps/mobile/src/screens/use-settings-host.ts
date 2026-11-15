import { canRespondToRequests, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import { useCallback, useRef, useSyncExternalStore } from "react";
interface EngineInstallationRow {
  readonly driverKind: string;
  readonly environmentId: string;
  readonly installation: NonNullable<
    HostSnapshot["environments"][number]["harnessDrivers"][number]["installation"]
  >;
}

interface SettingsHost {
  readonly deploymentShape: HostSnapshot["deploymentShape"];
  readonly engineInstallations: readonly EngineInstallationRow[];
  readonly harnessUpdateAvailable: boolean;
  readonly hostConnected: boolean;
  readonly identityConfig: HostSnapshot["identityConfig"];
  readonly iphoneAppsAvailable: boolean;
  readonly machineRevision: number;
  readonly machines: HostSnapshot["machines"];
  /** Null while the Host does not move quiet tasks to Done, or has not said after how long. */
  readonly quietTaskDays: HostSnapshot["quietTaskDays"];
}

/**
 * The open Deployment's Host as Settings needs it, or null while none is open.
 * Settings stands over any screen, including a reply streaming underneath, so
 * it reads without loading and re-renders only when something it shows moves.
 */
export function useSettingsHost(hostClient: HostClient | null): SettingsHost | null {
  const cached = useRef<SettingsHost | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => hostClient?.subscribe(listener) ?? (() => undefined),
    [hostClient],
  );
  const read = useCallback((): SettingsHost | null => {
    if (hostClient === null) return null;
    const snapshot = hostClient.getSnapshot();
    const previous = cached.current;
    const installations = snapshot.environments.flatMap((environment) =>
      environment.harnessDrivers.flatMap((driver) =>
        driver.installation
          ? [
              {
                driverKind: driver.driverKind,
                environmentId: environment.id,
                installation: driver.installation,
              },
            ]
          : [],
      ),
    );
    // Environments change on every catalog refresh; keep the rows' identity
    // while nothing an Update row shows has moved.
    const engineInstallations =
      previous !== null &&
      JSON.stringify(previous.engineInstallations) === JSON.stringify(installations)
        ? previous.engineInstallations
        : installations;
    const next: SettingsHost = {
      deploymentShape: snapshot.deploymentShape,
      engineInstallations,
      harnessUpdateAvailable: snapshot.harnessUpdateAvailable === true,
      hostConnected: canRespondToRequests(snapshot),
      identityConfig: snapshot.identityConfig,
      iphoneAppsAvailable: snapshot.iphoneAppsAvailable,
      machineRevision: snapshot.machineRevision,
      machines: snapshot.machines,
      quietTaskDays: snapshot.quietTasksAvailable === true ? snapshot.quietTaskDays : null,
    };
    if (
      previous !== null &&
      (Object.keys(next) as (keyof SettingsHost)[]).every((key) => previous[key] === next[key])
    ) {
      return previous;
    }
    cached.current = next;
    return next;
  }, [hostClient]);
  return useSyncExternalStore(subscribe, read, read);
}
