import { useNavigation } from "@react-navigation/native";
import { useMemo, type ReactNode } from "react";
import { useComputerUseData } from "../computers/use-computer-use-data.js";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { DevicesSettingsForm } from "./settings-devices-form.js";
import { computersSettingsRows } from "./settings-model.js";
import { SettingsPageLayout } from "./settings-page-layout.js";
import { useSettingsHost } from "./use-settings-host.js";
export function DevicesSettingsController(): ReactNode {
  const page = "devices";
  const navigation = useNavigation();
  const { rows, selection } = useMobileState();
  const snapshot = useSettingsHost(selection.hostClient);
  const apps = useComputerUseData(
    page === "devices" ? selection.hostClient : null,
    snapshot?.machineRevision ?? 0,
  );
  const selectedRow = rows.find((row) => row.deploymentId === selection.deploymentId) ?? null;
  const iphoneApps = useIphoneAppsState(useIphoneApps());
  const computers = useMemo(() => {
    if (snapshot === null) return [];
    const deploymentName =
      selectedRow?.name ?? snapshot.identityConfig?.deployment.name ?? "Opensteer";
    const enrollment = iphoneApps.snapshot.enrollment;
    return computersSettingsRows({
      apps: apps.data,
      deploymentKind: snapshot.deploymentShape?.kind ?? null,
      deploymentName,
      here:
        !iphoneApps.snapshot.supported || selection.deploymentId === null
          ? null
          : {
              approvals: iphoneApps.snapshot.approvals.length,
              available: snapshot.iphoneAppsAvailable,
              deploymentName,
              deviceName: iphoneApps.snapshot.deviceName,
              heldBy:
                enrollment === null
                  ? null
                  : {
                      deploymentId: enrollment.deploymentId,
                      deploymentName:
                        rows.find((row) => row.deploymentId === enrollment.deploymentId)?.name ??
                        enrollment.deploymentName,
                      enrollmentId: enrollment.enrollmentId,
                      name: enrollment.name,
                      runnerId: enrollment.runnerId,
                      state: enrollment.state,
                    },
              removed: iphoneApps.removedFrom?.deploymentId === selection.deploymentId,
              selectedDeploymentId: selection.deploymentId,
            },
      hostConnected: snapshot.hostConnected,
      machines: snapshot.machines,
      publicOrigin: snapshot.identityConfig?.publicOrigin ?? null,
    });
  }, [apps.data, iphoneApps, rows, selectedRow?.name, selection.deploymentId, snapshot]);

  return (
    <>
      <SettingsPageLayout>
        <DevicesSettingsForm
          page={page}
          computers={
            page === "devices"
              ? computers
                  .filter((row) => row.opens !== null)
                  .map((row) => ({
                    ...row,
                    detail: row.detail
                      .replace("You’re here", "This device")
                      .replace("You're here", "This device"),
                  }))
              : computers
          }
          onComputerAction={(destination) => {
            if (selection.deploymentId === null) return;
            if (destination.kind === "add-iphone") {
              navigation.navigate("AddIphone", { deploymentId: selection.deploymentId });
              return;
            }
            navigation.navigate("SettingsDeviceDetail", {
              deploymentId: destination.deploymentId ?? selection.deploymentId,
              machineId: destination.machineId,
            });
          }}
        />
      </SettingsPageLayout>
    </>
  );
}
