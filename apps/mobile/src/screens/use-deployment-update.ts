import { useRemoteDesktopUpdate } from "@opensteer/client/react";
import type { DesktopUpdateAction, DesktopUpdateView } from "@opensteer/client/settings";
import type { DeploymentId } from "@opensteer/core";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Alert } from "react-native";
import { useAppForeground } from "../ui/foreground.js";
import { useMobileClient } from "../ui/mobile-client-context.js";

export interface DeploymentUpdateModel {
  readonly view: DesktopUpdateView;
  readonly onAction: (action: DesktopUpdateAction) => void;
}

/** Null when there is nothing to show; live only while this screen is in front. */
export function useDeploymentUpdate(
  deploymentId: DeploymentId | null,
  computerName: string,
): DeploymentUpdateModel | null {
  const client = useMobileClient();
  const navigation = useNavigation();
  const updates = useMemo(
    () => (deploymentId === null ? null : client.desktopUpdates(deploymentId)),
    [client, deploymentId],
  );
  const foreground = useAppForeground();
  const focused = useIsFocused();
  const { run, view } = useRemoteDesktopUpdate(
    updates,
    computerName,
    foreground && focused && updates !== null,
    async () => {
      if (deploymentId === null) return;
      const connection = (await client.catalog.load()).deployments.find(
        (entry) => entry.authority.document.deploymentId === deploymentId,
      );
      if (
        (connection?.reachability === "routed"
          ? connection.personalAccessRoute?.document.route.kind
          : null) === "private"
      ) {
        navigation.navigate("AddPersonal");
        return;
      }
      await client.signInAccount();
    },
  );
  if (updates === null || view.hidden) return null;
  return {
    view,
    onAction: (action) => {
      if (action.kind === "retry") {
        run(action);
        return;
      }
      Alert.alert(action.confirm.title, action.confirm.body, [
        { style: "cancel", text: "Cancel" },
        { onPress: () => run(action), text: action.confirm.confirmLabel },
      ]);
    },
  };
}
