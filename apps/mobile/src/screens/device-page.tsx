import { cancelDeviceSetup, withDeviceSwitch } from "@opensteer/client/computers";
import {
  computerConnectionsOn,
  computerUseAccessLabel,
  computerUseStops,
  iphoneScreenKeepAwakeTip,
  phoneScreenDisconnectCopy,
  phoneScreenMac,
  phoneScreenRemovalCopy,
  phoneScreenSetupLine,
  phoneScreenStatus,
  phoneUseCardTitle,
  phoneUseStatusLine,
  phoneUseView,
  setPhoneUseAccess,
} from "@opensteer/client/integrations";
import { TabTargetSchema } from "@opensteer/core";
import { computerStatus } from "@opensteer/client/computers";
import {
  canRespondToRequests,
  deviceMachine,
  mutationIdempotencyKey,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { tabRoute } from "../browser/surface-route.js";
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
import { wantsAlerts } from "../notifications/push-registration.js";
import { useMobileNotifications, usePushRegistration } from "../ui/notifications-context.js";
import { confirmDestructive } from "./confirm.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import {
  deviceRemoval,
  deviceSwitches,
  isHome,
  type DeviceSwitchKey,
} from "./device-page-model.js";
import { deviceKindLabel } from "./devices-model.js";
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
  const profiles = useHostSelector(props.hostClient, selectProfiles);
  const machine = machines.find(({ id }) => id === props.machineId) ?? null;
  const iphoneController = useIphoneApps();
  const iphone = useIphoneAppsState(iphoneController);
  const enrollment = iphone.snapshot.enrollment;
  const thisDevice =
    enrollment?.state === "enrolled" &&
    enrollment.runnerId === props.machineId &&
    enrollment.deploymentId === props.deploymentId;
  const screenMac = machine === null ? null : phoneScreenMac(machine);
  const canRespond = useHostSelector(props.hostClient, canRespondToRequests);
  const apps = useComputerUseData(
    thisDevice || screenMac !== null ? props.hostClient : null,
    revision,
  );
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
                label: failure ?? "This device is no longer part of this Opensteer.",
              },
            ],
          },
        ]}
      />
    );

  const run = (operation: () => Promise<unknown>, fallback: string, refresh = true): void => {
    if (busy.current) return;
    busy.current = true;
    setFailure(null);
    void operation()
      .then(() => (refresh ? props.hostClient.refresh() : undefined))
      .catch((error: unknown) => setFailure(operationDetail(error, fallback)))
      .finally(() => {
        busy.current = false;
      });
  };
  if (machine.status === "pending") {
    const ownPending =
      enrollment?.state === "pending" &&
      enrollment.deploymentId === props.deploymentId &&
      enrollment.enrollmentId === machine.enrollmentId;
    return (
      <NativeSettingsPage
        sections={[
          {
            key: "pending",
            title: machine.name,
            rows: [
              {
                key: "expiry",
                kind: "text",
                label: machine.expiresAt
                  ? `Setup expires ${machine.expiresAt}`
                  : "Setup has not finished",
              },
              ...(ownPending
                ? [
                    {
                      key: "resume",
                      kind: "button" as const,
                      label: "Finish setup",
                      onPress: () =>
                        navigation.navigate("SetUpPhone", { deploymentId: props.deploymentId }),
                    },
                  ]
                : []),
              {
                key: "cancel",
                kind: "button",
                label: "Cancel setup",
                destructive: true,
                onPress: () =>
                  run(
                    async () => {
                      if (ownPending)
                        await iphoneController.remove({ hostClient: props.hostClient });
                      else if (
                        (await cancelDeviceSetup(
                          props.hostClient,
                          machine.enrollmentId ?? machine.id,
                        )) === "joined"
                      ) {
                        setFailure(
                          "This device finished joining. Open it in Devices to remove it.",
                        );
                        return;
                      }
                      navigation.goBack();
                    },
                    "Setup could not be cancelled. Try again.",
                    ownPending,
                  ),
              },
              ...(failure ? [{ key: "failure", kind: "text" as const, label: failure }] : []),
            ],
          },
        ]}
      />
    );
  }
  const toggle = (key: DeviceSwitchKey, on: boolean): void => {
    const access = machine.access;
    if (access === null) return;
    run(async () => {
      const result = await props.hostClient.updateMachineAccess({
        expectedRevision: access.revision,
        policy: withDeviceSwitch(access.policy, key, on),
        deviceId: machine.id,
      });
      if (result.outcome === "conflict") {
        setFailure("It changed on another device. Look again and try once more.");
      }
    }, "That change could not be confirmed. Try again.");
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
  const removal = deviceRemoval(machine, { noun: thisPhoneNoun, profiles, thisDevice });
  const kind = isHome(machine) ? null : deviceKindLabel(machine);
  const status = isHome(machine)
    ? "Home · your agent runs here"
    : [kind, phoneScreenStatus(machine)?.label ?? computerStatus(machine).label]
        .filter(Boolean)
        .join(" · ");
  const notificationsOn = push.status === "registered" && wantsAlerts(push.preferences);
  const screen = screenMac === null ? null : screenSection();

  /** A Mac-driven phone: its status, Apps, approval, holder and screen, and its two ways out. */
  function screenSection() {
    if (machine === null || screenMac === null) return null;
    const status = phoneScreenStatus(machine)!;
    const phone =
      apps.data === null
        ? null
        : phoneUseView({ ...apps.data, hostConnected: canRespond, machine });
    const appsOn = machine.capabilities?.apps.enabled !== false;
    const setup = phoneScreenSetupLine(machine);
    const tab = TabTargetSchema.safeParse({ kind: "phone", computerId: machine.id });
    const disconnect = screenMac.attached
      ? phoneScreenDisconnectCopy(machine.name, screenMac.name)
      : null;
    const removeCopy = phoneScreenRemovalCopy(machine.name, screenMac.name);
    const rows: NativeSettingsRow[] = [
      {
        key: "status",
        kind: "status",
        tone:
          status.tone === "online" ? "good" : status.tone === "waiting" ? "attention" : "neutral",
        label: status.label,
        ...((status.fix ?? (status.tone === "online" && phone))
          ? { detail: status.fix ?? phoneUseStatusLine(phone!, machine.name) }
          : {}),
      },
      ...switches.rows
        .filter(({ key }) => key === "apps")
        .map((row): NativeSettingsRow => ({
          key: row.key,
          kind: "toggle",
          label: row.title,
          detail: "See and control its screen",
          disabled: row.disabled,
          value: row.value,
          onChange: (on) => toggle(row.key, on),
        })),
      ...(phone !== null && appsOn && screenMac.attached
        ? [
            {
              key: "access",
              kind: "chips" as const,
              label: "Access",
              value: phone.access ?? "off",
              choices: [
                { value: "off", label: "Off" },
                { value: "read", label: computerUseAccessLabel.read },
                { value: "read-write", label: computerUseAccessLabel["read-write"] },
              ],
              onChange: (value: string) =>
                run(async () => {
                  if (value === "read" || value === "read-write")
                    return setPhoneUseAccess(props.hostClient, machine, value);
                  if (phone.connectionId === null) return;
                  await props.hostClient.dispatch({
                    connectionId: phone.connectionId,
                    idempotencyKey: mutationIdempotencyKey(`phone-access:${machine.id}`),
                    type: "integration.disconnect",
                  });
                }, "Access did not change. Try again."),
            },
          ]
        : []),
      ...(phone?.session
        ? [
            {
              key: "stop",
              kind: "button" as const,
              label: "Stop",
              detail: `${phone.session.threadTitle ?? "A task"} is using ${machine.name}`,
              destructive: true,
              disabled: !canRespond,
              onPress: () =>
                computerUseStops(props.hostClient).stop({
                  machineName: machine.name,
                  runId: phone.session!.runId,
                  sessionId: phone.session!.sessionId,
                }),
            },
          ]
        : []),
      ...(phone?.canView && tab.success
        ? [
            {
              key: "open",
              kind: "button" as const,
              label: "Open screen",
              onPress: () =>
                run(
                  async () => {
                    const opened = await props.hostClient.openTab(tab.data);
                    if (navigation.isFocused())
                      navigation.dispatch(
                        StackActions.push(
                          "WorkspaceBrowser",
                          tabRoute(props.deploymentId, opened.tabId),
                        ),
                      );
                  },
                  "The screen could not be opened.",
                  false,
                ),
            },
          ]
        : []),
      ...(status.needsSetup && setup
        ? [{ key: "setup", kind: "text" as const, label: setup.label, detail: setup.detail }]
        : []),
    ];
    const way = (
      copy: typeof removeCopy | NonNullable<typeof disconnect>,
      act: () => Promise<unknown>,
    ) =>
      confirmDestructive({
        title: copy.title,
        message: copy.body,
        confirm: copy.confirm,
        onConfirm: () => run(act, `${machine.name} did not change. Try again.`),
      });
    const generation = deviceMachine(machine).phoneDisplay?.driver?.generation;
    return {
      card: {
        key: "screen",
        title: screenMac.attached
          ? phoneUseCardTitle({ driver: deviceMachine(machine).phoneDisplay?.driver ?? null })
          : "Screen control",
        ...(failure !== null
          ? { footer: { text: failure, tone: "danger" as const } }
          : screenMac.attached
            ? { footer: { text: iphoneScreenKeepAwakeTip } }
            : {}),
        rows,
      } satisfies NativeSettingsSection,
      exits: {
        key: "remove",
        title: "",
        rows: [
          ...(disconnect && generation !== undefined
            ? [
                {
                  key: "disconnect",
                  kind: "button" as const,
                  label: disconnect.label,
                  onPress: () =>
                    way(disconnect, () =>
                      props.hostClient.detachIphoneScreen({
                        deviceId: machine.id,
                        expectedGeneration: generation,
                      }),
                    ),
                },
              ]
            : []),
          {
            key: "remove",
            kind: "button" as const,
            label: removeCopy.label,
            destructive: true,
            onPress: () =>
              way(removeCopy, () =>
                props.hostClient
                  .dispatch({
                    idempotencyKey: mutationIdempotencyKey("device-remove"),
                    machineId: machine.id,
                    type: "machine.revoke",
                  })
                  .then(() => navigation.goBack()),
              ),
          },
        ],
      } satisfies NativeSettingsSection,
    };
  }

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
    ...(screen
      ? [screen.card]
      : ([
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
        ] satisfies NativeSettingsSection[])),
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
                  void registration.choose(on).catch(() => undefined);
                },
              },
            ],
          },
        ]
      : []),
    ...(screen
      ? [screen.exits]
      : removal === null
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
const selectProfiles = (snapshot: HostSnapshot) => snapshot.browserProfiles;
