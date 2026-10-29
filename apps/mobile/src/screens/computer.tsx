import { canRespondToRequests, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import type { MachineSummary } from "@opensteer/protocol";
import {
  computerRole,
  computerRoleLabel,
  computerStatus,
  computerUses,
  computerUsesChosenElsewhere,
  computerUsesPhrase,
} from "@opensteer/client/computers";
import { computerUseView, isIphone, phoneUseView } from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { threadReturn } from "../navigation-state.js";
import { ComputerUseBlock, PhoneUseBlock } from "../computers/computer-use-block.js";
import { useComputerUseData } from "../computers/use-computer-use-data.js";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import { IphoneAppsBlock } from "../iphone-apps/iphone-apps-block.js";
import { opensteerOn } from "../iphone-apps/model.js";
import { RemoteIphoneAppsBlock } from "../iphone-apps/remote-iphone-apps-block.js";
import { color, space } from "../theme.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, SecondaryButton, StatusDot } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";

export type ComputerScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly machineId: string;
}>;

/**
 * One computer, from the phone: what it does for agents, whether it is there,
 * and its computer use when it is a Mac that has any, or an agent phone. An
 * iPhone shows its apps instead: this one's own, which are changed here, or
 * another's, which can only be narrowed from here.
 *
 * It is reached from Settings and from a Thread that is using the computer,
 * and it belongs to one Deployment the way a Thread does: when that Deployment
 * is not the open one, it says so and offers to open it rather than showing
 * another Host's computer.
 */
export function ComputerScreen(props: ComputerScreenProps): ReactNode {
  const { deploymentId, machineId } = props.route.params;
  const client = useMobileClient();
  const { rows, selection } = useMobileState();
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const row = rows.find((candidate) => candidate.deploymentId === deploymentId);
  const hostClient =
    selection.deploymentId === deploymentId && row?.signIn === null ? selection.hostClient : null;

  if (hostClient === null) {
    return (
      <Screen>
        <View style={styles.away}>
          <AppText role="secondary" tone="muted">
            {row === undefined
              ? "This deployment is no longer on this phone."
              : `Open ${row.name} to see this computer.`}
          </AppText>
          {failure === null ? null : <Notice detail={failure} title="That did not open" />}
          {row === undefined ? null : (
            <SecondaryButton
              busy={opening}
              label={`Open ${row.name}`}
              onPress={() => {
                setOpening(true);
                setFailure(null);
                void client
                  .openDeployment(deploymentId)
                  .catch((error: unknown) =>
                    setFailure(
                      operationDetail(error, "That deployment still could not be opened."),
                    ),
                  )
                  .finally(() => setOpening(false));
              }}
            />
          )}
        </View>
      </Screen>
    );
  }

  return (
    <ComputerDetail
      deploymentId={deploymentId}
      deploymentName={row?.name ?? "this deployment"}
      hostClient={hostClient}
      machineId={machineId}
    />
  );
}

