import { useNavigation } from "@react-navigation/native";
import Constants from "expo-constants";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Linking } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import type { NotificationPreferences } from "../notifications/push-registration.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { useMobileNotifications, usePushRegistration } from "../ui/notifications-context.js";
import { GeneralSettingsForm } from "./settings-general-form.js";
import {
  deploymentSettingsModel,
  notificationSettingsModel,
  type NotificationSettingsActionModel,
} from "./settings-model.js";
import { SettingsPageLayout } from "./settings-page-layout.js";
import { useSettingsHost } from "./use-settings-host.js";
export function GeneralSettingsController(): ReactNode {
  const page = "general";
  const navigation = useNavigation();
  const notifications = useMobileNotifications();
  const registrationState = usePushRegistration();
  const { rows, selection, storageFailure, savedViewFailure } = useMobileState();
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notificationWorking, setNotificationWorking] = useState(false);
  const notificationInFlight = useRef(false);
  const snapshot = useSettingsHost(selection.hostClient);
  const selectedRow = rows.find((row) => row.deploymentId === selection.deploymentId) ?? null;
  const agents = useMemo(
    () =>
      snapshot === null
        ? []
        : snapshot.workspaces
            .filter((workspace) => workspace.kind === "project")
            .map((workspace) => ({
              muted: (snapshot.notificationMutes ?? []).includes(workspace.id),
              name: workspace.name,
              workspaceId: workspace.id,
            })),
    [snapshot],
  );

  const deploymentModel = deploymentSettingsModel(selectedRow);
  const notificationModel = notificationSettingsModel(registrationState, notificationWorking);
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
  const onNotificationAction = useCallback(() => {
    const action = notificationModel?.action ?? null;
    if (action === null || action.disabled) return;
    runNotification(
      notificationOperation(action, notifications.registration),
      notificationFailure(action),
    );
  }, [notificationModel?.action, notifications.registration, runNotification]);
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
      <SettingsPageLayout>
        <GeneralSettingsForm
          page={page}
          agents={agents}
          deployment={deploymentModel}
          notificationError={notificationError}
          notifications={notificationModel}
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
          onDeploymentAction={() => navigation.navigate("DeploymentSwitcher")}
          onNotificationAction={onNotificationAction}
          onPreferenceChange={onPreferenceChange}
          storageError={storageFailure ?? savedViewFailure}
          version={Constants.expoConfig?.version ?? "unknown"}
        />
      </SettingsPageLayout>
    </>
  );
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
