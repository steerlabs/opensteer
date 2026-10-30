import Constants from "expo-constants";
import { useNavigation } from "@react-navigation/native";
import { canRespondToRequests, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { useComputerUseData } from "../computers/use-computer-use-data.js";
import type { NotificationPreferences } from "../notifications/push-registration.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { useMobileNotifications, usePushRegistration } from "../ui/notifications-context.js";
import { space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { SettingsForm } from "./settings-form.js";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import {
  accountSettingsModel,
  computersSettingsFooterFor,
  computersSettingsRows,
  deploymentSettingsModel,
  notificationSettingsModel,
  passwordsSettingsModel,
  signOutAccountInOrder,
  type NotificationSettingsActionModel,
} from "./settings-model.js";

/**
 * Shared state and effects for the native iOS form and Android settings rows.
 * Platform files own presentation only, so authentication and notification
 * behavior cannot drift between them.
 */
export function SettingsScreen(): ReactNode {
  const navigation = useNavigation();
  const client = useMobileClient();
  const notifications = useMobileNotifications();
  const registrationState = usePushRegistration();
  const { account, rows, selection, storageFailure, savedViewFailure } = useMobileState();
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountWorking, setAccountWorking] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notificationWorking, setNotificationWorking] = useState(false);
  const [passwordsShown, setPasswordsShown] = useState(false);
  const accountInFlight = useRef(false);
  const notificationInFlight = useRef(false);

  const snapshot = useSelectedHostSnapshot(selection.hostClient);
  const apps = useComputerUseData(selection.hostClient, snapshot?.machineRevision ?? 0);
  const selectedRow = rows.find((row) => row.deploymentId === selection.deploymentId) ?? null;
  const iphoneApps = useIphoneAppsState(useIphoneApps());
  const computers = useMemo(() => {
    if (snapshot === null) return [];
    const deploymentName =
      selectedRow?.name ?? snapshot.identityConfig?.deployment.name ?? "Opensteer";
    const enrollment = iphoneApps.snapshot.enrollment;
    return computersSettingsRows({
      apps: apps.data,
      cloud: snapshot.identityConfig?.deployment.cloud ?? false,
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
      hostConnected: canRespondToRequests(snapshot),
      machines: snapshot.machines,
      publicOrigin: snapshot.identityConfig?.publicOrigin ?? null,
    });
  }, [apps.data, iphoneApps, rows, selectedRow?.name, selection.deploymentId, snapshot]);
  const passwords = useMemo(
    () =>
      snapshot === null
        ? null
        : passwordsSettingsModel({
            deploymentKind: snapshot.deploymentShape?.kind ?? null,
            deploymentName:
              selectedRow?.name ?? snapshot.identityConfig?.deployment.name ?? "your Mac",
            machines: snapshot.machines,
          }),
    [selectedRow?.name, snapshot],
  );
  // Agents whose replies and failures can be silenced. Main is not one of
  // them: Chat is where Opensteer answers the person, not a specialist.
  const agents = useMemo(
    () =>
      snapshot === null
        ? []
        : snapshot.workspaces
            .filter((workspace) => workspace.kind === "specialized")
            .map((workspace) => ({
              muted: (snapshot.notificationMutes ?? []).includes(workspace.id),
              name: workspace.name,
              workspaceId: workspace.id,
            })),
    [snapshot],
  );

  const accountModel = accountSettingsModel(account.account, accountWorking);
  const deploymentModel = deploymentSettingsModel(selectedRow);
  const notificationModel = notificationSettingsModel(registrationState, notificationWorking);

  const runAccount = useCallback((operation: () => Promise<void>, fallback: string) => {
    if (accountInFlight.current) return;
    accountInFlight.current = true;
    setAccountError(null);
    setAccountWorking(true);
    void operation()
      .catch((error: unknown) => setAccountError(operationDetail(error, fallback)))
      .finally(() => {
        accountInFlight.current = false;
        setAccountWorking(false);
      });
  }, []);

  const runNotification = useCallback((operation: () => Promise<void>, fallback: string) => {
    if (notificationInFlight.current) return;
    notificationInFlight.current = true;
    setNotificationError(null);
    setNotificationWorking(true);
    void operation()
      .catch((error: unknown) => setNotificationError(operationDetail(error, fallback)))
      .finally(() => {
        notificationInFlight.current = false;
        setNotificationWorking(false);
      });
  }, []);

  const signOut = useCallback(() => {
    if (accountInFlight.current) return;
    Alert.alert(
      "Sign out of your Opensteer Account?",
      "Deployments listed by your Account will leave this phone. Deployments you added yourself stay signed in.",
      [
        { style: "cancel", text: "Cancel" },
        {
          onPress: () =>
            runAccount(
              () =>
                signOutAccountInOrder(
                  async () => {
                    await client.clearAccountSavedViews();
                    await notifications.registration.signOut();
                  },
                  () => client.signOutAccount(),
                ),
              "Account sign-out did not finish. Try again while this phone is online.",
            ),
          style: "destructive",
          text: "Sign out of Account",
        },
      ],
    );
  }, [client, notifications, runAccount]);

  const onAccountAction = useCallback(() => {
    const action = accountModel.action;
    if (action === null || action.disabled) return;
    if (action.kind === "sign-out") {
      signOut();
      return;
    }
    runAccount(
      () => client.signInAccount(),
      "Account sign-in did not finish. Try again and complete the browser sign-in.",
    );
  }, [accountModel.action, client, runAccount, signOut]);

  const onNotificationAction = useCallback(() => {
    const action = notificationModel.action;
    if (action === null || action.disabled) return;
    runNotification(
      notificationOperation(action, notifications.registration),
      notificationFailure(action),
    );
  }, [notificationModel.action, notifications.registration, runNotification]);

  const onPreferenceChange = useCallback(
    (kind: "approvals" | "run-outcomes", enabled: boolean) => {
      if (notificationInFlight.current) return;
      const current = registrationState.preferences;
      const next: NotificationPreferences =
        kind === "approvals"
          ? { ...current, approvalsEnabled: enabled }
          : { ...current, runOutcomesEnabled: enabled };
      runNotification(
        () => notifications.registration.setPreferences(next),
        "That notification setting did not reach your Opensteer Account. Try again.",
      );
    },
    [notifications.registration, registrationState.preferences, runNotification],
  );

  return (
    <>
      <SettingsForm
        account={accountModel}
        accountError={accountError}
        agents={agents}
        computers={computers}
        computersFooter={computersSettingsFooterFor(computers)}
        deployment={deploymentModel}
        notificationError={notificationError}
        notifications={notificationModel}
        onAccountAction={onAccountAction}
        onAgentMuteChange={(workspaceId, muted) => {
          const hostClient = selection.hostClient;
          if (hostClient === null) return;
          setNotificationError(null);
          void hostClient
            .setWorkspaceNotificationMute(workspaceId, muted)
            .catch((error: unknown) => {
              setNotificationError(
                operationDetail(error, "That notification setting could not be saved."),
              );
            });
        }}
        onChromeAction={
          selection.deploymentId === null || selection.hostClient === null
            ? undefined
            : () => {
                if (selection.deploymentId === null) return;
                navigation.navigate("Chrome", { deploymentId: selection.deploymentId });
              }
        }
        onConnectedAppsAction={
          selection.deploymentId === null || selection.hostClient === null
            ? undefined
            : () => {
                if (selection.deploymentId === null) return;
                navigation.navigate("ConnectedApps", { deploymentId: selection.deploymentId });
              }
        }
        onComputerAction={(destination) => {
          if (selection.deploymentId === null) return;
          if (destination.kind === "add-iphone") {
            navigation.navigate("AddIphone", { deploymentId: selection.deploymentId });
            return;
          }
          navigation.navigate("Computer", {
            deploymentId: destination.deploymentId ?? selection.deploymentId,
            machineId: destination.machineId,
          });
        }}
        onDeploymentAction={() => navigation.navigate("DeploymentSwitcher")}
        onNotificationAction={onNotificationAction}
        onPasswordsAction={() => setPasswordsShown(true)}
        onPreferenceChange={onPreferenceChange}
        passwords={passwords}
        storageError={storageFailure ?? savedViewFailure}
        version={Constants.expoConfig?.version ?? "unknown"}
      />
      {passwords === null ? null : (
        <Sheet
          onClose={() => setPasswordsShown(false)}
          open={passwordsShown}
          title={passwords.title}
        >
          <View style={styles.passwords}>
            <AppText role="body">{passwords.body}</AppText>
            {passwords.facts.map((fact) => (
              <AppText key={fact} role="secondary" tone="soft">
                {fact}
              </AppText>
            ))}
          </View>
        </Sheet>
      )}
    </>
  );
}