function ComputerDetail(props: {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly hostClient: HostClient;
  readonly machineId: string;
}): ReactNode {
  const navigation = useNavigation();
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const machines = useHostSelector(props.hostClient, selectMachines);
  const revision = useHostSelector(props.hostClient, selectMachineRevision);
  const canRespond = useHostSelector(props.hostClient, canRespondToRequests);
  const machine = machines.find((candidate) => candidate.id === props.machineId) ?? null;
  const data = useComputerUseData(props.hostClient, revision);
  const iphoneApps = useIphoneApps();
  const enrollment = useIphoneAppsState(iphoneApps).snapshot.enrollment;
  // This iPhone is the one added to this Deployment as this computer; any
  // other iPhone is someone else's device seen from here.
  const thisIphone =
    machine !== null &&
    enrollment?.state === "enrolled" &&
    enrollment.runnerId === machine.id &&
    enrollment.deploymentId === props.deploymentId;
  const view = useMemo(
    () =>
      machine === null || data.data === null
        ? null
        : computerUseView({ ...data.data, hostConnected: canRespond, machine }),
    [canRespond, data.data, machine],
  );
  const phone = useMemo(
    () =>
      machine === null || data.data === null
        ? null
        : phoneUseView({ ...data.data, hostConnected: canRespond, machine }),
    [canRespond, data.data, machine],
  );

  useLayoutEffect(() => {
    if (machine !== null) navigation.setOptions({ title: machine.name });
  }, [machine, navigation]);

  const openThread = useCallback(
    (threadId: string) => {
      const destination = { deploymentId: props.deploymentId, threadId };
      // Chat is the root under every sheet, and only ever shown there.
      if (props.hostClient.getSnapshot().homeThreadId === threadId) {
        navigation.dispatch(StackActions.popTo("Home", { deploymentId: props.deploymentId }));
        return;
      }
      const routes = navigation.getState()?.routes ?? [];
      if (threadReturn(routes, destination) === "pop-to") {
        navigation.dispatch(StackActions.popTo("Thread", destination));
        return;
      }
      // Back to the screen the sheets were opened over, then forward to the
      // task: its Back returns there, and no Thread is pushed over a sheet.
      const beneath = routes.findLastIndex(({ name }) => screenRoutes.has(name));
      const above = routes.length - 1 - Math.max(beneath, 0);
      if (above > 0) navigation.dispatch(StackActions.pop(above));
      navigation.dispatch(StackActions.push("Thread", destination));
    },
    [navigation, props.deploymentId, props.hostClient],
  );

  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
      >
        {machine === null ? null : (
          <ComputerSummary apps={data.data} machine={machine} status={!thisIphone} />
        )}
        {machine === null ? (
          <AppText role="secondary" tone="muted">
            This computer is no longer part of this Opensteer.
          </AppText>
        ) : thisIphone ? (
          <IphoneAppsBlock
            canRespond={canRespond}
            controller={iphoneApps}
            data={data.data}
            hostClient={props.hostClient}
            machine={machine}
            onChanged={data.reload}
            onRemoved={() => navigation.goBack()}
            opensteer={opensteerOn(props.deploymentName)}
          />
        ) : isIphone(machine) ? (
          <RemoteIphoneAppsBlock
            canRespond={canRespond}
            data={data.data}
            hostClient={props.hostClient}
            machine={machine}
            onChanged={data.reload}
          />
        ) : phone !== null ? (
          <PhoneUseBlock
            canRespond={canRespond}
            hostClient={props.hostClient}
            machine={machine}
            onChanged={data.reload}
            onOpenThread={openThread}
            view={phone}
          />
        ) : view !== null ? (
          <ComputerUseBlock
            canRespond={canRespond}
            hostClient={props.hostClient}
            machine={machine}
            onChanged={data.reload}
            onOpenThread={openThread}
            view={view}
          />
        ) : data.error !== null ? (
          <Notice
            action={{
              label: "Try again",
              onPress: () => void data.reload().catch(() => undefined),
            }}
            detail={data.error}
            title="Computer use could not be loaded"
          />
        ) : data.data === null ? (
          <View accessibilityLabel="Loading computer use" style={styles.loading}>
            <ActivityIndicator color={color.muted} />
          </View>
        ) : (
          <AppText role="secondary" tone="muted">
            {computerUsesChosenElsewhere(machine)}
          </AppText>
        )}
      </ScrollView>
    </Screen>
  );
}

/** The computer in the Computers page's own words: its role, what it lends, and its state. */
function ComputerSummary(props: {
  readonly apps: Parameters<typeof computerUses>[1];
  readonly machine: MachineSummary;
  /** False for this iPhone, whose own block says whether it is sharing right now. */
  readonly status: boolean;
}): ReactNode {
  const uses = computerUses(props.machine, props.apps);
  const role = computerRole(props.machine, uses, props.apps !== null);
  const status = computerStatus(props.machine);
  return (
    <View style={styles.summary}>
      {props.status ? (
        <View style={styles.status}>
          <StatusDot
            tone={
              status.tone === "online" ? "green" : status.tone === "waiting" ? "amber" : "muted"
            }
          />
          <AppText role="secondary" tone="soft">
            {status.label}
          </AppText>
        </View>
      ) : null}
      {role ? <AppText role="bodyMedium">{computerRoleLabel[role]}</AppText> : null}
      {uses.length > 0 ? (
        <AppText
          role="secondary"
          tone="muted"
        >{`Agents can use ${computerUsesPhrase(uses)}.`}</AppText>
      ) : null}
    </View>
  );
}

/** The full screens of a Deployment's stack, as opposed to the sheets over them. */
const screenRoutes: ReadonlySet<string> = new Set([
  "Home",
  "NewTask",
  "Specialist",
  "Specialists",
  "Tabs",
  "TaskSearch",
  "Thread",
  "WorkspaceBrowser",
]);

const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;
const selectMachineRevision = (snapshot: HostSnapshot) => snapshot.machineRevision;

const styles = StyleSheet.create({
  away: { gap: space[12], paddingTop: space[24] },
  status: { alignItems: "center", flexDirection: "row", gap: space[8] },
  summary: { gap: space[6] },
  content: { gap: space[20], paddingTop: space[16] },
  loading: { alignItems: "center", paddingVertical: space[40] },
});
