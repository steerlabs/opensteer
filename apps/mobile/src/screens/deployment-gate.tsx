import type { HostClient } from "@opensteer/client/host";
import type { DeploymentId } from "@opensteer/core";
import { useNavigation } from "@react-navigation/native";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { deploymentStatusDetail, deploymentStatusLabel } from "../client/deployment-rows.js";
import { resetToDeployments } from "../navigation-ref.js";
import { color, space } from "../theme.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import {
  AppText,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  StatusDot,
} from "../ui/primitives.js";
import { Screen, useReadingColumn } from "../ui/screen.js";
import { statusTone } from "./deployment-row.js";
import { deploymentRecoveryLabel, runDeploymentRecovery } from "./deployment-recovery.js";
import { deploymentUpdateRows } from "./deployment-update.js";
import { useDeploymentUpdate } from "./use-deployment-update.js";
import { useOptionalIphoneApps } from "../iphone-apps/context.js";
import type { IphoneAppsController } from "../iphone-apps/controller.js";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { removedCopy } from "../phone-setup/removed-copy.js";
import { RemovedView } from "../phone-setup/removed-view.js";

/**
 * The Host a Deployment-bound screen may use, or null.
 *
 * Only the attached Host of that exact Deployment, with no sign-in owed,
 * counts: while the selection is moving, or the Host has refused this phone,
 * a screen shows `DeploymentGate` rather than another Host's work.
 */
export function useAttachedHost(deploymentId: string): HostClient | null {
  const { rows, selection } = useMobileState();
  const row = rows.find((candidate) => candidate.deploymentId === deploymentId);
  return row !== undefined && row.signIn === null && selection.deploymentId === deploymentId
    ? selection.hostClient
    : null;
}

/**
 * What a Deployment-bound screen says while it cannot show that Deployment's
 * work, and the one thing that would fix it.
 *
 * It stands up before any Host has answered — a notification can open a task
 * on a cold start — so it names what it is waiting for instead of spinning,
 * and it recovers inside the same Deployment rather than choosing another.
 */
export function DeploymentGate(props: {
  readonly deploymentId: string;
  /** Room for a transparent bar above the content. */
  readonly paddingTop?: number;
}): ReactNode {
  const navigation = useNavigation();
  const client = useMobileClient();
  const column = useReadingColumn();
  const { rows, selection } = useMobileState();
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { deploymentId } = props;
  const row = rows.find((candidate) => candidate.deploymentId === deploymentId);
  const top = { paddingTop: props.paddingTop ?? 0 };
  const iphone = useOptionalIphoneApps();
  const removedFrom = useRemovedFrom(iphone);

  // Removed by its Host: nothing signs back in until the person sets it up again.
  if (iphone !== null && removedFrom?.deploymentId === deploymentId) {
    const copy = removedCopy(thisPhoneNoun, row?.name ?? removedFrom.deploymentName);
    return (
      <View style={[styles.removed, top]}>
        <RemovedView
          {...copy}
          onNotNow={resetToDeployments}
          onSetUpAgain={() => {
            setFailure(null);
            void iphone
              .clearRemoved()
              .then(() => client.signIn(deploymentId))
              .catch((error: unknown) =>
                setFailure(operationDetail(error, "Opensteer could not be opened.")),
              );
          }}
        />
      </View>
    );
  }

  if (row === undefined) {
    return (
      <Screen>
        <View style={[styles.content, column, top]}>
          <AppText role="displaySmall">This deployment is gone</AppText>
          <AppText role="secondary" tone="muted">
            It is no longer in this phone&apos;s list. Add it again from Deployments.
          </AppText>
          <SecondaryButton label="Choose a deployment" onPress={resetToDeployments} />
        </View>
      </Screen>
    );
  }

  // Opening is what happens on every launch, and it needs nobody: it gets a
  // quiet wait, and the name and the doors below are kept for a state that
  // does need a person.
  const opening =
    failure === null &&
    (row.status === "connecting" ||
      row.status === "reconnecting" ||
      (row.status === "signed-in" && selection.deploymentId === deploymentId));
  if (opening) {
    return (
      <Screen>
        <View
          accessibilityLiveRegion="polite"
          style={[styles.content, styles.opening, column, top]}
        >
          <ActivityIndicator color={color.muted} />
          <AppText role="secondary" tone="muted">
            {`Connecting to ${row.name}…`}
          </AppText>
        </View>
      </Screen>
    );
  }

  const act = (): void => {
    setWorking(true);
    setFailure(null);
    const operation =
      selection.deploymentId !== deploymentId
        ? // A person's own tap, so this is the interactive door: it may sign
          // in rather than stopping at a second "Sign in" button.
          client.openDeployment(deploymentId)
        : row.signIn === null
          ? client.retrySelection()
          : runDeploymentRecovery(client, navigation, row);
    void operation
      .catch((error: unknown) => {
        setFailure(operationDetail(error, "That deployment still could not be opened."));
      })
      .finally(() => setWorking(false));
  };

  return (
    <Screen>
      <View style={[styles.content, column, top]}>
        {failure === null ? null : <Notice detail={failure} title="That deployment did not open" />}
        <AppText role="displaySmall">{row.name}</AppText>
        <View style={styles.statusLine}>
          <StatusDot
            live={row.status === "connecting" || row.status === "reconnecting"}
            tone={statusTone(row.status)}
          />
          <AppText role="secondary" tone="soft">
            {deploymentStatusLabel(row.status)}
          </AppText>
        </View>
        <AppText role="secondary" tone="muted">
          {deploymentStatusDetail(row) ?? "Opening this deployment…"}
        </AppText>
        {row.verification === "host-too-old" ? (
          <DeploymentUpdate deploymentId={row.deploymentId} name={row.name} />
        ) : null}
        {/* The one thing that would fix it leads; switching is the way out. */}
        {row.status === "connecting" || row.status === "reconnecting" ? null : (
          <PrimaryButton
            busy={working}
            label={
              selection.deploymentId !== deploymentId
                ? `Open ${row.name}`
                : row.signIn === null
                  ? "Try again"
                  : deploymentRecoveryLabel(row)
            }
            onPress={act}
          />
        )}
        <SecondaryButton
          label="Switch deployment"
          onPress={() => navigation.navigate("DeploymentSwitcher")}
        />
      </View>
    </Screen>
  );
}

/** The way out of a Host too old for this phone: it can't open, but it can update. */
function DeploymentUpdate(props: {
  readonly deploymentId: DeploymentId;
  readonly name: string;
}): ReactNode {
  const update = useDeploymentUpdate(props.deploymentId, props.name);
  return update === null ? null : <RowGroup>{deploymentUpdateRows(update)}</RowGroup>;
}

/** Whether this phone's Host removed it from a Deployment, until Set up again. */
function useRemovedFrom(controller: IphoneAppsController | null) {
  return useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    () => controller?.getState().removedFrom ?? null,
    () => controller?.getState().removedFrom ?? null,
  );
}
const noSubscription = () => () => undefined;

const styles = StyleSheet.create({
  content: { flex: 1, gap: space[8], justifyContent: "center" },
  opening: { alignItems: "center", gap: space[12] },
  removed: { backgroundColor: color.background, flex: 1 },
  statusLine: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[8] },
});
