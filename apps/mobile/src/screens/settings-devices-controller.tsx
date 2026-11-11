import { SettingsComputerEnrollment } from "./settings-computer-enrollment.js";
import { Sheet } from "../ui/sheet.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import { unwrapRpcResult, type HostSnapshot } from "@opensteer/client/host";
import { useHostRead } from "@opensteer/client/react";
import { connectDeviceDraftText } from "@opensteer/client/settings";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { useComputerUseData } from "../computers/use-computer-use-data.js";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import { iphonePermissionOf } from "../iphone-apps/controller.js";
import { iphoneAppIds } from "../iphone-apps/model.js";
import { useHostValue, useMobileState } from "../ui/mobile-client-context.js";
import { useLeaveSheets } from "./leave-sheets.js";
import { DevicesSettingsForm } from "./settings-devices-form.js";
import { computersSettingsRows, otherDevicesSettingsRows } from "./settings-model.js";
import { SettingsPageLayout } from "./settings-page-layout.js";
import { useSettingsHost } from "./use-settings-host.js";
export function DevicesSettingsController(): ReactNode {
  const page = "devices";
  const [adding, setAdding] = useState(false);
  const navigation = useNavigation();
  const { rows, selection } = useMobileState();
  const snapshot = useSettingsHost(selection.hostClient);
  const apps = useComputerUseData(
    page === "devices" ? selection.hostClient : null,
    snapshot?.machineRevision ?? 0,
  );
  const selectedRow = rows.find((row) => row.deploymentId === selection.deploymentId) ?? null;
  const iphoneApps = useIphoneAppsState(useIphoneApps());
  const leave = useLeaveSheets(selection.deploymentId, selection.hostClient);
  const host = selection.hostClient;
  const overview = useHostRead(
    host === null ? null : () => host.rpc["devices.overview.get"]({}).then(unwrapRpcResult),
    "devices-overview",
  );
  const reloadOverview = overview.reload;
  const revision = snapshot?.machineRevision ?? 0;
  const readRevision = useRef(revision);
  useEffect(() => {
    if (readRevision.current === revision) return;
    readRevision.current = revision;
    reloadOverview();
  }, [reloadOverview, revision]);
  useEffect(() => host?.subscribePluginsChanged(reloadOverview), [host, reloadOverview]);
  const waiting = useHostValue(host, selectWaitingThreads, "");
  const otherDevices = useMemo(
    () =>
      otherDevicesSettingsRows(
        overview.data?.otherDevices ?? [],
        new Set(waiting.split(" ").filter(Boolean)),
      ),
    [overview.data, waiting],
  );
  const computers = useMemo(() => {
    if (snapshot === null) return [];
    const deploymentName =
      selectedRow?.name ?? snapshot.identityConfig?.deployment.name ?? "Opensteer";
    const enrollment = iphoneApps.snapshot.enrollment;
    return computersSettingsRows({
      apps: apps.data,
      deploymentName,
      here:
        !iphoneApps.snapshot.supported || selection.deploymentId === null
          ? null
          : {
              approvals: iphoneApps.snapshot.approvals.length,
              available: snapshot.iphoneAppsAvailable,
              deploymentName,
              deviceName: iphoneApps.snapshot.deviceName,
              noun: thisPhoneNoun,
              pendingErasure: iphoneApps.snapshot.pendingErasure === true,
              sharesApps: iphoneAppIds.some(
                (app) => iphonePermissionOf(iphoneApps.snapshot, app) !== null,
              ),
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
          onAddDevice={() => setAdding(true)}
          computers={
            page === "devices"
              ? computers
                  // This phone is listed in every state, including those with nothing to open.
                  .filter((row) => row.opens !== null || row.key === "this-iphone")
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
          otherDevices={otherDevices}
          onOtherDevice={(opens) => {
            if (opens.kind === "task") {
              leave.openThread(opens.threadId);
              return;
            }
            if (selection.deploymentId === null) return;
            navigation.navigate("SettingsPluginDetail", {
              deploymentId: selection.deploymentId,
              target: { kind: "plugin", pluginId: opens.pluginId },
            });
          }}
        />
      </SettingsPageLayout>
      <Sheet open={adding} title="Add device" onClose={() => setAdding(false)}>
        {adding &&
        selection.hostClient ? (
          <SettingsComputerEnrollment host={selection.hostClient} />
        ) : null}
        <NativeSettingsPage
          sections={[
            {
              key: "computer",
              title: "Computer",
              rows: [
                {
                  key: "instructions",
                  kind: "text",
                  label: "Create a command above, then run it on the computer you want to add.",
                },
              ],
            },
            {
              key: "phone",
              title: "Agent Phone",
              rows: [
                {
                  key: "instructions",
                  kind: "text",
                  label:
                    "Connect your Android phone by USB to an enrolled computer. Open Devices there and choose Set up Agent Phone.",
                },
              ],
            },
            ...(iphoneApps.snapshot.supported &&
            snapshot?.iphoneAppsAvailable &&
            iphoneApps.snapshot.enrollment === null &&
            iphoneApps.snapshot.pendingErasure !== true
              ? [
                  {
                    key: "iphone",
                    title: `This ${thisPhoneNoun}`,
                    rows: [
                      {
                        key: "share",
                        kind: "button" as const,
                        label: `Add this ${thisPhoneNoun}`,
                        onPress: () => {
                          setAdding(false);
                          if (selection.deploymentId)
                            navigation.navigate("AddIphone", {
                              deploymentId: selection.deploymentId,
                            });
                        },
                      },
                    ],
                  },
                ]
              : []),
            {
              key: "other",
              title: "Something else",
              rows: [
                {
                  key: "instructions",
                  kind: "text",
                  label:
                    "A TV, speaker, light or anything else on your network. An agent sets it up in a new task.",
                },
                {
                  key: "connect",
                  kind: "button",
                  label: "Connect something else",
                  onPress: () => {
                    setAdding(false);
                    void leave.openNewTask(connectDeviceDraftText);
                  },
                },
              ],
            },
          ]}
        />
      </Sheet>
    </>
  );
}

/** The Threads with a pending Request, as one string so a change elsewhere re-renders nothing. */
const selectWaitingThreads = (snapshot: HostSnapshot): string =>
  snapshot.threads
    .filter((thread) => thread.pendingRequests > 0)
    .map((thread) => thread.id)
    .join(" ");