/**
 * The open Deployment's computers, or none while no Deployment is open.
 * Settings stands over any screen, so it reads the snapshot without loading it.
 */
function useSelectedHostSnapshot(hostClient: HostClient | null): HostSnapshot | null {
  const subscribe = useCallback(
    (listener: () => void) => hostClient?.subscribe(listener) ?? (() => undefined),
    [hostClient],
  );
  const read = useCallback(() => hostClient?.getSnapshot() ?? null, [hostClient]);
  return useSyncExternalStore(subscribe, read, read);
}

function notificationOperation(
  action: NotificationSettingsActionModel,
  registration: ReturnType<typeof useMobileNotifications>["registration"],
): () => Promise<void> {
  switch (action.kind) {
    case "open-settings":
      return () => Linking.openSettings();
    case "request-permission":
      return () => registration.requestPermission();
    case "retry-notifications":
      return () => registration.sync();
  }
}

function notificationFailure(action: NotificationSettingsActionModel): string {
  switch (action.kind) {
    case "open-settings":
      return "This phone’s settings could not be opened. Open Settings and choose Opensteer.";
    case "request-permission":
      return "This phone did not finish the notification permission request. Try again.";
    case "retry-notifications":
      return "This phone could not register for notifications. Check your connection and try again.";
  }
}

const styles = StyleSheet.create({
  passwords: { gap: space[12], paddingHorizontal: space[16], paddingTop: space[8] },
});
