import { presentActionFailure } from "@opensteer/client/feedback";
import { SettingsComputerEnrollment } from "./settings-computer-enrollment.js";
import { Sheet } from "../ui/sheet.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import { unwrapRpcResult, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import { iphoneSetupNeeds, iphoneSetupOnMacSteps } from "@opensteer/client/integrations";
import { connectDeviceDraftText } from "@opensteer/client/settings";
import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import { movePhoneHere } from "../phone-setup/move-phone-here.js";
import { phoneMembership } from "../phone-setup/phone-setup.js";
import { headerActions } from "../navigation-header.js";
import {
  notDone,
  readLine,
  settingsFooter,
  useScreenAction,
  useScreenRead,
} from "../ui/client-feedback.js";
import { useMobileClient, useHostValue, useMobileState } from "../ui/mobile-client-context.js";
import { useLeaveSheets } from "./leave-sheets.js";
import { confirmDestructive } from "./confirm.js";
import { phoneLeaves } from "./device-page-model.js";
import { deviceListSections, type DeviceListRow, type PhoneHere } from "./devices-model.js";
import type { NativeSettingsSection } from "./native-settings-page.types.js";
import { otherDevicesSettingsRows } from "./settings-model.js";
import { useSettingsHost } from "./use-settings-host.js";

