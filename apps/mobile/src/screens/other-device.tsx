import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { ReactNode } from "react";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { useLeaveSheets } from "./leave-sheets.js";
import { useLocalServerSections } from "./local-server-sections.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow } from "./native-settings-page.types.js";
import { usePluginRead } from "./use-plugin-read.js";

type Params = StaticScreenProps<{ readonly deploymentId: string; readonly pluginId: string }>;

/** One device that runs no Opensteer, reached through a local server on one of the computers. */
export function OtherDeviceScreen({ route }: Params): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <OtherDevice
      deploymentId={route.params.deploymentId}
      host={host}
      key={`${route.params.deploymentId}:${route.params.pluginId}`}
      pluginId={route.params.pluginId}
    />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

function OtherDevice(props: { deploymentId: string; host: HostClient; pluginId: string }) {
  const { deploymentId, host, pluginId } = props;
  const navigation = useNavigation();
  const leave = useLeaveSheets(deploymentId, host);
  const overview = usePluginRead(
    host,
    () => host.rpc["devices.overview.get"]({}).then(unwrapRpcResult),
    "other-devices",
    "devices",
  );
  const device = overview.data?.otherDevices?.find((each) => each.pluginId === pluginId) ?? null;
  const server = useLocalServerSections({
    host,
    deploymentId,
    by: { pluginId },
    name: device?.name ?? "this device",
    onRemoved: () => navigation.goBack(),
  });
  if (!device)
    return (
      <NativeSettingsPage
        sections={[
          {
            key: "gone",
            title: "",
            rows: [
              {
                key: "gone",
                kind: "text",
                label: overview.data
                  ? "This device isn't here any more."
                  : (overview.error ?? "Loading…"),
              },
            ],
          },
        ]}
      />
    );
  const computer = device.computer;
  const setupThreadId = device.setupThreadId;
  const setupTitle = setupThreadId
    ? (host.getSnapshot().threads.find(({ id }) => id === setupThreadId)?.title ?? null)
    : null;
  const rows: NativeSettingsRow[] = [
    { key: "name", kind: "text", label: device.name },
    ...(device.issue
      ? [{ key: "issue", kind: "status" as const, tone: "attention" as const, label: device.issue }]
      : []),
    ...(computer
      ? [
          {
            key: "computer",
            kind: "button" as const,
            label: `Through ${computer.name}`,
            detail:
              computer.status === "online"
                ? "Its server runs there"
                : `Waiting for ${computer.name}`,
            opens: true,
            onPress: () =>
              navigation.navigate("SettingsDeviceDetail", { deploymentId, machineId: computer.id }),
          },
        ]
      : []),
    ...(setupThreadId
      ? [
          {
            key: "setup",
            kind: "button" as const,
            label: setupTitle ? `Set up in ${setupTitle}` : "Set up in a task",
            opens: true,
            onPress: () => leave.openThread(setupThreadId),
          },
        ]
      : []),
  ];
  return (
    <>
      <NativeSettingsPage
        sections={[{ key: "device", title: "Device", rows }, ...server.sections]}
      />
      {server.sheet}
    </>
  );
}
