import { computerConnectionsOn } from "@opensteer/client/integrations";
import { computerStatus } from "@opensteer/client/computers";
import { mutationIdempotencyKey, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Linking, Platform } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { useComputerUseData } from "../computers/use-computer-use-data.js";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import { iphonePermissionOf } from "../iphone-apps/controller.js";
import { iphoneAppIds, iphoneAppRow, opensteerOn } from "../iphone-apps/model.js";
import { resetToDeployments } from "../navigation-ref.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { useMobileNotifications, usePushRegistration } from "../ui/notifications-context.js";
import { confirmDestructive } from "./confirm.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import {
  deviceRemoval,
  deviceSwitches,
  isHome,
  withSwitch,
  type DeviceSwitchKey,
} from "./device-page-model.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";

type Props = StaticScreenProps<{ readonly deploymentId: string; readonly machineId: string }>;

/** One device, the same shape for every device: name, what the agent can use, removal. */
export function DevicePageScreen({ route }: Props): ReactNode {
  const hostClient = useAttachedHost(route.params.deploymentId);
  return hostClient === null ? (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  ) : (
    <DevicePage
      deploymentId={route.params.deploymentId}
      hostClient={hostClient}
      machineId={route.params.machineId}
    />
  );
}

function DevicePage(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly machineId: string;
}): ReactNode {
  const navigation = useNavigation();
  const client = useMobileClient();
  const { rows } = useMobileState();
  const machines = useHostSelector(props.hostClient, selectMachines);
  const revision = useHostSelector(props.hostClient, selectRevision);
  const devicesAvailable = useHostSelector(props.hostClient, selectDevices);
  const machine = machines.find(({ id }) => id === props.machineId) ?? null;
  const iphoneController = useIphoneApps();
  const iphone = useIphoneAppsState(iphoneController);
  const enrollment = iphone.snapshot.enrollment;
  const thisDevice =
    enrollment?.state === "enrolled" &&
    enrollment.runnerId === props.machineId &&
    enrollment.deploymentId === props.deploymentId;
  const apps = useComputerUseData(thisDevice ? props.hostClient : null, revision);
  const { registration } = useMobileNotifications();
  const push = usePushRegistration();
  const [name, setName] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = useRef(false);

  useLayoutEffect(() => {
    if (machine !== null) navigation.setOptions({ title: machine.name });
  }, [machine, navigation]);

  if (machine === null)
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
                label: "This device is no longer part of this Opensteer.",
              },
            ],
          },
        ]}
      />
    );

  const run = (operation: () => Promise<unknown>, fallback: string): void => {
    if (busy.current) return;
    busy.current = true;
    setFailure(null);
    void operation()
      .then(() => props.hostClient.refresh())
      .catch((error: unknown) => setFailure(operationDetail(error, fallback)))
      .finally(() => {
        busy.current = false;
      });
  };
  const toggle = (key: DeviceSwitchKey, on: boolean): void => {
    const access = machine.access;
    if (access === null) return;
    run(
      () =>
        props.hostClient.dispatch({
          expectedRevision: access.revision,
          idempotencyKey: mutationIdempotencyKey("device-switch"),
          policy: withSwitch(access.policy, key, on),
          runnerId: machine.id,
          type: "machine.access.update",
        }),
      "That change could not be confirmed. Try again.",
    );
  };
  const draft = name ?? machine.name;
  const rename = (): void => {
    const next = draft.trim();
    if (next === "" || next === machine.name) return;
    run(
      () =>
        props.hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey("device-rename"),
          machineId: machine.id,
          name: next,
          type: "machine.rename",
        }),
      "The name could not be saved.",
    );
  };

  const switches = deviceSwitches(machine, {
    devicesAvailable,
    ...(thisDevice ? { noun: thisPhoneNoun } : {}),
  });
  const opensteer = opensteerOn(
    rows.find((row) => row.deploymentId === props.deploymentId)?.name ?? "Opensteer",
  );
  const connections = computerConnectionsOn(apps.data?.connections ?? [], machine.id);
  // Only an iPhone's own build lends these apps; Android lends its browser alone.
  const appRows: NativeSettingsRow[] = thisDevice
    ? iphoneAppIds.flatMap((app) => {
        const permission = iphonePermissionOf(iphone.snapshot, app);
        if (permission === null) return [];
        const definition = apps.data?.definitions.find(({ id }) => id === app) ?? null;
        const connection = connections.find(({ definitionId }) => definitionId === app) ?? null;
        const view = iphoneAppRow({
          access: connection?.computer?.access ?? null,
          app,
          change: iphone.changes[app] ?? null,
          connection: iphone.snapshot.connection,
          definition,
          locationAccuracy: iphone.snapshot.locationAccuracy ?? null,
          opensteer,
          permission,
          queued: iphone.queued.includes(app),
        });
        return [
          {
            key: app,
            kind: "button" as const,
            label: view.name,
            detail: view.line,
            opens: true,
            onPress: () => navigation.navigate("Computer", props),
          },
        ];
      })
    : [];
  const removal = deviceRemoval(machine, { noun: thisPhoneNoun, thisDevice });
  const status = isHome(machine) ? "Home · your agent runs here" : computerStatus(machine).label;
  const notificationsOn =
    push.status === "registered" &&
    (push.preferences.approvalsEnabled || push.preferences.runOutcomesEnabled);

  const sections: NativeSettingsSection[] = [
    {
      key: "name",
      title: "",
      footer: { text: thisDevice ? `This ${thisPhoneNoun} · ${status}` : status },
      rows: [
        {
          key: "name",
          kind: "input",
          label: "Name",
          value: draft,
          onChange: setName,
          onSubmit: rename,
        },
        ...(Platform.OS === "android" && draft.trim() !== machine.name && draft.trim() !== ""
          ? [{ key: "save", kind: "button" as const, label: "Save name", onPress: rename }]
          : []),
      ],
    },
    {
      key: "agent",
      title: "Your agent can use",
      ...(failure !== null
        ? { footer: { text: failure, tone: "danger" as const } }
        : switches.footer !== null
          ? { footer: { text: switches.footer } }
          : {}),
      rows: [
        ...switches.rows.flatMap((row): NativeSettingsRow[] => [
          row.fixed
            ? { key: row.key, kind: "text", label: row.title, detail: row.detail }
            : {
                key: row.key,
                kind: "toggle",
                label: row.title,
                detail: row.detail,
                disabled: row.disabled,
                value: row.value,
                onChange: (on) => toggle(row.key, on),
              },
          // Each app keeps its own row, and its own approvals, under Apps.
          ...(row.key === "apps" ? appRows : []),
        ]),
        ...(thisDevice
          ? []
          : [
              {
                key: "details",
                kind: "button" as const,
                label: "Apps, folders and permissions",
                opens: true,
                onPress: () => navigation.navigate("Computer", props),
              },
            ]),
      ],
    },
    ...(thisDevice
      ? [
          {
            key: "here",
            title: `On this ${thisPhoneNoun}`,
            ...(push.status === "permission-denied"
              ? { footer: { text: "Notifications are off in Settings. Allow in Settings." } }
              : {}),
            rows: [
              {
                key: "notifications",
                kind: "toggle" as const,
                label: "Notifications",
                detail: "Tell you when your agent needs you or finishes",
                value: notificationsOn,
                onChange: (on: boolean) => {
                  if (on && push.status === "permission-denied") {
                    void Linking.openSettings();
                    return;
                  }
                  void (async () => {
                    if (on) await registration.requestPermission();
                    await registration.setPreferences({
                      approvalsEnabled: on,
                      runOutcomesEnabled: on,
                    });
                  })().catch(() => undefined);
                },
              },
            ],
          },
        ]
      : []),
    ...(removal === null
      ? []
      : [
          {
            key: "remove",
            title: "",
            rows: [
              {
                key: "remove",
                kind: "button" as const,
                label: removal.label,
                destructive: true,
                onPress: () =>
                  confirmDestructive({
                    title: removal.title,
                    message: removal.message,
                    confirm: thisDevice ? "Sign out and remove" : "Remove",
                    onConfirm: () => {
                      if (thisDevice) {
                        void client
                          .signOut(props.deploymentId)
                          .then(resetToDeployments)
                          .catch((error: unknown) =>
                            setFailure(operationDetail(error, "Signing out did not finish.")),
                          );
                        return;
                      }
                      run(
                        () =>
                          props.hostClient
                            .dispatch({
                              idempotencyKey: mutationIdempotencyKey("device-remove"),
                              machineId: machine.id,
                              type: "machine.revoke",
                            })
                            .then(() => navigation.goBack()),
                        `${machine.name} could not be removed.`,
                      );
                    },
                  }),
              },
            ],
          },
        ]),
  ];
  return <NativeSettingsPage sections={sections} />;
}

const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;
const selectRevision = (snapshot: HostSnapshot) => snapshot.machineRevision;
const selectDevices = (snapshot: HostSnapshot) => snapshot.devicesAvailable === true;
