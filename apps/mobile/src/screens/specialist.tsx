import {
  sameStableHostSnapshot,
  unwrapRpcResult,
  type HostClient,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  findNodeHandle,
  type HostInstance,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { color, space } from "../theme.js";
import { TasksPane } from "../threads/tasks-pane.js";
import { AppText, Notice, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { SpecialistMarkPicker } from "../ui/mark-picker.js";
import { WorkspaceMark } from "../ui/workspace-mark.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export type SpecialistScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly workspaceId: string;
}>;

/**
 * What a Workspace that is not ready says about itself, or null when it is.
 * A storage problem the Host reported is said in the Host's own words.
 */
export function specialistStatus(workspace: WorkspaceSummary): string | null {
  switch (workspace.status) {
    case "ready":
      return workspace.storageIssue?.message ?? null;
    case "provisioning":
      return "Preparing its files";
    case "archiving":
    case "archived":
      return "Archived";
    case "unavailable":
      return workspace.storageIssue?.message ?? "Its files are unavailable right now";
    case "failed":
      return workspace.storageIssue?.message ?? "Its storage could not be set up";
    case "deleting":
    case "deleted":
      return "Being deleted";
  }
}

/**
 * One specialist: who it is, what it holds, and its own tasks, in the
 * sidebar's rows.
 *
 * Start a task opens a task inside this Workspace, with its files and access;
 * Back from that task returns here. The facts shown are the ones the Host
 * states — its description, and the computer holding its files when that
 * computer is named — and nothing else is implied.
 */
export function SpecialistScreen(props: SpecialistScreenProps): ReactNode {
  const { deploymentId, workspaceId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return (
    <SpecialistDetail
      deploymentId={deploymentId}
      hostClient={hostClient}
      key={`${deploymentId}:${workspaceId}`}
      workspaceId={workspaceId}
    />
  );
}

function SpecialistDetail(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly workspaceId: string;
}): ReactNode {
  const navigation = useNavigation();
  const [editingMark, setEditingMark] = useState(false);
  const markTrigger = useRef<HostInstance>(null);
  const [membershipRead, setMembershipRead] = useState(0);
  const [ownership, setOwnership] = useState<{
    readonly hostClient: HostClient;
    readonly userId: string;
    readonly owner: boolean;
  } | null>(null);
  const client = useMobileClient();
  const { snapshot } = useHostSnapshot(props.hostClient, sameStableHostSnapshot);
  const { deploymentId, hostClient, workspaceId } = props;
  const workspace = snapshot.workspaces.find(({ id }) => id === workspaceId) ?? null;
  const userId = snapshot.user?.id ?? null;
  const changeable =
    snapshot.taskMarksAvailable &&
    workspace?.kind === "specialized" &&
    workspace.status !== "deleting" &&
    workspace.status !== "deleted";
  useFocusEffect(
    useCallback(() => {
      if (!changeable || userId === null) return;
      let current = true;
      let read = 0;
      const reread = () => {
        const attempt = ++read;
        void hostClient.rpc["workspace.members.list"]({ workspaceId })
          .then(unwrapRpcResult)
          .then(({ members }) => {
            if (current && attempt === read) {
              setOwnership({
                hostClient,
                userId,
                owner: members.some(
                  (member) =>
                    member.userId === userId &&
                    member.role === "owner" &&
                    member.state === "active",
                ),
              });
            }
          })
          .catch(() => {
            if (current && attempt === read) setOwnership({ hostClient, userId, owner: false });
          });
      };
      reread();
      // Screen focus does not change when the app returns from the background.
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") reread();
      });
      return () => {
        current = false;
        subscription.remove();
      };
    }, [changeable, hostClient, membershipRead, userId, workspaceId]),
  );

  useLayoutEffect(() => {
    navigation.setOptions({ title: workspace?.name ?? "" });
  }, [navigation, workspace?.name]);

  const openTask = useCallback(
    (threadId: string) => navigation.navigate("Thread", { deploymentId, threadId }),
    [deploymentId, navigation],
  );
  const signIn = useCallback(() => client.signIn(deploymentId), [client, deploymentId]);

  if (workspace === null) {
    return (
      <Screen>
        <View style={styles.centred}>
          {snapshot.workspaces.length === 0 ? (
            <ActivityIndicator color={color.muted} />
          ) : (
            <>
              <Notice
                detail="It may have been deleted, or it belongs to another deployment."
                title="This specialist is not here"
                tone="neutral"
              />
              <SecondaryButton label="Back" onPress={() => navigation.goBack()} />
            </>
          )}
        </View>
      </Screen>
    );
  }

  const status = specialistStatus(workspace);

  const canEditMark =
    changeable &&
    ownership?.hostClient === hostClient &&
    ownership.userId === userId &&
    ownership.owner;
  return (
    <Screen edgeToEdge>
      {editingMark ? (
        <SpecialistMarkPicker
          hostClient={hostClient}
          workspace={workspace}
          editable={canEditMark}
          onClose={() => setEditingMark(false)}
          onDismiss={() => {
            const handle = findNodeHandle(markTrigger.current);
            if (typeof handle === "number") AccessibilityInfo.setAccessibilityFocus(handle);
          }}
          onRefused={() => setMembershipRead((count) => count + 1)}
        />
      ) : null}
      <TasksPane
        deploymentId={deploymentId}
        header={
          <View style={styles.hero}>
            <View style={styles.identity}>
              {canEditMark ? (
                <Pressable
                  ref={markTrigger}
                  accessibilityRole="button"
                  accessibilityLabel="Change specialist icon and colour"
                  onPress={() => setEditingMark(true)}
                  style={styles.markControl}
                >
                  <WorkspaceMark
                    icon={workspace.icon}
                    name={workspace.name}
                    color={workspace.color}
                  />
                </Pressable>
              ) : (
                <View ref={markTrigger} accessible accessibilityLabel={workspace.name}>
                  <WorkspaceMark
                    icon={workspace.icon}
                    name={workspace.name}
                    color={workspace.color}
                  />
                </View>
              )}

              <View style={styles.facts}>
                {workspace.description.trim() === "" ? null : (
                  <AppText role="secondary" tone="soft">
                    {workspace.description.trim()}
                  </AppText>
                )}
                {/* Named only when the Host names the computer: an unnamed one
                    is not the same thing as shared storage. */}
                {workspace.machineName === null ? null : (
                  <AppText role="caption" tone="muted">
                    {`Files on ${workspace.machineName}`}
                  </AppText>
                )}
                {status === null ? null : (
                  <AppText role="caption" style={styles.status}>
                    {status}
                  </AppText>
                )}
              </View>
            </View>
            {/* A task is written before it is made, so only a Workspace that
                cannot hold one stops it; the line above already says why. */}
            <PrimaryButton
              disabled={workspace.status !== "ready"}
              label="Start a task"
              onPress={() => navigation.navigate("NewTask", { deploymentId, workspaceId })}
            />
          </View>
        }
        hostClient={hostClient}
        onOpenTask={openTask}
        onSignIn={signIn}
        query=""
        workspaceId={workspaceId}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  markControl: {
    minWidth: Platform.OS === "android" ? 48 : 44,
    minHeight: Platform.OS === "android" ? 48 : 44,
    alignItems: "center",
    justifyContent: "center",
  },
  centred: { flex: 1, gap: space[12], justifyContent: "center" },
  // As tall as the mark at least, so a one-line description sits level with it.
  facts: { flex: 1, gap: space[4], justifyContent: "center", minHeight: 32 },
  hero: { gap: space[16], paddingBottom: space[8], paddingTop: space[4] },
  identity: { alignItems: "flex-start", flexDirection: "row", gap: space[12] },
  status: { color: color.amber },
});