export function DevicesSettingsController(): ReactNode {
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const navigation = useNavigation();
  const client = useMobileClient();
  const { rows, selection } = useMobileState();
  const snapshot = useSettingsHost(selection.hostClient);
  const iphone = useIphoneAppsState(useIphoneApps());
  const leave = useLeaveSheets(selection.deploymentId, selection.hostClient);
  const host = selection.hostClient;
  const deploymentId = selection.deploymentId;
  const overview = useScreenRead(host, {
    key: "devices-overview",
    label: "devices",
    read: host === null ? null : () => host.rpc["devices.overview.get"]({}).then(unwrapRpcResult),
    subscribeInvalidation: (listener) => {
      if (host === null) return () => {};
      const plugins = host.subscribePluginsChanged(listener);
      const machines = onMachinesChanged(host, listener);
      return () => {
        plugins();
        machines();
      };
    },
  });
  const sessions = useScreenRead(host, {
    key: "devices-sessions",
    label: "where you're signed in",
    read: host === null ? null : () => host.rpc["sessions.list"]({}).then(unwrapRpcResult),
    subscribeInvalidation: (listener) =>
      host === null ? () => {} : onMachinesChanged(host, listener),
  });
  const signOutDevice = useScreenAction(host, "device-session-sign-out", {
    label: "sign out",
    done: "signed out",
    thing: "that device",
    execute: (session: Parameters<typeof client.removeHostSession>[0]) =>
      client.removeHostSession(session),
    reconcile: async (session) => {
      if (host === null) return null;
      const listed = unwrapRpcResult(await host.rpc["sessions.list"]({})).sessions;
      return listed.some((row) => row.id === session.id)
        ? notDone({ label: "sign out", done: "signed out" })
        : { kind: "confirmed", value: undefined };
    },
  });
  const waiting = useHostValue(host, selectWaitingThreads, "");
  const iphoneAppsAvailable = useHostValue(host, (value) => value.iphoneAppsAvailable, false);

  useLayoutEffect(() => {
    navigation.setOptions(
      headerActions({
        right: { icon: "plus", label: "Add a device", onPress: () => setAdding(true) },
      }),
    );
  }, [navigation]);

  const here = useMemo((): PhoneHere => {
    if (deploymentId === null) return { state: "none" };
    const membership = phoneMembership({
      deploymentId,
      host: { iphoneAppsAvailable },
      iphone,
    });
    const enrollment = iphone.snapshot.enrollment;
    if (membership.state === "elsewhere" && enrollment !== null)
      return {
        state: "elsewhere",
        deploymentId: enrollment.deploymentId,
        deploymentName:
          rows.find((row) => row.deploymentId === enrollment.deploymentId)?.name ??
          membership.deploymentName,
      };
    if (membership.state === "needs-setup" || membership.state === "finish-setup")
      return { state: "needs-setup", deviceName: iphone.snapshot.deviceName };
    if (membership.state === "ready" && enrollment?.state === "enrolled")
      return { state: "member", runnerId: enrollment.runnerId };
    return { state: "none" };
  }, [deploymentId, iphone, iphoneAppsAvailable, rows]);

  const sections = useMemo(
    () =>
      deviceListSections({
        machines: snapshot?.machines ?? [],
        sessions: sessions.data?.sessions ?? [],
        here,
        noun: thisPhoneNoun,
      }),
    [here, sessions.data, snapshot?.machines],
  );
  const pluginRows = useMemo(
    () =>
      otherDevicesSettingsRows(
        overview.data?.otherDevices ?? [],
        new Set(waiting.split(" ").filter(Boolean)),
      ),
    [overview.data, waiting],
  );

  const open = (row: DeviceListRow): void => {
    const opens = row.opens;
    if (opens === null || deploymentId === null) return;
    switch (opens.kind) {
      case "device":
        navigation.navigate("SettingsDeviceDetail", { deploymentId, machineId: opens.machineId });
        return;
      case "set-up":
        navigation.navigate("SetUpPhone", { deploymentId });
        return;
      case "use-here": {
        const elsewhere = opens.elsewhereName;
        confirmDestructive({
          title: `Use this ${thisPhoneNoun} here instead?`,
          message: `${phoneLeaves(thisPhoneNoun, elsewhere)} Then you set it up here.`,
          confirm: "Use it here",
          onConfirm: () => {
            setFailure(null);
            void movePhoneHere(client, opens.elsewhere, () =>
              navigation.navigate("SetUpPhone", { deploymentId }),
            ).catch((error: unknown) =>
              setFailure(
                presentActionFailure(error, `This ${thisPhoneNoun} couldn't leave ${elsewhere}.`),
              ),
            );
          },
        });
        return;
      }
      case "session":
        confirmDestructive({
          title: `Sign out ${row.title}?`,
          message: "It loses access to this Opensteer.",
          confirm: "Sign out",
          onConfirm: () => {
            setFailure(null);
            void signOutDevice.run(opens.session).then((outcome) => {
              if (outcome.kind === "confirmed") sessions.refresh();
            });
          },
        });
        return;
    }
  };

  const answer =
    failure === null
      ? settingsFooter(signOutDevice.line)
      : { text: failure, tone: "danger" as const };
  const missing = settingsFooter(readLine(sessions, sessions.refresh));
  const nativeSections: NativeSettingsSection[] = [
    ...(answer === undefined ? [] : [{ key: "failure", title: "", rows: [], footer: answer }]),
    ...sections.map((section) => ({
      key: section.key,
      title: section.title,
      ...(section.footer === null ? {} : { footer: { text: section.footer } }),
      rows: section.rows.flatMap((row) => [
        {
          key: row.key,
          kind: "button" as const,
          label: row.title,
          detail: row.detail,
          symbol: row.symbol,
          opens:
            row.opens !== null && row.opens.kind !== "use-here" && row.opens.kind !== "session",
          onPress: () => open(row),
        },
        ...(row.opens?.kind === "use-here"
          ? [
              {
                key: `${row.key}:use-here`,
                kind: "button" as const,
                label: "Use it here instead",
                onPress: () => open(row),
              },
            ]
          : []),
      ]),
    })),
    ...(sessions.data === null
      ? [
          {
            key: "signed-in-waiting",
            title: "Also signed in",
            rows: missing
              ? []
              : [0, 1, 2].map((index) => ({
                  key: `placeholder:${index}`,
                  kind: "placeholder" as const,
                  label: "Not loaded yet",
                })),
            ...(missing ? { footer: missing } : {}),
          },
        ]
      : []),
    ...(pluginRows.length === 0
      ? []
      : [
          {
            key: "plugins",
            title: "Reached through plugins",
            rows: pluginRows.map((device) => ({
              key: device.key,
              kind: "button" as const,
              label: device.name,
              detail: device.detail,
              symbol: device.symbol,
              opens: true,
              onPress: () => {
                const opens = device.opens;
                if (opens.kind === "task") {
                  leave.openThread(opens.threadId);
                  return;
                }
                if (deploymentId === null) return;
                navigation.navigate("SettingsPluginDetail", {
                  deploymentId,
                  target: { kind: "plugin", pluginId: opens.pluginId },
                });
              },
            })),
          },
        ]),
  ];

  return (
    <>
      <NativeSettingsPage sections={nativeSections} />
      <Sheet open={adding} title="Add a device" onClose={() => setAdding(false)}>
        {adding && selection.hostClient ? (
          <SettingsComputerEnrollment host={selection.hostClient} />
        ) : null}
        <NativeSettingsPage
          sections={[
            {
              key: "sign-in",
              title: "Sign in on it",
              rows: [
                {
                  key: "instructions",
                  kind: "text",
                  label:
                    "Install Opensteer on the Mac or phone, then sign in with this account. It shows up here, and you choose what your agent can use.",
                },
              ],
            },
            {
              key: "server",
              title: "Server",
              rows: [
                {
                  key: "instructions",
                  kind: "text",
                  label: "Create a command above, then run it on the server you want to add.",
                },
              ],
            },
            {
              key: "iphone-screen",
              title: "iPhone screen control",
              rows: [
                {
                  key: "instructions",
                  kind: "text",
                  label:
                    "Your agent sees and controls an iPhone’s screen through one of your Macs, plugged in or on the same Wi‑Fi. Setup happens in Opensteer on that Mac.",
                },
              ],
            },
            {
              key: "iphone-screen-needs",
              title: "You’ll need",
              rows: iphoneSetupNeeds.map((need) => ({
                key: need.id,
                kind: "text" as const,
                label: need.title,
                detail: need.detail,
              })),
            },
            {
              key: "iphone-screen-steps",
              title: "On your Mac",
              rows: iphoneSetupOnMacSteps.map((step, index) => ({
                key: `step-${index}`,
                kind: "text" as const,
                label: `${index + 1}. ${step}`,
              })),
            },
            {
              key: "phone",
              title: "Agent Phone",
              rows: [
                {
                  key: "instructions",
                  kind: "text",
                  label:
                    "Connect your Android phone by USB to one of your Macs. Open Devices there and choose Set up Agent Phone.",
                },
              ],
            },
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

/** Calls `listener` when the Host's list of computers moves; their sessions and plugins move with it. */
function onMachinesChanged(host: HostClient, listener: () => void): () => void {
  let revision = host.getSnapshot().machineRevision;
  return host.subscribe(() => {
    const next = host.getSnapshot().machineRevision;
    if (next === revision) return;
    revision = next;
    listener();
  });
}
