import { clientIssue, presentClientIssue } from "@opensteer/client/feedback";
import type { HostClient } from "@opensteer/client/host";
import type { DeploymentId } from "@opensteer/core";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  deploymentStatusDetail,
  deploymentStatusLabel,
  isMacHomeRow,
} from "../client/deployment-rows.js";
import { GateAsleepLine } from "./gate-asleep-line.js";
import { resetToDeployments } from "../navigation-ref.js";
import { deploymentsTitle } from "./deployments-title.js";
import { color, space } from "../theme.js";
import { ConnectionGate, type ConnectionGateButton } from "../ui/connection-gate.js";
import { ConnectionRouteGate } from "../ui/route-gate.js";
import { useShellGate } from "../ui/shell-gate.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import {
  AppText,
  DisplayTitle,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
} from "../ui/primitives.js";
import { Screen, useReadingColumn } from "../ui/screen.js";
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

/** `useAttachedHost`, read narrowly: a layout around every screen redraws only when it changes. */
export function useAttachedHostOf(deploymentId: string | null): HostClient | null {
  const client = useMobileClient();
  const read = useCallback(() => {
    if (deploymentId === null) return null;
    const { rows, selection } = client.getSnapshot();
    const row = rows.find((candidate) => candidate.deploymentId === deploymentId);
    return row !== undefined && row.signIn === null && selection.deploymentId === deploymentId
      ? selection.hostClient
      : null;
  }, [client, deploymentId]);
  return useSyncExternalStore(client.subscribe, read, read);
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
  // A door that didn't open says so in the gate's own words, until the next try.
  const [refused, setRefused] = useState<string | null>(null);
  const { deploymentId } = props;
  const act = (operation: () => Promise<void>, action = "open it"): void => {
    setWorking(true);
    setRefused(null);
    void operation()
      .catch((error: unknown) => {
        const issue = clientIssue(error, { operation: "action", label: action });
        if (issue !== null) setRefused(presentClientIssue(issue).title);
      })
      .finally(() => setWorking(false));
  };
  // Back on a route a person came to; Other computers where this is the root.
  const away: ConnectionGateButton | null = navigation.canGoBack()
    ? { label: "Back", onPress: () => navigation.goBack() }
    : rows.length > 1
      ? { label: "Other computers", onPress: () => navigation.navigate("DeploymentSwitcher") }
      : null;
  const row = rows.find((candidate) => candidate.deploymentId === deploymentId);
  const top = { paddingTop: props.paddingTop ?? 0 };
  const iphone = useOptionalIphoneApps();
  const removedFrom = useRemovedFrom(iphone);
  // Every branch below explains this computer, so the pill would only repeat it.
  useShellGate(true);

  // Removed by its Host: nothing signs back in until the person sets it up again.
  if (iphone !== null && removedFrom?.deploymentId === deploymentId) {
    const copy = removedCopy(thisPhoneNoun, row?.name ?? removedFrom.deploymentName);
    return (
      <View style={[styles.removed, top]}>
        <RemovedView
          {...copy}
          onNotNow={resetToDeployments}
          onSetUpAgain={() =>
            act(() => iphone.clearRemoved().then(() => client.signIn(deploymentId)), "sign in")
          }
        />
      </View>
    );
  }

  if (row === undefined) {
    return (
      <Screen>
        {/* Centred while it fits; at a large text size it scrolls, from below the bar, so
            the title is never under the bar and the way back is never off the screen. */}
        <ScrollView
          contentContainerStyle={[styles.scrolling, column, top]}
          contentInsetAdjustmentBehavior="never"
        >
          {/* In a person's words, and back to the list by its own title. */}
          <DisplayTitle size="small">This Home is no longer here</DisplayTitle>
          <AppText role="secondary" tone="muted">
            {`It isn’t in this phone’s list any more. You can add it again from ${deploymentsTitle}.`}
          </AppText>
          <SecondaryButton label={deploymentsTitle} onPress={resetToDeployments} />
        </ScrollView>
      </Screen>
    );
  }

  // A route that names another computer than the open one: opening it is the
  // person's own choice, never the gate's.
  if (selection.deploymentId !== deploymentId) {
    return (
      <View style={[styles.gate, top]}>
        <ConnectionGate
          detail={refused ?? deploymentStatusDetail(row) ?? deploymentStatusLabel(row.status)}
          primary={{
            busy: working,
            label: `Open ${row.name}`,
            onPress: () => act(() => client.openDeployment(deploymentId)),
          }}
          secondary={away}
          stateKey="elsewhere"
          symbol="computer"
          title={row.name}
        />
      </View>
    );
  }

  // The address answers as a different deployment, or is too old for this
  // phone while a remote update may fix it: facts about the computer, with
  // their own ways on.
  if (row.status === "unverified" || row.verification === "host-too-old") {
    return (
      <Screen>
        {/* Scrolls at a large text size, as the gate above does: the ways on stay in reach. */}
        <ScrollView
          contentContainerStyle={[styles.scrolling, column, top]}
          contentInsetAdjustmentBehavior="never"
        >
          <DisplayTitle size="small">{row.name}</DisplayTitle>
          <AppText role="secondary" tone="muted">
            {refused ?? deploymentStatusDetail(row)}
          </AppText>
          {row.verification === "host-too-old" ? (
            <DeploymentUpdate deploymentId={row.deploymentId} name={row.name} />
          ) : null}
          <PrimaryButton
            busy={working}
            label="Try again"
            onPress={() => act(() => client.retrySelection())}
          />
          {away === null ? null : <SecondaryButton label={away.label} onPress={away.onPress} />}
        </ScrollView>
      </Screen>
    );
  }

  return (
    <View style={[styles.gate, top]}>
      <ConnectionRouteGate
        connection={selection.session?.connection ?? null}
        issue={
          row.signIn !== null
            ? {
                code: "sign-in",
                name: row.name,
                ...(row.sessionFailure === "account-required"
                  ? { reason: "account-required" }
                  : {}),
              }
            : row.verification === "client-too-old"
              ? { code: "update-app", name: row.name }
              : null
        }
        line={refused}
        name={row.name}
        secondary={away}
        unreachable={
          <GateAsleepLine deploymentId={deploymentId} macHome={isMacHomeRow(row)} name={row.name} />
        }
        signIn={{
          busy: working,
          label: deploymentRecoveryLabel(row),
          onPress: () => act(() => runDeploymentRecovery(client, navigation, row), "sign in"),
        }}
      />
    </View>
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
  scrolling: { flexGrow: 1, gap: space[8], justifyContent: "center", paddingVertical: space[16] },
  gate: { backgroundColor: color.background, flex: 1 },
  removed: { backgroundColor: color.background, flex: 1 },
});
